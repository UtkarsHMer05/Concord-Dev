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
# HTTPS with a self-managed ACM cert ONLY if a validated cert exists.
# Without a domain, ACM DNS validation cannot complete, so v1 deploys
# the ALB with a LISTENER ON :80 (HTTP) → the web app, while WSS goes
# through the SAME listener — and the gateway URL env points at ws://.
# IF a cert becomes available, rerun with CERT_ARN set to upgrade the
# listener to 443 + TLS (the compose/nginx configs already forward
# X-Forwarded-Proto). This is the documented honest v1 posture; see
# DEC-050 constraints.
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
sg_id=$(aws ec2 describe-security-groups --region "$REGION" \
  --group-names "${NAME}-sg" --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)
if [ -z "$sg_id" ] || [ "$sg_id" = "None" ]; then
  sg_id=$(aws ec2 create-security-group --region "$REGION" \
    --group-name "${NAME}-sg" --description "Concord ${ENV}: ALB-facing ports only" \
    --query GroupId --output text)
  # ALB health checks + traffic on web (3000) and sync LB (8890) only.
  for port in 3000 8890; do
    aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$sg_id" \
      --protocol tcp --port "$port" --cidr 0.0.0.0/0 >/dev/null
  done
  # SSH from anywhere is NOT opened by default; the operator uses SSM or
  # their own IP. Documented: add your IP explicitly if SSH is needed.
  echo "  created sg ${sg_id} (public: 3000, 8890 only)"
else
  echo "  reuse sg ${sg_id}"
fi

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

# 5. ALB + target group (idempotent by name).
TG_ARN=$(aws elbv2 describe-target-groups --region "$REGION" --names "${NAME}-tg" \
  --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null || true)
if [ -z "$TG_ARN" ] || [ "$TG_ARN" = "None" ]; then
  TG_ARN=$(aws elbv2 create-target-group --region "$REGION" --name "${NAME}-tg" \
    --protocol HTTP --port 3000 --vpc-id "$(aws ec2 describe-vpcs --region "$REGION" \
      --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)" \
    --health-check-path '/api/health' \
    --query 'TargetGroups[0].TargetGroupArn' --output text)
  echo "  created target group ${TG_ARN}"
fi

# Two listeners: :3000 web + :8890 sync (WSS upgrade at ALB).
for SPEC in "3000:web" "8890:sync"; do
  PORT="${SPEC%%:*}"; KIND="${SPEC##*:}"
  LISTENER_ARN=$(aws elbv2 describe-listeners --region "$REGION" \
    --load-balancer-arn "$LB_ARN" 2>/dev/null \
    --query "Listeners[?Port==\`${PORT}\`].ListenerArn|[0]" --output text 2>/dev/null || true)
done

LB_ARN=$(aws elbv2 describe-load-balancers --region "$REGION" --names "${NAME}-lb" \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null || true)
if [ -z "$LB_ARN" ] || [ "$LB_ARN" = "None" ]; then
  SUBNETS=$(aws ec2 describe-subnets --region "$REGION" \
    --filters Name=default-for-az,Values=true \
    --query 'Subnets[0:2].SubnetId' --output text | tr '\t' ' ')
  LB_ARN=$(aws elbv2 create-load-balancer --region "$REGION" --name "${NAME}-lb" \
    --type application --subnets $SUBNETS \
    --query 'LoadBalancers[0].LoadBalancerArn' --output text)
  echo "  created ALB ${LB_ARN}"
fi

# Listeners (HTTP :3000→web, :8890→sync; TLS upgrade documented above).
for SPEC in "3000:3000" "8890:8890"; do
  PORT="${SPEC%%:*}"; TPORT="${SPEC##*:}"
  EXISTING=$(aws elbv2 describe-listeners --region "$REGION" --load-balancer-arn "$LB_ARN" \
    --query "Listeners[?Port==\`${PORT}\`].ListenerArn|[0]" --output text)
  if [ -z "$EXISTING" ] || [ "$EXISTING" = "None" ]; then
    aws elbv2 create-listener --region "$REGION" --load-balancer-arn "$LB_ARN" \
      --protocol HTTP --port "$PORT" \
      --default-actions "Type=forward,TargetGroupArn=${TG_ARN}" >/dev/null 2>&1 || \
    aws elbv2 create-listener --region "$REGION" --load-balancer-arn "$LB_ARN" \
      --protocol HTTP --port "$PORT" \
      --default-actions "[{\"Type\":\"forward\",\"TargetGroupArn\":\"${TG_ARN}\"}]" >/dev/null
    echo "  listener :${PORT} → tg"
  fi
done

# Register the instance on both ports (same TG, instance port implied
# by listener:register the instance twice via port in overrides).
aws elbv2 register-targets --region "$REGION" --target-group-arn "$TG_ARN" \
  --targets "Id=${INSTANCE_ID},Port=3000" "Id=${INSTANCE_ID},Port=8890" >/dev/null 2>&1 || \
aws elbv2 register-targets --region "$REGION" --target-group-arn "$TG_ARN" \
  --targets "[{\"Id\":\"${INSTANCE_ID}\",\"Port\":3000},{\"Id\":\"${INSTANCE_ID}\",\"Port\":8890}]" >/dev/null

DNS=$(aws elbv2 describe-load-balancers --region "$REGION" --load-balancer-arn "$LB_ARN" \
  --query 'LoadBalancers[0].DNSName' --output text)
echo
echo "== ${NAME} provisioned =="
echo "  instance: ${INSTANCE_ID}"
echo "  ALB DNS:  ${DNS}  (web: http://${DNS}:3000 — sync: ws://${DNS}:8890/api/v1/sync)"
echo "  NOTE: no ACM cert without a domain (DEC-050). Set CERT_ARN and"
echo "  rerun to upgrade listeners to 443/TLS when a validated cert exists."
