import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { buildNativeRenderTimeline, type NativeCameraMode } from "../render/nativeTimeline.js";

const replayPath = process.argv[2] ?? "reports/coach/missile.json";
const outDir = process.argv[3] ?? "clips/sampler-collage";

const MODES: NativeCameraMode[] = [
  "cinematic", "chase", "cockpit", "director", "orbit",
  "pilot-cinema", "pilot-hero",
];

const replay = JSON.parse(readFileSync(replayPath, "utf8"));
mkdirSync(outDir, { recursive: true });

for (const mode of MODES) {
  const t = buildNativeRenderTimeline(replay, {
    fps: 1,
    seconds: 1,
    cameraMode: mode,
    avatarPath: "public/models/VRM1_Constraint_Twist_Sample.vrm",
  });
  const path = join(outDir, `${mode}.timeline.json`);
  writeFileSync(path, JSON.stringify(t));
  console.log(`wrote ${path} (shot: ${t.frames[0]?.camera.shot})`);
}
console.log(`done — ${MODES.length} timelines in ${outDir}/`);
