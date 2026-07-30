#!/usr/bin/env bash
# Build a complete compendium bird's-eye montage on the ephemeral EC2 render box.
#
# Usage:
#   tools/render-compendium-birdseye-remote.sh [output.mp4]
#
# Tuning env:
#   BIRDSEYE_MONTAGE_FPS=16
#   BIRDSEYE_MONTAGE_WIDTH=1280
#   BIRDSEYE_MONTAGE_HEIGHT=720
#   BIRDSEYE_MAX_SECONDS_PER_REPLAY=8   # optional preview cap; unset for complete replay durations
#   BIRDSEYE_RENDER_MODE=direct          # direct for single-camera timelines; stills for frame sequences
#   BIRDSEYE_FRAME_FORMAT=jpeg           # still-frame fallback format: jpeg or png
#   BIRDSEYE_RENDER_WORKERS=2            # parallel Blender workers on the same instance
#   RENDER_SAMPLES=24
#   INSTANCE_TYPE=g5.xlarge
set -euo pipefail

OUT_DIR="${BIRDSEYE_OUT_DIR:-clips/compendium-birdseye}"
OUTPUT="${1:-${OUT_DIR}/compendium-birdseye.mp4}"
RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
PAYLOAD="clips/render-payload-${RUN_ID}.tar.gz"
TFVARS="terraform/render-${RUN_ID}.tfvars"

AWS_PROFILE="${AWS_PROFILE:-terraform-user}"
AWS_REGION="${AWS_REGION:-us-east-1}"
INSTANCE_TYPE="${INSTANCE_TYPE:-g5.xlarge}"
KEY_NAME="${KEY_NAME:-}"
SSH_CIDR="${SSH_CIDR-}"
SPOT_PRICE="${SPOT_PRICE:-}"
RENDER_TIMEOUT_SECONDS="${RENDER_TIMEOUT_SECONDS:-14400}"
RENDER_SAMPLES="${RENDER_SAMPLES:-24}"
ROOT_VOLUME_SIZE_GB="${ROOT_VOLUME_SIZE_GB:-100}"
AMI_ID="${AMI_ID:-}"

MONTAGE_FPS="${BIRDSEYE_MONTAGE_FPS:-16}"
MONTAGE_WIDTH="${BIRDSEYE_MONTAGE_WIDTH:-1280}"
MONTAGE_HEIGHT="${BIRDSEYE_MONTAGE_HEIGHT:-720}"
MONTAGE_MAX_SECONDS="${BIRDSEYE_MAX_SECONDS_PER_REPLAY:-}"
RENDER_MODE="${BIRDSEYE_RENDER_MODE:-direct}"
FRAME_FORMAT="${BIRDSEYE_FRAME_FORMAT:-jpeg}"
RENDER_WORKERS="${BIRDSEYE_RENDER_WORKERS:-2}"

if [[ -n "$KEY_NAME" && -z "$SSH_CIDR" ]]; then
  SSH_IP="$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')"
  SSH_CIDR="${SSH_IP}/32"
fi
SSH_CIDR="${SSH_CIDR:-127.0.0.1/32}"

cleanup() {
  rm -f "$PAYLOAD" "$TFVARS"
}
trap cleanup EXIT

echo "==> compendium birdseye remote ${RUN_ID}"
echo "    output:   ${OUTPUT}"
echo "    profile:  ${AWS_PROFILE}"
echo "    region:   ${AWS_REGION}"
echo "    instance: ${INSTANCE_TYPE}"
echo "    fps:      ${MONTAGE_FPS}"
echo "    size:     ${MONTAGE_WIDTH}x${MONTAGE_HEIGHT}"
echo "    samples:  ${RENDER_SAMPLES}"
echo "    mode:     ${RENDER_MODE}"
echo "    frames:   ${FRAME_FORMAT}"
echo "    workers:  ${RENDER_WORKERS}"
echo "    root GiB: ${ROOT_VOLUME_SIZE_GB}"
if [[ -n "$MONTAGE_MAX_SECONDS" ]]; then
  echo "    cap:      ${MONTAGE_MAX_SECONDS}s per replay"
else
  echo "    cap:      none; complete replay durations"
fi
if [[ -n "$KEY_NAME" ]]; then
  echo "    ssh key:  ${KEY_NAME}"
  echo "    ssh cidr: ${SSH_CIDR}"
fi
if [[ -n "$AMI_ID" ]]; then
  echo "    ami:      ${AMI_ID}"
fi

echo "==> [1/5] generating birdseye timelines locally..."
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
TIMELINE_ARGS=(
  --timeline-only
  --out-dir "$OUT_DIR"
  --manifest "$OUT_DIR/manifest.json"
  --fps "$MONTAGE_FPS"
  --width "$MONTAGE_WIDTH"
  --height "$MONTAGE_HEIGHT"
)
if [[ -n "$MONTAGE_MAX_SECONDS" ]]; then
  TIMELINE_ARGS+=(--max-seconds-per-replay "$MONTAGE_MAX_SECONDS")
fi
npx tsx src/headless/compendiumBirdseyeMontage.ts "${TIMELINE_ARGS[@]}"

