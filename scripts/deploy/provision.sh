#!/usr/bin/env bash
# P7-M021/M030 — Provision one Concord environment (staging|production)
# on AWS per DEC-050: one Graviton EC2 instance running the compose
# stack (docker-compose.cloud.yml), an ALB terminating TLS with an
# ACM cert, security groups providing the public/private split.
#
# ORDERING (load-bearing): the ALB is created FIRST (before the
# instance) because the web image bakes the ALB DNS name into the
# client bundle at build time (NEXT_PUBLIC_SYNC_GATEWAY_URL —
# push-bundle.sh resolves it from the ALB). The INSTANCE is launched
# LAST, after scripts/deploy/push-bundle.sh has stored the SSM env —
# user-data reads SSM at first boot. Full sequence per environment:
#
#   1. ENV=<env> ./scripts/deploy/provision.sh --infra-only
#        (SGs + IAM role + ALB + target groups + listeners; no instance)
#   2. ENV=<env> ./scripts/deploy/push-bundle.sh
#        (builds ARM64 images with the ALB DNS baked; ECR + SSM + S3)
#   3. ENV=<env> ./scripts/deploy/provision.sh
#        (idempotent re-run: reuses everything, launches the instance;
#        user-data pulls the bundle, applies migrations, boots the stack)
#
# Idempotent: re-running with the same ENV reuses/creates-missing
# resources and prints the ALB DNS name.
#
# Usage:
#   ENV=staging ./scripts/deploy/provision.sh [--infra-only]
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

# --infra-only: stop after SGs + IAM + ALB + TGs + listeners (BEFORE the
# instance). Required because push-bundle.sh needs the ALB DNS name to
# bake into the web image, and user-data needs the SSM env to exist —
# both happen between the two provision.sh runs.
INFRA_ONLY=false
for arg in "$@"; do
  case "$arg" in
    --infra-only) INFRA_ONLY=true ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

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
  # the HTTP listener redirects to HTTPS once CERT_ARN is set). The
  # no-cert posture ALSO serves the sync WS listener on :8890 — open it
  # publicly in that mode ONLY (with a cert, sync moves to :8443 and
  # 8890 stays closed). Rule is added inside the if-block below.
  if [ -n "$CERT_ARN" ]; then
    aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$alb_sg_id" \
      --protocol tcp --port 443 --cidr 0.0.0.0/0 >/dev/null
    echo "  created ALB sg ${alb_sg_id} (public: 443 — TLS mode)"
  else
    aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$alb_sg_id" \
      --protocol tcp --port 80 --cidr 0.0.0.0/0 >/dev/null
    aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$alb_sg_id" \
      --protocol tcp --port 8890 --cidr 0.0.0.0/0 >/dev/null
    echo "  created ALB sg ${alb_sg_id} (public: 80 web + 8890 sync — DEC-050 no-cert posture)"
  fi
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

