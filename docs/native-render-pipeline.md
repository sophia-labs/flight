# Native Render Pipeline

This pipeline renders Flight replays without Chromium. The browser viewer remains useful for app QA, but final clips can now go through an engine-native offline path:

```text
MatchReplay JSON -> native render timeline JSON -> Blender scene frames -> ffmpeg MP4
```

## Commands

Export only the deterministic render timeline:

```bash
npm run export:native-timeline -- --replay match.json --timeline-out clips/native.timeline.json
```

Render a replay with Blender:

```bash
npm run render:native -- --replay match.json --camera cinematic --seconds 12 --out clips/native-flight.mp4
```

Generate a deterministic scripted replay and render it in one command:

```bash
npm run render:native -- --turns 8 --seconds 10 --camera cinematic --out clips/native-demo.mp4
```

Useful flags:

- `--camera cinematic|chase|cockpit|orbit|pilot-hero`
- `--avatar public/models/VRM1_Constraint_Twist_Sample.vrm`
- `--fps 24`
- `--width 1280 --height 720`
- `--pilot-id blue-1`
- `--timeline-out clips/run.timeline.json`
- `--frames-dir clips/run.frames`
- `--keep-frames`
- `--blender /path/to/blender`

You can also set `BLENDER=/path/to/blender`.

## Files

- `src/render/nativeTimeline.ts`
  - Pure TypeScript timeline exporter.
  - Samples replay frames at render FPS.
  - Exports aircraft transforms, airframes, controls, surface telemetry, events, and camera poses.

- `src/headless/renderNative.ts`
  - CLI wrapper.
  - Reads an existing replay or generates a deterministic scripted demo.
  - Writes the timeline JSON.
  - Invokes Blender unless `--timeline-only` is set.

- `tools/blender/render_native_flight.py`
  - Blender scene builder.
  - Builds native proxy geometry from recorded airframe parts.
  - Animates aircraft transforms, cockpit controls, moving control surfaces, tracers, and cameras.
  - Renders PNG frames and shells out to ffmpeg for the MP4.

## Remote GPU Render Box

Use the EC2 render box when local Blender turnaround is too slow:

```bash
tools/render-remote.sh clips/full-render/timeline.json clips/remote-render.mp4
```

The script packages the repo-side Blender payload, uploads it as a Terraform-managed S3 object, creates a tagged `g5.xlarge` render instance, waits for the exact result object, downloads the MP4, and leaves S3 artifacts under a 7-day lifecycle rule. Defaults:

- AWS profile/region: `terraform-user` / `us-east-1`
- instance: `g5.xlarge`
- SSH key: `flight-render-vera`
- SSH ingress: caller IP `/32`, autodetected with `checkip.amazonaws.com`
- render samples: `RENDER_SAMPLES=48`
- root volume: `100` GiB for GPU AMIs

Useful overrides:

```bash
INSTANCE_TYPE=g5.2xlarge RENDER_SAMPLES=64 \
  tools/render-remote.sh clips/full-render/timeline.json clips/remote-render.mp4

KEY_NAME= SSH_CIDR= \
  tools/render-remote.sh clips/full-render/timeline.json clips/remote-render.mp4
```

During a run, the script prints direct SSH, SSM Session Manager, and one-shot SSM log commands. Direct log tail:

```bash
ssh ubuntu@<public-ip> 'tail -f /var/log/render.log'
```

### Baked render AMI

The first GPU loop proved that per-run apt, Blender, and ffmpeg setup dominates short renders. Bake those dependencies once:

```bash
tools/bake-render-ami.sh
```

The bake runner launches a temporary `g5.xlarge`, verifies SSH and SSM, runs `terraform/render-host-setup.sh`, stops the box, creates an AMI, terminates the bake box, and writes ignored local config:

```hcl
# terraform/render-ami.auto.tfvars
ami_id = "ami-..."
root_volume_size_gb = 100
```

`terraform/user-data.sh` still embeds the same setup script as an idempotent guard. On a baked AMI it exits after seeing `/opt/flight-render-setup-<blender-version>.stamp`; on a fresh base AMI it installs the missing dependencies before rendering.

Benchmark evidence from the first baked `g5.xlarge` run (`RENDER_SAMPLES=48`, 24 frames):

- output: `1280x720`, `24 fps`, `24 frames`
- first frame: about `44s`
- post-warm frames: about `0.41s/frame`
- end-to-end: about `221s`

## Why This Exists

The old clip path records the React viewer through Chromium screenshots or canvas capture. That is useful for visual smoke tests, but it couples final video output to browser GPU behavior.

The native render path keeps the truth in replay/timeline data and moves final image generation to Blender. It is deterministic, inspectable, and does not depend on `canvas.captureStream`, `MediaRecorder`, or Chromium WebGL readback.

## Current Scope

This first pass renders proxy aircraft and cockpit controls from existing airframe data. It can also mount the sample VRM avatar into the pilot cockpit for `pilot-hero` shots:

```bash
npm run render:native -- --camera pilot-hero --seconds 4 --out clips/native-review-vtuber-topgun.mp4
```

The intended next step is to replace the proxy cockpit/pose with a high-fidelity cockpit and a real seated avatar rig while keeping the same render contract.
