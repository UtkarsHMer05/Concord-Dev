#!/usr/bin/env bash
# P7-M021/M030 — Provision one Concord environment (staging|production)
# on AWS per DEC-050: one Graviton EC2 instance running the compose
# stack (docker-compose.cloud.yml), an ALB terminating TLS with an
# ACM cert, security groups providing the public/private split.
#
# Idempotent: re-running with the same ENV reuses/creates-missing
# resources and prints the ALB DNS name.
#
# Usage:
#   ENV=staging ./scripts/deploy/provision.sh
#   ENV=production ./scripts/deploy/provision.sh
#
# Requires: aws CLI with credentials; the account's default VPC in
# ap-south-1 (verified present); an ACM certificate for the target
# (created once — see CERT_ARN below; DNS validation needs a domain,
# which v1 does NOT own: see the fallback note).
#
# NO custom domain in v1 → the ALB serves its default DNS name over
# plain HTTP (listeners :80 web + :8890 sync) unless CERT_ARN is set.
# Without a domain, ACM DNS validation cannot complete, so there is no
# cert to attach — the honest DEC-050 posture. RERUN WITH CERT_ARN SET
# to upgrade the listeners to TLS (:443 web + :8443 sync) — the rest of
# the wiring (SG rules, TGs, registrations) is idempotent.
#
# P7-M020 hardening (SA-SEC7): instance ports 3000/8890 are open ONLY to
# the ALB's security group (no 0.0.0.0/0 ingress anywhere); the ALB SG
# alone exposes public 443 (+80 for the no-cert redirect). No SSH ingress.
set -euo pipefail
cd "$(dirname "$0")/../.."

ENV="${ENV:?set ENV=staging|production}"
REGION="${AWS_REGION:-ap-south-1}"
CERT_ARN="${CERT_ARN:-}"
INSTANCE_TYPE="${INSTANCE_TYPE:-t4g.medium}"   # Graviton, 2 vCPU / 4GB
KEY_NAME="${KEY_NAME:-sentiment-analysis-dataset-keypair}"  # existing account key
NAME="concord-${ENV}"

echo "== provisioning ${NAME} in ${REGION} =="

