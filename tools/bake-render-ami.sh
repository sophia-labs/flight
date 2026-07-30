#!/usr/bin/env bash
# Bake a render AMI with Blender, ffmpeg, AWS CLI, and Linux runtime libs already
# installed. Requires the shared Terraform IAM instance profile and security group.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

AWS_PROFILE="${AWS_PROFILE:-terraform-user}"
AWS_REGION="${AWS_REGION:-us-east-1}"
INSTANCE_TYPE="${INSTANCE_TYPE:-g5.xlarge}"
KEY_NAME="${KEY_NAME:-flight-render}"
SSH_CIDR="${SSH_CIDR:-}"
SSH_PUBLIC_KEY="${SSH_PUBLIC_KEY:-$HOME/.ssh/id_ed25519.pub}"
BLENDER_VERSION="${BLENDER_VERSION:-4.2.0}"
ROOT_VOLUME_SIZE_GB="${ROOT_VOLUME_SIZE_GB:-100}"
AMI_NAME="${AMI_NAME:-flight-render-gpu-$(date +%Y%m%d-%H%M%S)}"
BASE_AMI_ID="${BASE_AMI_ID:-}"
WRITE_TFVARS="${WRITE_TFVARS:-1}"
KEEP_BAKE_INSTANCE="${KEEP_BAKE_INSTANCE:-0}"

INSTANCE_ID=""
INSTANCE_CLEANED=0
PARAMS_FILE=""

cleanup() {
  if [[ -n "$PARAMS_FILE" ]]; then
    rm -f "$PARAMS_FILE"
  fi
  if [[ -n "$INSTANCE_ID" && "$INSTANCE_CLEANED" -eq 0 && "$KEEP_BAKE_INSTANCE" != "1" ]]; then
    echo "==> Cleaning up bake instance $INSTANCE_ID..."
    aws ec2 terminate-instances \
      --instance-ids "$INSTANCE_ID" \
      --profile "$AWS_PROFILE" \
      --region "$AWS_REGION" >/dev/null || true
  fi
}
trap cleanup EXIT

state_attr() {
  local address="$1"
  local attr="$2"
  python3 - "$address" "$attr" <<'PY'
import json
import os
import sys
address, attr = sys.argv[1], sys.argv[2]
want_type, want_name = address.split('.', 1)
state = json.loads(os.environ['TF_STATE_JSON'])
for resource in state.get('resources', []):
    if resource.get('mode') != 'managed':
        continue
    if resource.get('type') == want_type and resource.get('name') == want_name:
        instances = resource.get('instances') or []
        if not instances:
            break
        value = instances[0].get('attributes', {}).get(attr)
        if value in (None, ''):
            break
        print(value)
        sys.exit(0)
print(f'missing {address}.{attr} in terraform state', file=sys.stderr)
sys.exit(1)
PY
}

if [[ -z "$SSH_CIDR" ]]; then
  SSH_IP="$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')"
  SSH_CIDR="${SSH_IP}/32"
fi

if ! aws ec2 describe-key-pairs \
  --key-names "$KEY_NAME" \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" >/dev/null 2>&1; then
  if [[ ! -f "$SSH_PUBLIC_KEY" ]]; then
    echo "SSH key pair $KEY_NAME is missing and $SSH_PUBLIC_KEY does not exist" >&2
    exit 1
  fi
  echo "==> Importing SSH key pair $KEY_NAME from $SSH_PUBLIC_KEY..."
  aws ec2 import-key-pair \
    --key-name "$KEY_NAME" \
    --public-key-material "fileb://$SSH_PUBLIC_KEY" \
    --profile "$AWS_PROFILE" \
    --region "$AWS_REGION" >/dev/null
fi

echo "==> Reading shared Terraform resources..."
terraform -chdir=terraform init -input=false >/dev/null
TF_STATE_JSON="$(terraform -chdir=terraform state pull)"
export TF_STATE_JSON
SECURITY_GROUP_ID="$(state_attr aws_security_group.render id)"
INSTANCE_PROFILE_NAME="$(state_attr aws_iam_instance_profile.render name)"

if [[ -z "$BASE_AMI_ID" ]]; then
  BASE_AMI_ID="$(aws ec2 describe-images \
    --owners amazon \
    --filters \
      Name=name,Values='Deep Learning Base OSS Nvidia Driver GPU AMI (Ubuntu 22.04)*' \
      Name=state,Values=available \
    --query 'sort_by(Images,&CreationDate)[-1].ImageId' \
    --output text \
    --profile "$AWS_PROFILE" \
    --region "$AWS_REGION")"
