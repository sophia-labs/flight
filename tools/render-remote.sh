#!/usr/bin/env bash
# Offload a Blender render to an EC2 render box.
# Usage: tools/render-remote.sh [timeline.json] [output.mp4]
set -euo pipefail

TIMELINE="${1:-clips/test-render/timeline.json}"
OUTPUT="${2:-clips/remote-render.mp4}"
RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
PAYLOAD="clips/render-payload-${RUN_ID}.tar.gz"
TFVARS="terraform/render-${RUN_ID}.tfvars"

AWS_PROFILE="${AWS_PROFILE:-terraform-user}"
AWS_REGION="${AWS_REGION:-us-east-1}"
INSTANCE_TYPE="${INSTANCE_TYPE:-g5.xlarge}"
KEY_NAME="${KEY_NAME-flight-render-vera}"
SSH_CIDR="${SSH_CIDR-}"
SPOT_PRICE="${SPOT_PRICE:-}"
RENDER_TIMEOUT_SECONDS="${RENDER_TIMEOUT_SECONDS:-7200}"
RENDER_SAMPLES="${RENDER_SAMPLES:-48}"
ROOT_VOLUME_SIZE_GB="${ROOT_VOLUME_SIZE_GB:-100}"
AMI_ID="${AMI_ID:-}"
if [[ -n "$KEY_NAME" && -z "$SSH_CIDR" ]]; then
  SSH_IP="$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')"
  SSH_CIDR="${SSH_IP}/32"
fi
SSH_CIDR="${SSH_CIDR:-127.0.0.1/32}"

cleanup() {
  rm -f "$PAYLOAD" "$TFVARS"
}
trap cleanup EXIT

echo "==> render-remote ${RUN_ID}"
echo "    timeline: ${TIMELINE}"
echo "    output:   ${OUTPUT}"
echo "    profile:  ${AWS_PROFILE}"
echo "    region:   ${AWS_REGION}"
echo "    samples:  ${RENDER_SAMPLES}"
echo "    root GiB: ${ROOT_VOLUME_SIZE_GB}"
if [[ -n "$KEY_NAME" ]]; then
  echo "    ssh key:  ${KEY_NAME}"
  echo "    ssh cidr: ${SSH_CIDR}"
fi
if [[ -n "$AMI_ID" ]]; then
  echo "    ami:      ${AMI_ID}"
fi

# ── 1. Package payload ───────────────────────────────────────────────────
echo "==> [1/4] packaging payload..."
bash tools/render-payload.sh "$TIMELINE" "$PAYLOAD"

PAYLOAD_KEY="payloads/${RUN_ID}.tar.gz"
RESULT_KEY="results/${RUN_ID}.mp4"

cat > "$TFVARS" << EOF
aws_profile   = "${AWS_PROFILE}"
region        = "${AWS_REGION}"
instance_type = "${INSTANCE_TYPE}"
payload_key   = "${PAYLOAD_KEY}"
payload_path  = "../${PAYLOAD}"
result_key    = "${RESULT_KEY}"
key_name      = "${KEY_NAME}"
ssh_cidr      = "${SSH_CIDR}"
spot_price    = "${SPOT_PRICE}"
render_samples = ${RENDER_SAMPLES}
root_volume_size_gb = ${ROOT_VOLUME_SIZE_GB}
EOF
if [[ -n "$AMI_ID" ]]; then
  printf 'ami_id = "%s"\n' "$AMI_ID" >> "$TFVARS"
fi

# ── 2. Launch render instance ─────────────────────────────────────────────
echo "==> [2/4] applying Terraform..."
terraform -chdir=terraform init -input=false
terraform -chdir=terraform apply -auto-approve -var-file="$(basename "$TFVARS")"

INSTANCE_ID="$(terraform -chdir=terraform output -raw instance_id)"
PUBLIC_IP="$(terraform -chdir=terraform output -raw public_ip)"
BUCKET="$(terraform -chdir=terraform output -raw bucket)"
S3_RESULT="s3://${BUCKET}/${RESULT_KEY}"
S3_LOG="s3://${BUCKET}/${RESULT_KEY}.log"

echo "    instance: ${INSTANCE_ID}"
echo "    ip:       ${PUBLIC_IP}"
echo "    bucket:   ${BUCKET}"
echo "    payload:  s3://${BUCKET}/${PAYLOAD_KEY}"
echo "    result:   ${S3_RESULT}"
echo "    log:      ${S3_LOG}"

# ── 3. Wait for render to complete ────────────────────────────────────────
echo "==> [3/4] waiting for render..."
echo "    shell:   aws ssm start-session --target ${INSTANCE_ID} --profile ${AWS_PROFILE} --region ${AWS_REGION}"
echo "    log:     aws ssm send-command --instance-ids ${INSTANCE_ID} --document-name AWS-RunShellScript --parameters commands='tail -n 120 /var/log/render.log' --profile ${AWS_PROFILE} --region ${AWS_REGION}"
if [[ -n "$KEY_NAME" ]]; then
  echo "    ssh:     ssh ubuntu@${PUBLIC_IP} 'tail -f /var/log/render.log'"
fi

STARTED_AT="$(date +%s)"
while true; do
  if aws s3api head-object \
    --bucket "$BUCKET" \
    --key "$RESULT_KEY" \
    --profile "$AWS_PROFILE" \
    --region "$AWS_REGION" >/dev/null 2>&1; then
    echo "    result confirmed in S3"
    break
  fi

  STATE="$(aws ec2 describe-instances \
    --instance-ids "$INSTANCE_ID" \
    --profile "$AWS_PROFILE" \
    --region "$AWS_REGION" \
    --query 'Reservations[0].Instances[0].State.Name' \
    --output text || echo "gone")"

  if [[ "$STATE" == "terminated" || "$STATE" == "shutting-down" || "$STATE" == "gone" ]]; then
    echo "    instance ${STATE}; render failed before writing ${S3_RESULT}" >&2
    echo "    render log, if uploaded: ${S3_LOG}" >&2
    exit 1
  fi

  NOW="$(date +%s)"
  if (( NOW - STARTED_AT >= RENDER_TIMEOUT_SECONDS )); then
    echo "    timed out after ${RENDER_TIMEOUT_SECONDS}s waiting for ${S3_RESULT}" >&2
    echo "    render log, if uploaded: ${S3_LOG}" >&2
    exit 1
  fi

  echo "    state: ${STATE} — waiting 15s..."
  sleep 15
done

# ── 4. Download result ────────────────────────────────────────────────────
echo "==> [4/4] downloading result..."
mkdir -p "$(dirname "$OUTPUT")"
aws s3 cp "$S3_RESULT" "$OUTPUT" --profile "$AWS_PROFILE" --region "$AWS_REGION"
ls -lh "$OUTPUT"

echo "==> Done: ${OUTPUT}"
echo "    S3 artifacts preserved at ${S3_RESULT} (7-day TTL)"