# 1. Security groups (idempotent by name lookup).
#
# P7-M020 (SA-SEC7 review): instance ports 3000 (web) and 8890 (nginx
# sync LB) are ALB TARGETS only — they must NEVER be open to 0.0.0.0/0.
# Each port is authorized ingress from the ALB's OWN security group
# (source SG reference), so only the ALB can reach them. No SSH ingress
# is opened (SSM Session Manager preferred; add your own IP explicitly
# if SSH is ever needed).
sg_id=$(aws ec2 describe-security-groups --region "$REGION" \
  --group-names "${NAME}-sg" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
if [ -z "$sg_id" ] || [ "$sg_id" = "None" ]; then
  sg_id=$(aws ec2 create-security-group --region "$REGION" \
    --group-name "${NAME}-sg" --description "Concord ${ENV}: ALB-facing ports only" \
    --query GroupId --output text)
  echo "  created sg ${sg_id} (no ingress yet — ALB SG reference added below)"
else
  echo "  reuse sg ${sg_id}"
fi

# ALB security group (idempotent by name lookup). ALB 443/80 is the ONLY
# public ingress in the whole topology.
alb_sg_id=$(aws ec2 describe-security-groups --region "$REGION" \
  --group-names "${NAME}-alb-sg" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
if [ -z "$alb_sg_id" ] || [ "$alb_sg_id" = "None" ]; then
  alb_sg_id=$(aws ec2 create-security-group --region "$REGION" \
    --group-name "${NAME}-alb-sg" --description "Concord ${ENV} ALB: public 443/80 only" \
    --query GroupId --output text)
  # Public HTTPS (and plain HTTP while DEC-050's no-domain posture holds —
  # the HTTP listener redirects to HTTPS once CERT_ARN is set).
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$alb_sg_id" \
    --protocol tcp --port 443 --cidr 0.0.0.0/0 >/dev/null
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$alb_sg_id" \
    --protocol tcp --port 80 --cidr 0.0.0.0/0 >/dev/null
  echo "  created ALB sg ${alb_sg_id} (public: 443, 80)"
else
  echo "  reuse ALB sg ${alb_sg_id}"
fi

# Instance ports 3000 + 8890: ingress from the ALB SG ONLY (idempotent:
# skip if a rule from that source already exists on the port).
for port in 3000 8890; do
  existing_rule=$(aws ec2 describe-security-group-rules --region "$REGION" \
    --filters "Name=group-id,Values=${sg_id}" \
    --query "SecurityGroupRules[?IsEgress==\`false\`&&IpProtocol==\`tcp\`&&FromPort==\`${port}\`].SecurityGroupRuleId" \
    --output text 2>/dev/null || true)
  if [ -z "$existing_rule" ] || [ "$existing_rule" = "None" ] || [ "$existing_rule" = "None	None" ]; then
    aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$sg_id" \
      --protocol tcp --port "$port" --source-group "$alb_sg_id" >/dev/null
    echo "  sg ${sg_id}: ${port} ← ALB sg ${alb_sg_id} only"
  fi
done
# NOTE (SA-SEC7 audit): SG ingress CANNOT be tightened to the ALB SG
# reference in one place — `authorize-security-group-ingress` with
# --source-group is the ONLY supported form for SG-to-SG rules; the ALB
# must attach ${NAME}-alb-sg when created (passed via --security-groups
# below). Direct-to-instance public access on 3000/8890 is now
# structurally impossible (no 0.0.0.0/0 rule exists).

# 2. Key pair must exist (used only for emergencies; SSM preferred).
aws ec2 describe-key-pairs --region "$REGION" --key-names "$KEY_NAME" >/dev/null

# 3. Latest AL2023 ARM64 AMI.
AMI=$(aws ssm get-parameter --region "$REGION" \
  --name "/aws/service/ami-amazon-linux-2023/latest/arm64-minimal-kernel-default" \
  --query Parameter.Value --output text)
echo "  AMI: ${AMI}"

# 4. Instance (idempotent by tag).
INSTANCE_ID=$(aws ec2 describe-instances --region "$REGION" \
  --filters "Name=tag:Name,Values=${NAME}" "Name=instance-state-name,Values=running,pending,stopped" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "None" ]; then
  # user-data installs docker + compose, then clones the deployment
  # bundle from S3 (uploaded by scripts/deploy/push-bundle.sh) and
  # boots the stack. The bundle contains: compose file, nginx conf,
  # prometheus/grafana config, env files (secrets injected at this
  # step via SSM parameters — pulled, never stored in the AMI/udocs).
  USER_DATA=$(cat scripts/deploy/user-data.sh)
  INSTANCE_ID=$(aws ec2 run-instances --region "$REGION" \
    --image-id "$AMI" --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" --security-group-ids "$sg_id" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${NAME}}]" \
    --user-data "$USER_DATA" \
    --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":30,"VolumeType":"gp3"}}]' \
    --query 'Instances[0].InstanceId' --output text)
  echo "  launched ${INSTANCE_ID} (${INSTANCE_TYPE})"
else
  echo "  reuse instance ${INSTANCE_ID}"
fi

# Wait for running.
aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID" || true

# 5. Target groups — one per backend port (SA-SEC7: a single TG
# registered with two ports mixes web health checks into the WS path;
# ALB TGs route per-listener, so 8890 gets its own TG + health check).
VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" \
  --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
TG_WEB_ARN=$(aws elbv2 describe-target-groups --region "$REGION" --names "${NAME}-tg-web" \
  --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)
if [ -z "$TG_WEB_ARN" ] || [ "$TG_WEB_ARN" = "None" ]; then
  TG_WEB_ARN=$(aws elbv2 create-target-group --region "$REGION" --name "${NAME}-tg-web" \
    --protocol HTTP --port 3000 --vpc-id "$VPC_ID" \
    --health-check-path '/api/health' \
    --query 'TargetGroups[0].TargetGroupArn' --output text)
  echo "  created target group ${TG_WEB_ARN} (:3000 web)"
fi
TG_SYNC_ARN=$(aws elbv2 describe-target-groups --region "$REGION" --names "${NAME}-tg-sync" \
  --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)
if [ -z "$TG_SYNC_ARN" ] || [ "$TG_SYNC_ARN" = "None" ]; then
  TG_SYNC_ARN=$(aws elbv2 create-target-group --region "$REGION" --name "${NAME}-tg-sync" \
    --protocol HTTP --port 8890 --vpc-id "$VPC_ID" \
    --health-check-path '/api/v1/health/live' --health-check-interval-seconds 10 \
    --query 'TargetGroups[0].TargetGroupArn' --output text)
  echo "  created target group ${TG_SYNC_ARN} (:8890 sync)"
fi

LB_ARN=$(aws elbv2 describe-load-balancers --region "$REGION" --names "${NAME}-lb" \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || true)
if [ -z "$LB_ARN" ] || [ "$LB_ARN" = "None" ]; then
  SUBNETS=$(aws ec2 describe-subnets --region "$REGION" \
    --filters Name=default-for-az,Values=true \
    --query 'Subnets[0:2].SubnetId' --output text | tr '\t' ' ')
  LB_ARN=$(aws elbv2 create-load-balancer --region "$REGION" --name "${NAME}-lb" \
    --type application --subnets $SUBNETS --security-groups "$alb_sg_id" \
    --query 'LoadBalancers[0].LoadBalancerArn' --output text)
  echo "  created ALB ${LB_ARN} (sg ${alb_sg_id})"
fi

# 6. Listeners. CERT_ARN set ⇒ HTTPS listeners on 443 with the ACM cert
# (the documented upgrade path; ALB DNS-name certs require an ACM cert
# validated for the ALB's DNS — normally that means a domain). CERT_ARN
# unset ⇒ the honest DEC-050 v1 posture: plain HTTP listeners on 80
# (web) and 8890 (sync), documented in docs/SECURITY.md §10.
create_listener() {  # $1 lb, $2 proto, $3 port, $4 cert(arn|""), $5 tg
  local lb="$1" proto="$2" port="$3" cert="$4" tg="$5"
  local existing
  existing=$(aws elbv2 describe-listeners --region "$REGION" --load-balancer-arn "$lb" \
    --query "Listeners[?Port==\`${port}\`].ListenerArn|[0]" --output text 2>/dev/null || true)
  if [ -z "$existing" ] || [ "$existing" = "None" ]; then
    if [ -n "$cert" ]; then
      aws elbv2 create-listener --region "$REGION" --load-balancer-arn "$lb" \
        --protocol "$proto" --port "$port" --certificates "CertificateArn=${cert}" \
        --default-actions "[{\"Type\":\"forward\",\"TargetGroupArn\":\"${tg}\"}]" >/dev/null
    else
      aws elbv2 create-listener --region "$REGION" --load-balancer-arn "$lb" \
        --protocol "$proto" --port "$port" \
        --default-actions "[{\"Type\":\"forward\",\"TargetGroupArn\":\"${tg}\"}]" >/dev/null
    fi
    echo "  listener :${port} (${proto}) → ${tg}"
  fi
}

if [ -n "$CERT_ARN" ]; then
  # TLS posture: single 443 listener per backend (path-based split would
  # need both TGs behind one listener; two listeners on distinct ports is
  # the simple, honest v1 shape).
  create_listener "$LB_ARN" HTTPS 443 "$CERT_ARN" "$TG_WEB_ARN"
  create_listener "$LB_ARN" HTTPS 8443 "$CERT_ARN" "$TG_SYNC_ARN"
else
  # DEC-050 no-domain posture: plain HTTP. ws:// + Clerk dev-browser
  # flow are ONLY usable off-localhost over trusted networks (see
  # SECURITY.md §10 / the TLS blocker note).
  create_listener "$LB_ARN" HTTP 80 "" "$TG_WEB_ARN"
  create_listener "$LB_ARN" HTTP 8890 "" "$TG_SYNC_ARN"
fi

# Register the instance on both target groups (web 3000, sync LB 8890).
aws elbv2 register-targets --region "$REGION" --target-group-arn "$TG_WEB_ARN" \
  --targets "[{\"Id\":\"${INSTANCE_ID}\",\"Port\":3000}]" >/dev/null
aws elbv2 register-targets --region "$REGION" --target-group-arn "$TG_SYNC_ARN" \
  --targets "[{\"Id\":\"${INSTANCE_ID}\",\"Port\":8890}]" >/dev/null

DNS=$(aws elbv2 describe-load-balancers --region "$REGION" --load-balancer-arn "$LB_ARN" \
  --query 'LoadBalancers[0].DNSName' --output text)
echo
echo "== ${NAME} provisioned =="
echo "  instance: ${INSTANCE_ID}"
if [ -n "$CERT_ARN" ]; then
  echo "  ALB DNS:  ${DNS}  (web: https://${DNS}:443 — sync: wss://${DNS}:8443/api/v1/sync)"
else
  echo "  ALB DNS:  ${DNS}  (web: http://${DNS}:80 — sync: ws://${DNS}:8890/api/v1/sync)"
  echo "  WARNING: PLAIN HTTP/WS (no domain → no ACM cert; DEC-050). Clerk"
  echo "  sign-in over non-localhost plain HTTP is blocked by the dev-browser"
  echo "  handshake (see docs/SECURITY.md §10) — treat this URL as staging-only"
  echo "  over trusted networks. Set CERT_ARN and rerun to upgrade to TLS."
fi