fi
ROOT_DEVICE="$(aws ec2 describe-images \
  --image-ids "$BASE_AMI_ID" \
  --query 'Images[0].RootDeviceName' \
  --output text \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION")"

BLOCK_DEVICE_MAPPINGS="$(ROOT_DEVICE="$ROOT_DEVICE" ROOT_VOLUME_SIZE_GB="$ROOT_VOLUME_SIZE_GB" python3 - <<'PY'
import json
import os
print(json.dumps([{
    'DeviceName': os.environ['ROOT_DEVICE'],
    'Ebs': {
        'VolumeSize': int(os.environ['ROOT_VOLUME_SIZE_GB']),
        'VolumeType': 'gp3',
        'DeleteOnTermination': True,
    },
}]))
PY
)"

AUTH_OUTPUT=""
if ! AUTH_OUTPUT="$(aws ec2 authorize-security-group-ingress \
  --group-id "$SECURITY_GROUP_ID" \
  --protocol tcp \
  --port 22 \
  --cidr "$SSH_CIDR" \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" 2>&1)"; then
  if [[ "$AUTH_OUTPUT" != *"InvalidPermission.Duplicate"* ]]; then
    echo "$AUTH_OUTPUT" >&2
    exit 1
  fi
fi

echo "==> Launching bake instance..."
echo "    base AMI:  $BASE_AMI_ID"
echo "    type:      $INSTANCE_TYPE"
echo "    key:       $KEY_NAME"
echo "    ssh CIDR:  $SSH_CIDR"
echo "    sg:        $SECURITY_GROUP_ID"
echo "    profile:   $INSTANCE_PROFILE_NAME"
INSTANCE_ID="$(aws ec2 run-instances \
  --image-id "$BASE_AMI_ID" \
  --instance-type "$INSTANCE_TYPE" \
  --iam-instance-profile "Name=$INSTANCE_PROFILE_NAME" \
  --security-group-ids "$SECURITY_GROUP_ID" \
  --key-name "$KEY_NAME" \
  --block-device-mappings "$BLOCK_DEVICE_MAPPINGS" \
  --tag-specifications \
    "ResourceType=instance,Tags=[{Key=Name,Value=flight-render-ami-bake},{Key=FlightRole,Value=render-ami-bake}]" \
    "ResourceType=volume,Tags=[{Key=Name,Value=flight-render-ami-bake},{Key=FlightRole,Value=render-ami-bake}]" \
  --query 'Instances[0].InstanceId' \
  --output text \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION")"
echo "    instance:  $INSTANCE_ID"

aws ec2 wait instance-running \
  --instance-ids "$INSTANCE_ID" \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION"
PUBLIC_IP="$(aws ec2 describe-instances \
  --instance-ids "$INSTANCE_ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' \
  --output text \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION")"
echo "    ip:        $PUBLIC_IP"

echo "==> Waiting for SSH..."
for _ in $(seq 1 36); do
  if ssh -o BatchMode=yes \
    -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/tmp/flight-render-known-hosts \
    -o ConnectTimeout=10 \
    "ubuntu@$PUBLIC_IP" 'hostname >/dev/null' 2>/dev/null; then
    echo "    ssh ready: ubuntu@$PUBLIC_IP"
    break
  fi
  sleep 10
done

echo "==> Waiting for SSM..."
for _ in $(seq 1 60); do
  SSM_STATUS="$(aws ssm describe-instance-information \
    --filters "Key=InstanceIds,Values=$INSTANCE_ID" \
    --query 'InstanceInformationList[0].PingStatus' \
    --output text \
    --profile "$AWS_PROFILE" \
    --region "$AWS_REGION")"
  if [[ "$SSM_STATUS" == "Online" ]]; then
    echo "    ssm ready"
    break
  fi
  sleep 10
done
if [[ "${SSM_STATUS:-}" != "Online" ]]; then
  echo "SSM did not come online for $INSTANCE_ID" >&2
  exit 1
fi

