#!/usr/bin/env bash
# Render script — runs on the EC2 render box at boot.
# Installs Blender + ffmpeg, pulls payload from S3, renders, uploads result.
set -euxo pipefail
exec > /var/log/render.log 2>&1

# These are HCL template variables — injected at terraform apply time.
S3_BUCKET="${s3_bucket}"
S3_PAYLOAD_KEY="${s3_payload_key}"
S3_RESULT_KEY="${s3_result_key}"
BLENDER_VERSION="${blender_version}"
RENDER_SAMPLES="${render_samples}"
S3_LOG_KEY="$${S3_RESULT_KEY}.log"

finish() {
  status=$?
  set +e
  if [[ "$status" -eq 0 ]]; then
    echo "==> Done. Shutting down."
  else
    echo "==> Failed with status $status. Shutting down."
  fi
  if command -v aws >/dev/null 2>&1; then
    aws s3 cp /var/log/render.log "s3://$S3_BUCKET/$S3_LOG_KEY"
  fi
  shutdown -h now
  exit "$status"
}
trap finish EXIT

echo "==> Ensuring render host setup..."
base64 -d >/usr/local/bin/flight-render-host-setup <<'SETUP_SCRIPT'
${setup_script_b64}
SETUP_SCRIPT
chmod +x /usr/local/bin/flight-render-host-setup
BLENDER_VERSION="$BLENDER_VERSION" /usr/local/bin/flight-render-host-setup
BLENDER="/opt/blender-$BLENDER_VERSION-linux-x64/blender"

echo "==> Pulling payload from s3://$S3_BUCKET/$S3_PAYLOAD_KEY..."
mkdir -p /tmp/render
aws s3 cp "s3://$S3_BUCKET/$S3_PAYLOAD_KEY" /tmp/render/payload.tar.gz
tar xzf /tmp/render/payload.tar.gz -C /tmp/render

echo "==> GPU inventory..."
if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi
else
  echo "nvidia-smi not found"
fi
cd /tmp/render/payload

echo "==> Rendering..."
if [[ -x ./render.sh ]]; then
  BLENDER="$BLENDER" SAMPLES="$RENDER_SAMPLES" FFMPEG_BIN="$${FFMPEG_BIN:-ffmpeg}" ./render.sh result.mp4
else
  mkdir -p frames
  "$BLENDER" --background --python render_native_flight.py -- \
    --timeline timeline.json \
    --out result.mp4 \
    --frames-dir frames \
    --samples "$RENDER_SAMPLES"
fi

echo "==> Uploading result to s3://$S3_BUCKET/$S3_RESULT_KEY..."
aws s3 cp result.mp4 "s3://$S3_BUCKET/$S3_RESULT_KEY"
