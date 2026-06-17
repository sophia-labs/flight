#!/usr/bin/env bash
# Package a render payload for offloading to a remote Blender box.
# Usage: tools/render-payload.sh [timeline.json] [output.tar.gz]
# Produces a self-contained tarball. On the remote box: tar xzf payload.tar.gz && bash render.sh
set -euo pipefail

TIMELINE="${1:-clips/test-render/timeline.json}"
OUT="${2:-clips/render-payload.tar.gz}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

PAYLOAD_DIR="$WORK/payload"
mkdir -p "$PAYLOAD_DIR"

# Core files
cp "$TIMELINE" "$PAYLOAD_DIR/timeline.json"
cp tools/blender/render_native_flight.py "$PAYLOAD_DIR/render_native_flight.py"

# VRM avatar (used by pilot-hero / pilot-cinema modes). Preserve the repo-relative
# path because timelines reference public/models/... directly.
AVATAR="public/models/VRM1_Constraint_Twist_Sample.vrm"
if [[ -f "$AVATAR" ]]; then
  mkdir -p "$PAYLOAD_DIR/$(dirname "$AVATAR")"
  cp "$AVATAR" "$PAYLOAD_DIR/$AVATAR"
fi

# Remote render script
cat > "$PAYLOAD_DIR/render.sh" << 'RENDER_SCRIPT'
#!/usr/bin/env bash
set -euo pipefail
BLENDER="${BLENDER:-blender}"
FFMPEG="${FFMPEG_BIN:-ffmpeg}"
OUT="${1:-output.mp4}"
FRAMES_DIR="$(mktemp -d)"
trap 'rm -rf "$FRAMES_DIR"' EXIT

"$BLENDER" --background --python render_native_flight.py -- \
  --timeline timeline.json \
  --out "$OUT" \
  --frames-dir "$FRAMES_DIR" \
  --samples "${SAMPLES:-48}"

echo "Done: $OUT"
ls -lh "$OUT"
RENDER_SCRIPT
chmod +x "$PAYLOAD_DIR/render.sh"

# README
CAMERA=$(jq -r '.cameraMode // "unknown"' "$PAYLOAD_DIR/timeline.json")
FRAMES=$(jq '.frames | length' "$PAYLOAD_DIR/timeline.json")
FPS=$(jq '.fps' "$PAYLOAD_DIR/timeline.json")
cat > "$PAYLOAD_DIR/README.txt" << EOF
Render payload
==============
Camera mode: $CAMERA
Frames: $FRAMES at ${FPS}fps

Remote render:
  tar xzf payload.tar.gz
  SAMPLES=48 bash render.sh output.mp4

Requirements:
  - Blender ≥4.0 (EEVEE renderer)
  - ffmpeg (with libx264)
EOF

# Package
mkdir -p "$(dirname "$OUT")"
COPYFILE_DISABLE=1 tar --format ustar -czf "$OUT" -C "$WORK" payload
echo "Packaged: $OUT ($(du -h "$OUT" | cut -f1))"
echo "Remote: scp $OUT user@box: && ssh user@box 'tar xzf $(basename "$OUT") && cd payload && bash render.sh'"