SETUP_B64="$(python3 - <<'PY'
import base64
from pathlib import Path
print(base64.b64encode(Path('terraform/render-host-setup.sh').read_bytes()).decode())
PY
)"
PARAMS_FILE="$(mktemp)"
SETUP_B64="$SETUP_B64" BLENDER_VERSION="$BLENDER_VERSION" python3 - "$PARAMS_FILE" <<'PY'
import json
import os
import sys
from pathlib import Path

setup_b64 = os.environ['SETUP_B64']
blender_version = os.environ['BLENDER_VERSION'].replace("'", "'\\''")
command = f"""bash <<'BAKE_BASH'
set -euo pipefail
cat >/tmp/flight-render-host-setup.b64 <<'SETUP_SCRIPT'
{setup_b64}
SETUP_SCRIPT
base64 -d /tmp/flight-render-host-setup.b64 >/usr/local/bin/flight-render-host-setup
chmod +x /usr/local/bin/flight-render-host-setup
BLENDER_VERSION='{blender_version}' /usr/local/bin/flight-render-host-setup
sync
BAKE_BASH"""
Path(sys.argv[1]).write_text(json.dumps({'commands': [command], 'executionTimeout': ['3600']}), encoding='utf8')
PY

echo "==> Running setup through SSM..."
COMMAND_ID="$(aws ssm send-command \
  --instance-ids "$INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --parameters "file://$PARAMS_FILE" \
  --query 'Command.CommandId' \
  --output text \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION")"

STATUS="Pending"
for _ in $(seq 1 360); do
  INVOCATION_JSON="$(aws ssm get-command-invocation \
    --command-id "$COMMAND_ID" \
    --instance-id "$INSTANCE_ID" \
    --output json \
    --profile "$AWS_PROFILE" \
    --region "$AWS_REGION" 2>/dev/null || true)"
  if [[ -n "$INVOCATION_JSON" ]]; then
    STATUS="$(INVOCATION_JSON="$INVOCATION_JSON" python3 - <<'PY'
import json
import os
print(json.loads(os.environ['INVOCATION_JSON']).get('Status', 'Pending'))
PY
)"
    case "$STATUS" in
      Success|Failed|Cancelled|TimedOut|Cancelling) break ;;
    esac
  fi
  sleep 10
done

aws ssm get-command-invocation \
  --command-id "$COMMAND_ID" \
  --instance-id "$INSTANCE_ID" \
  --query '{Status:Status,Output:StandardOutputContent,Error:StandardErrorContent}' \
  --output json \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION"

if [[ "$STATUS" != "Success" ]]; then
  echo "Bake setup failed with SSM status $STATUS" >&2
  exit 1
fi

echo "==> Stopping bake instance for imaging..."
aws ec2 stop-instances \
  --instance-ids "$INSTANCE_ID" \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" >/dev/null
aws ec2 wait instance-stopped \
  --instance-ids "$INSTANCE_ID" \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION"

echo "==> Creating AMI $AMI_NAME..."
AMI_ID="$(aws ec2 create-image \
  --instance-id "$INSTANCE_ID" \
  --name "$AMI_NAME" \
  --description "Flight render GPU AMI: Blender $BLENDER_VERSION, ffmpeg, AWS CLI, runtime libs" \
  --tag-specifications \
    "ResourceType=image,Tags=[{Key=Name,Value=$AMI_NAME},{Key=FlightRole,Value=render-ami}]" \
    "ResourceType=snapshot,Tags=[{Key=Name,Value=$AMI_NAME},{Key=FlightRole,Value=render-ami}]" \
  --query ImageId \
  --output text \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION")"
echo "    ami:       $AMI_ID"
aws ec2 wait image-available \
  --image-ids "$AMI_ID" \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION"

echo "==> Terminating bake instance..."
aws ec2 terminate-instances \
  --instance-ids "$INSTANCE_ID" \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION" >/dev/null
aws ec2 wait instance-terminated \
  --instance-ids "$INSTANCE_ID" \
  --profile "$AWS_PROFILE" \
  --region "$AWS_REGION"
INSTANCE_CLEANED=1

if [[ "$WRITE_TFVARS" == "1" ]]; then
  cat > terraform/render-ami.auto.tfvars <<EOF
ami_id = "$AMI_ID"
root_volume_size_gb = $ROOT_VOLUME_SIZE_GB
EOF
  echo "==> Wrote terraform/render-ami.auto.tfvars"
fi

echo "==> Baked render AMI ready: $AMI_ID"
echo "    Next render uses it automatically when terraform/render-ami.auto.tfvars is present."
