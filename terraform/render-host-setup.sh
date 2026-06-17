#!/usr/bin/env bash
# Idempotent setup for EC2 render hosts. Bake this into an AMI, then re-run at
# boot as a cheap guard when the AMI already has Blender, ffmpeg, and libs.
set -euo pipefail

BLENDER_VERSION="${BLENDER_VERSION:-4.2.0}"
BLENDER_MAJOR="${BLENDER_VERSION%.*}"
BLENDER_DIR="/opt/blender-${BLENDER_VERSION}-linux-x64"
BLENDER="${BLENDER_DIR}/blender"
MARKER="/opt/flight-render-setup-${BLENDER_VERSION}.stamp"
FFMPEG_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"
BLENDER_URL="https://mirrors.ocf.berkeley.edu/blender/release/Blender${BLENDER_MAJOR}/blender-${BLENDER_VERSION}-linux-x64.tar.xz"

have_render_setup() {
  [[ -f "$MARKER" ]] && \
    [[ -x "$BLENDER" ]] && \
    command -v aws >/dev/null 2>&1 && \
    command -v ffmpeg >/dev/null 2>&1 && \
    command -v ffprobe >/dev/null 2>&1
}

if have_render_setup; then
  echo "==> Render host setup already present: $MARKER"
  if command -v nvidia-smi >/dev/null 2>&1; then
    nvidia-smi
  else
    echo "nvidia-smi not found"
  fi
  exit 0
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "render-host-setup must run as root" >&2
  exit 1
fi

echo "==> Installing render host dependencies..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq \
  awscli \
  ca-certificates \
  libegl1 \
  libgl1 \
  libsm6 \
  libx11-6 \
  libxfixes3 \
  libxi6 \
  libxkbcommon0 \
  libxrender1 \
  libxxf86vm1 \
  unzip \
  wget \
  xz-utils > /dev/null

if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  echo "==> Installing static ffmpeg..."
  wget -q "$FFMPEG_URL" -O /tmp/ffmpeg.tar.xz
  tar xf /tmp/ffmpeg.tar.xz -C /usr/local/bin --strip-components=1 \
    --wildcards '*/ffmpeg' '*/ffprobe'
fi

if [[ ! -x "$BLENDER" ]]; then
  echo "==> Installing Blender $BLENDER_VERSION..."
  rm -rf "$BLENDER_DIR"
  wget -q "$BLENDER_URL" -O /tmp/blender.tar.xz
  tar xf /tmp/blender.tar.xz -C /opt
fi

if command -v nvidia-smi >/dev/null 2>&1; then
  echo "==> GPU inventory..."
  nvidia-smi
else
  echo "nvidia-smi not found"
fi

"$BLENDER" --version
ffmpeg -version
sync
touch "$MARKER"
echo "==> Render host setup complete: $MARKER"
