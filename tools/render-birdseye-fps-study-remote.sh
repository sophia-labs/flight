#!/usr/bin/env bash
# Render a short bird's-eye FPS comparison on the ephemeral EC2 render box.
#
# Usage:
#   tools/render-birdseye-fps-study-remote.sh [replay.json] [output.mp4]
#
# Defaults use the 8s BVR stateful-coach retry replay and compare 8/12/16/24 fps.
set -euo pipefail

REPLAY="${1:-reports/bvr-live/bvr-stateful-coach-run-2.json}"
OUTPUT="${2:-clips/birdseye-fps-study/birdseye-fps-study.mp4}"
RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
OUT_DIR="clips/birdseye-fps-study"
PAYLOAD="clips/render-payload-${RUN_ID}.tar.gz"
TFVARS="terraform/render-${RUN_ID}.tfvars"

AWS_PROFILE="${AWS_PROFILE:-terraform-user}"
AWS_REGION="${AWS_REGION:-us-east-1}"
INSTANCE_TYPE="${INSTANCE_TYPE:-g5.xlarge}"
KEY_NAME="${KEY_NAME:-}"
SSH_CIDR="${SSH_CIDR-}"
SPOT_PRICE="${SPOT_PRICE:-}"
RENDER_TIMEOUT_SECONDS="${RENDER_TIMEOUT_SECONDS:-3600}"
RENDER_SAMPLES="${RENDER_SAMPLES:-8}"
ROOT_VOLUME_SIZE_GB="${ROOT_VOLUME_SIZE_GB:-100}"
AMI_ID="${AMI_ID:-}"

FPS_LIST="${BIRDSEYE_FPS_LIST:-8 12 16 24}"
STUDY_SECONDS="${BIRDSEYE_STUDY_SECONDS:-8}"
WIDTH="${BIRDSEYE_STUDY_WIDTH:-1280}"
HEIGHT="${BIRDSEYE_STUDY_HEIGHT:-720}"
FINAL_FPS="${BIRDSEYE_STUDY_FINAL_FPS:-24}"

if [[ -n "$KEY_NAME" && -z "$SSH_CIDR" ]]; then
  SSH_IP="$(curl -fsS https://checkip.amazonaws.com | tr -d '[:space:]')"
  SSH_CIDR="${SSH_IP}/32"
fi
SSH_CIDR="${SSH_CIDR:-127.0.0.1/32}"

cleanup() {
  rm -f "$PAYLOAD" "$TFVARS"
}
trap cleanup EXIT

mapfile -t FPS_VALUES < <(tr ', ' '\n\n' <<< "$FPS_LIST" | awk 'NF { print }')
if [[ "${#FPS_VALUES[@]}" -ne 4 ]]; then
  echo "BIRDSEYE_FPS_LIST must contain exactly four fps values for the 2x2 study grid" >&2
  exit 1
fi

echo "==> birdseye fps study remote ${RUN_ID}"
echo "    replay:   ${REPLAY}"
echo "    output:   ${OUTPUT}"
echo "    fps list: ${FPS_VALUES[*]}"
echo "    seconds:  ${STUDY_SECONDS}"
echo "    samples:  ${RENDER_SAMPLES}"
echo "    size:     ${WIDTH}x${HEIGHT}"
echo "    final fps:${FINAL_FPS}"
echo "    instance: ${INSTANCE_TYPE}"

echo "==> [1/5] generating timelines locally..."
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"
for fps in "${FPS_VALUES[@]}"; do
  npx tsx src/headless/renderNative.ts \
    --timeline-only \
    --replay "$REPLAY" \
    --camera birdseye \
    --seconds "$STUDY_SECONDS" \
    --fps "$fps" \
    --width "$WIDTH" \
    --height "$HEIGHT" \
    --timeline-out "$OUT_DIR/birdseye-${fps}fps.timeline.json" \
    --out "$OUT_DIR/birdseye-${fps}fps.mp4"
  node --input-type=module - "$OUT_DIR/birdseye-${fps}fps.timeline.json" "$fps" "$RENDER_SAMPLES" <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";

const [timelinePath, fps, samples] = process.argv.slice(2);
const timeline = JSON.parse(readFileSync(timelinePath, "utf8"));
const fallbackEnd = (timeline.frames?.at(-1)?.time ?? 0) + 1 / Number(timeline.fps || fps || 1);
const end = Number.isFinite(timeline.durationSeconds) ? timeline.durationSeconds : fallbackEnd;
timeline.subtitles = [
  {
    start: 0,
    end,
    label: "FPS",
    text: `${fps} fps | ${samples} samples`,
  },
];
writeFileSync(timelinePath, `${JSON.stringify(timeline, null, 2)}\n`);
NODE
done