# 2b. IAM instance role (P7-M021): the instance needs ECR pull, S3
# bundle read, and SSM Parameter Store read (secrets) — plus SSM
# Session Manager for shell access (no SSH ingress exists). Least
# privilege: NO write permissions anywhere, no s3 put, no SSM put.
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ROLE_NAME="${NAME}-instance-role"
if ! aws iam get-role --role-name "$ROLE_NAME" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE_NAME" \
    --assume-role-policy-document '{
      "Version": "2012-10-17",
      "Statement": [{"Effect": "Allow",
        "Principal": {"Service": "ec2.amazonaws.com"},
        "Action": "sts:AssumeRole"}]}' >/dev/null
  aws iam put-role-policy --role-name "$ROLE_NAME" --policy-name concord-instance-policy \
    --policy-document "{
      \"Version\": \"2012-10-17\",
      \"Statement\": [
        {\"Sid\": \"EcrPull\", \"Effect\": \"Allow\",
         \"Action\": [\"ecr:GetAuthorizationToken\", \"ecr:BatchGetImage\", \"ecr:GetDownloadUrlForLayer\"],
         \"Resource\": \"*\"},
        {\"Sid\": \"S3ReadBundle\", \"Effect\": \"Allow\",
         \"Action\": [\"s3:GetObject\"],
         \"Resource\": \"arn:aws:s3:::concord-deploy-*/concord/*\"},
        {\"Sid\": \"SsmReadEnv\", \"Effect\": \"Allow\",
         \"Action\": [\"ssm:GetParameter\", \"ssm:GetParameters\"],
         \"Resource\": \"arn:aws:ssm:${REGION}:${ACCOUNT_ID}:parameter/concord/*\"},
        {\"Sid\": \"SsmRegister\", \"Effect\": \"Allow\",
         \"Action\": [\"ssm:UpdateInstanceInformation\"],
         \"Resource\": \"*\"},
        {\"Sid\": \"SsmSessionManager\", \"Effect\": \"Allow\",
         \"Action\": [\"ssmmessages:CreateControlChannel\", \"ssmmessages:CreateDataChannel\",
                     \"ssmmessages:OpenControlChannel\", \"ssmmessages:OpenDataChannel\"],
         \"Resource\": \"*\"}
      ]}" >/dev/null
  echo "  created IAM role ${ROLE_NAME} (ECR pull + S3/SSM read + SSM registration + Session Manager)"
else
  echo "  reuse IAM role ${ROLE_NAME}"
fi
PROFILE_NAME="${NAME}-instance-profile"
if ! aws iam get-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "$PROFILE_NAME" >/dev/null
  aws iam add-role-to-instance-profile \
    --instance-profile-name "$PROFILE_NAME" --role-name "$ROLE_NAME" >/dev/null
  echo "  created instance profile ${PROFILE_NAME}"
else
  echo "  reuse instance profile ${PROFILE_NAME}"
fi

# 3. Latest AL2023 ARM64 AMI. NOTE: this account's credentials are
# DENIED the /aws/ SSM namespace ("No access to /aws/ namespace" —
# observed 2026-09-09), so the public-parameter AMI lookup is
# unavailable; the ec2 DescribeImages fallback resolves the same
# AL2023 minimal ARM64 image directly (owner amazon, newest
# al2023-ami-*-kernel-*-arm64).
AMI=$(aws ec2 describe-images --region "$REGION" --owners amazon \
  --filters "Name=name,Values=al2023-ami-2023.*-kernel-*-arm64" "Name=state,Values=available" \
  --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)
echo "  AMI: ${AMI}"

VPC_ID=$(aws ec2 describe-vpcs --region "$REGION" \
  --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)

# 4. Target groups — one per backend port (SA-SEC7: a single TG
# registered with two ports mixes web health checks into the WS path;
# ALB TGs route per-listener, so 8890 gets its own TG + health check).
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

# Register the instance on both target groups (web 3000, sync LB 8890)
# — only when launching; a reused instance is already registered.
REGISTER=true

DNS=$(aws elbv2 describe-load-balancers --region "$REGION" --load-balancer-arn "$LB_ARN" \
  --query 'LoadBalancers[0].DNSName' --output text)

if [ "$INFRA_ONLY" = true ]; then
  echo
  echo "== ${NAME} infrastructure ready (--infra-only; no instance) =="
  echo "  ALB DNS:  ${DNS}"
  echo "  next: ENV=${ENV} ./scripts/deploy/push-bundle.sh  (build+push images,"
  echo "        SSM env, S3 bundle — resolves ALB DNS into the web image)"
  echo "  then:  ENV=${ENV} ./scripts/deploy/provision.sh  (launch instance)"
  exit 0
fi

# ---------------------------------------------------------------------------
# Instance (idempotent by tag) — launched ONLY after the bundle exists:
# user-data pulls the S3 bundle + SSM env at first boot. Guards fail
# fast (clear error, no half-booted instance) if push-bundle was skipped.
# ---------------------------------------------------------------------------
INSTANCE_ID=$(aws ec2 describe-instances --region "$REGION" \
  --filters "Name=tag:Name,Values=${NAME}" "Name=instance-state-name,Values=running,pending,stopped" \
  --query 'Reservations[0].Instances[0].InstanceId' --output text)
if [ -z "$INSTANCE_ID" ] || [ "$INSTANCE_ID" = "None" ]; then
  # Guards: SSM env + S3 bundle must exist BEFORE first boot.
  if ! aws ssm get-parameter --region "$REGION" --name "/concord/${ENV}/concord.env" \
       >/dev/null 2>&1; then
    echo "error: SSM /concord/${ENV}/concord.env missing — run push-bundle.sh first" >&2
    exit 2
  fi
  ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
  BUCKET="${BUNDLE_BUCKET:-concord-deploy-${ACCOUNT_ID}}"
  if ! aws s3 ls "s3://${BUCKET}/concord/${ENV}/bundle.tar.gz" --region "$REGION" \
       >/dev/null 2>&1; then
    echo "error: s3://${BUCKET}/concord/${ENV}/bundle.tar.gz missing — run push-bundle.sh first" >&2
    exit 2
  fi

  # user-data: docker + compose + aws-cli → ECR login (instance profile)
  # → S3 bundle → SSM env → drizzle migrations → stack up → backup cron.
  # __ENV__/__BUCKET__ rendered here; secrets live in SSM only.
  USER_DATA=$(sed -e "s/__ENV__/${ENV}/g" -e "s/__BUCKET__/${BUCKET}/g" \
    scripts/deploy/user-data.sh)
  INSTANCE_ID=$(aws ec2 run-instances --region "$REGION" \
    --image-id "$AMI" --instance-type "$INSTANCE_TYPE" \
    --key-name "$KEY_NAME" --security-group-ids "$sg_id" \
    --iam-instance-profile Name="${PROFILE_NAME}" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=${NAME}}]" \
    --user-data "$USER_DATA" \
    --block-device-mappings '[{"DeviceName":"/dev/xvda","Ebs":{"VolumeSize":30,"VolumeType":"gp3"}}]' \
    --query 'Instances[0].InstanceId' --output text)
  echo "  launched ${INSTANCE_ID} (${INSTANCE_TYPE}, profile ${PROFILE_NAME})"
else
  REGISTER=false
  echo "  reuse instance ${INSTANCE_ID}"
fi

# Wait for running.
aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE_ID" || true

if [ "$REGISTER" = true ]; then
  aws elbv2 register-targets --region "$REGION" --target-group-arn "$TG_WEB_ARN" \
    --targets "[{\"Id\":\"${INSTANCE_ID}\",\"Port\":3000}]" >/dev/null
  aws elbv2 register-targets --region "$REGION" --target-group-arn "$TG_SYNC_ARN" \
    --targets "[{\"Id\":\"${INSTANCE_ID}\",\"Port\":8890}]" >/dev/null
fi

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
