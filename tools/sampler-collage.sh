#!/usr/bin/env bash
# Sampler collage: render one frame from every camera mode and tile into a labeled grid.
# Usage: tools/sampler-collage.sh [replay.json] [output.png]
set -euo pipefail

FFMPEG="${FFMPEG_BIN:-/usr/local/opt/ffmpeg-full/bin/ffmpeg}"
REPLAY="${1:-reports/coach/missile.json}"
OUT="${2:-clips/sampler-collage.png}"
OUT_DIR="$(dirname "$OUT")"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

MODES=(cinematic chase cockpit director orbit pilot-cinema pilot-hero)

echo "==> Generating ${#MODES[@]} timelines..."
npx tsx src/headless/collageTimelines.ts "$REPLAY" "$WORK/timelines" 2>&1

# Render each timeline.
for mode in "${MODES[@]}"; do
  timeline="$WORK/timelines/${mode}.timeline.json"
  frames_dir="$WORK/frames-${mode}"
  mkdir -p "$frames_dir"

  echo "  [${mode}] rendering..."
  blender --background --python tools/blender/render_native_flight.py -- \
    --timeline "$timeline" \
    --out "$WORK/${mode}.mp4" \
    --frames-dir "$frames_dir" \
    --samples 16 \
    --keep-frames 2>&1 | grep -vE '^Fra:|^fra=|^Info:|^Read|^Append' | tail -1
done

echo "==> Labeling & tiling..."

LABELED=()
for mode in "${MODES[@]}"; do
  src="$WORK/frames-${mode}/frame_000000.png"
  dst="$WORK/${mode}-labeled.png"
  $FFMPEG -y -v error -i "$src" \
    -vf "drawtext=text='${mode}':fontsize=24:fontcolor=white:box=1:boxcolor=black@0.65:boxborderw=8:x=12:y=h-th-12" \
    "$dst"
  LABELED+=("$dst")
done

# 4 top + 3 bottom, centered.
mkdir -p "$OUT_DIR"
$FFMPEG -y -v error \
  -i "${LABELED[0]}" -i "${LABELED[1]}" -i "${LABELED[2]}" -i "${LABELED[3]}" \
  -i "${LABELED[4]}" -i "${LABELED[5]}" -i "${LABELED[6]}" \
  -filter_complex "
    [0:v][1:v][2:v][3:v]hstack=inputs=4[top];
    [4:v][5:v][6:v]hstack=inputs=3[botraw];
    [botraw]pad=iw+1280:ih+44:(ow-iw)/2:44:black[bot];
    [top][bot]vstack=inputs=2
  " \
  "$OUT"

echo "==> Done: $OUT"
echo "    modes: ${MODES[*]}"