echo "==> [2/5] packaging fps-study payload..."
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"; cleanup' EXIT
PAYLOAD_DIR="$WORK/payload"
mkdir -p "$PAYLOAD_DIR/timelines"
cp tools/blender/render_native_flight.py "$PAYLOAD_DIR/render_native_flight.py"
cp "$OUT_DIR"/birdseye-*fps.timeline.json "$PAYLOAD_DIR/timelines/"
printf "%s\n" "${FPS_VALUES[@]}" > "$PAYLOAD_DIR/fps-order.txt"
printf "%s\n" "$FINAL_FPS" > "$PAYLOAD_DIR/final-fps.txt"

cat > "$PAYLOAD_DIR/render.sh" <<'RENDER_SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

BLENDER="${BLENDER:-blender}"
FFMPEG="${FFMPEG_BIN:-ffmpeg}"
SAMPLES="${SAMPLES:-8}"
OUT="${1:-result.mp4}"
FINAL_FPS="${FINAL_FPS:-}"
if [[ -z "$FINAL_FPS" && -f final-fps.txt ]]; then
  FINAL_FPS="$(< final-fps.txt)"
fi
FINAL_FPS="${FINAL_FPS:-24}"

mkdir -p rendered frames
inputs=()
labels=()
index=0
while IFS= read -r fps <&3; do
  [[ -n "$fps" ]] || continue
  timeline="timelines/birdseye-${fps}fps.timeline.json"
  if [[ ! -f "$timeline" ]]; then
    echo "missing timeline: $timeline" >&2
    exit 1
  fi
  slug="$(basename "$timeline" .timeline.json)"
  fps_label="${slug#birdseye-}"
  raw="rendered/${slug}.raw.mp4"
  frames_dir="frames/${slug}"

  echo "==> Rendering ${slug}"
  mkdir -p "$frames_dir"
  NATIVE_RENDER_BLENDER_SUBTITLES=1 "$BLENDER" --background --python render_native_flight.py -- \
    --timeline "$timeline" \
    --out "$raw" \
    --frames-dir "$frames_dir" \
    --samples "$SAMPLES" < /dev/null
  rm -rf "$frames_dir"

  inputs+=("-i" "$raw")
  labels+=("$fps_label")
  index=$((index + 1))
done 3< fps-order.txt

if [[ "${#labels[@]}" -ne 4 ]]; then
  echo "expected four rendered fps variants, got ${#labels[@]}" >&2
  exit 1
fi

filter=""
for i in 0 1 2 3; do
  filter+="[${i}:v]fps=${FINAL_FPS},scale=640:360,setsar=1,"
  filter+="drawbox=x=0:y=0:w=iw:h=ih:color=white@0.35:t=2[v${i}];"
done
filter+="[v0][v1]hstack=inputs=2[top];[v2][v3]hstack=inputs=2[bot];[top][bot]vstack=inputs=2[out]"

"$FFMPEG" -nostdin -y "${inputs[@]}" \
  -filter_complex "$filter" \
  -map "[out]" \
  -c:v libx264 \
  -pix_fmt yuv420p \
  -r "$FINAL_FPS" \
  -movflags +faststart \
  "$OUT"

echo "Done: $OUT"
ls -lh "$OUT"
RENDER_SCRIPT
chmod +x "$PAYLOAD_DIR/render.sh"

cat > "$PAYLOAD_DIR/README.txt" <<EOF
Birdseye FPS study
==================
Replay: ${REPLAY}
Seconds: ${STUDY_SECONDS}
FPS variants: ${FPS_VALUES[*]}
Samples: ${RENDER_SAMPLES}
Resolution per render: ${WIDTH}x${HEIGHT}
Final grid: 1280x720 @ ${FINAL_FPS}fps
Grid order: top-left=${FPS_VALUES[0]}fps, top-right=${FPS_VALUES[1]}fps, bottom-left=${FPS_VALUES[2]}fps, bottom-right=${FPS_VALUES[3]}fps
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
echo "    result:   ${S3_RESULT}"
echo "    log:      ${S3_LOG}"
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

  echo "    state: ${STATE}; waiting 20s..."
  sleep 20
done

echo "==> [5/5] downloading result..."
mkdir -p "$(dirname "$OUTPUT")"
aws s3 cp "$S3_RESULT" "$OUTPUT" --profile "$AWS_PROFILE" --region "$AWS_REGION"
ls -lh "$OUTPUT"
echo "==> Done: ${OUTPUT}"