echo "==> [2/5] packaging batch payload..."
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; cleanup' EXIT
PAYLOAD_DIR="$WORK/payload"
mkdir -p "$PAYLOAD_DIR/timelines"
cp tools/blender/render_native_flight.py "$PAYLOAD_DIR/render_native_flight.py"
cp "$OUT_DIR"/manifest.json "$PAYLOAD_DIR/manifest.json"
cp "$OUT_DIR"/*.birdseye.timeline.json "$PAYLOAD_DIR/timelines/"
cp "$OUT_DIR"/*.label.txt "$PAYLOAD_DIR/timelines/"

cat > "$PAYLOAD_DIR/render-config.env" <<EOF
RENDER_MODE=${RENDER_MODE}
FRAME_FORMAT=${FRAME_FORMAT}
WORKERS=${RENDER_WORKERS}
EOF

cat > "$PAYLOAD_DIR/render.sh" <<'RENDER_SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

if [[ -f render-config.env ]]; then
  source render-config.env
fi

BLENDER="${BLENDER:-blender}"
FFMPEG="${FFMPEG_BIN:-ffmpeg}"
SAMPLES="${SAMPLES:-24}"
RENDER_MODE="${RENDER_MODE:-direct}"
FRAME_FORMAT="${FRAME_FORMAT:-jpeg}"
WORKERS="${WORKERS:-2}"
OUT="${1:-result.mp4}"

mkdir -p rendered frames
: > concat.txt

render_one() {
  local timeline="$1"
  slug="$(basename "$timeline" .birdseye.timeline.json)"
  raw="rendered/${slug}.raw.mp4"
  labeled="rendered/${slug}.mp4"
  frames_dir="frames/${slug}"
  label="timelines/${slug}.label.txt"

  echo "==> Rendering ${slug}"
  mkdir -p "$frames_dir"
  if [[ "$RENDER_MODE" == "direct" ]]; then
    if ! "$BLENDER" --background --python render_native_flight.py -- \
      --timeline "$timeline" \
      --out "$raw" \
      --frames-dir "$frames_dir" \
      --samples "$SAMPLES" \
      --frame-format "$FRAME_FORMAT" \
      --direct-video || [[ ! -s "$raw" ]]; then
      echo "WARN: direct render failed for ${slug}; falling back to ${FRAME_FORMAT} stills" >&2
      rm -f "$raw"
      "$BLENDER" --background --python render_native_flight.py -- \
        --timeline "$timeline" \
        --out "$raw" \
        --frames-dir "$frames_dir" \
        --samples "$SAMPLES" \
        --frame-format "$FRAME_FORMAT"
    fi
  else
    "$BLENDER" --background --python render_native_flight.py -- \
      --timeline "$timeline" \
      --out "$raw" \
      --frames-dir "$frames_dir" \
      --samples "$SAMPLES" \
      --frame-format "$FRAME_FORMAT"
  fi
  rm -rf "$frames_dir"

  cp "$raw" "$labeled"
  printf "file '%s/%s'\n" "$(pwd)" "$labeled" > "rendered/${slug}.concat"
}
export -f render_one
export BLENDER FFMPEG SAMPLES RENDER_MODE FRAME_FORMAT

mapfile -t TIMELINES < <(find timelines -maxdepth 1 -name '*.birdseye.timeline.json' | sort)
if (( WORKERS > 1 )); then
  printf "%s\0" "${TIMELINES[@]}" | xargs -0 -n1 -P "$WORKERS" bash -c 'render_one "$1"' _
else
  for timeline in "${TIMELINES[@]}"; do
    render_one "$timeline"
  done
fi

for timeline in "${TIMELINES[@]}"; do
  slug="$(basename "$timeline" .birdseye.timeline.json)"
  cat "rendered/${slug}.concat" >> concat.txt
done

echo "==> Concatenating clips"
if ! "$FFMPEG" -y -f concat -safe 0 -i concat.txt -c copy "$OUT"; then
  "$FFMPEG" -y -f concat -safe 0 -i concat.txt -c:v libx264 -pix_fmt yuv420p -movflags +faststart "$OUT"
fi

echo "Done: $OUT"
ls -lh "$OUT"
RENDER_SCRIPT
chmod +x "$PAYLOAD_DIR/render.sh"

cat > "$PAYLOAD_DIR/README.txt" <<EOF
Compendium birdseye batch render
================================
Timelines: $(find "$PAYLOAD_DIR/timelines" -name '*.birdseye.timeline.json' | wc -l | tr -d ' ')
FPS: ${MONTAGE_FPS}
Resolution: ${MONTAGE_WIDTH}x${MONTAGE_HEIGHT}
Samples: ${RENDER_SAMPLES}
Mode: ${RENDER_MODE}
Frame fallback: ${FRAME_FORMAT}
Workers: ${RENDER_WORKERS}

Remote render:
  SAMPLES=${RENDER_SAMPLES} bash render.sh result.mp4
EOF

mkdir -p "$(dirname "$PAYLOAD")"
COPYFILE_DISABLE=1 tar --format ustar -czf "$PAYLOAD" -C "$WORK" payload
echo "    payload: ${PAYLOAD} ($(du -h "$PAYLOAD" | cut -f1))"

PAYLOAD_KEY="payloads/${RUN_ID}.tar.gz"
RESULT_KEY="results/${RUN_ID}.mp4"

cat > "$TFVARS" <<EOF
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

echo "==> [3/5] applying Terraform..."
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
echo "    shell:    aws ssm start-session --target ${INSTANCE_ID} --profile ${AWS_PROFILE} --region ${AWS_REGION}"
if [[ -n "$KEY_NAME" ]]; then
  echo "    ssh:      ssh ubuntu@${PUBLIC_IP} 'tail -f /var/log/render.log'"
fi

echo "==> [4/5] waiting for render..."
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

  echo "    state: ${STATE}; waiting 30s..."
  sleep 30
done

echo "==> [5/5] downloading result..."
mkdir -p "$(dirname "$OUTPUT")"
aws s3 cp "$S3_RESULT" "$OUTPUT" --profile "$AWS_PROFILE" --region "$AWS_REGION"
ls -lh "$OUTPUT"

echo "==> Done: ${OUTPUT}"
echo "    manifest: ${OUT_DIR}/manifest.json"
echo "    S3 result: ${S3_RESULT}"
echo "    S3 log:    ${S3_LOG}"
