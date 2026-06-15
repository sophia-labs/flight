// Records the live React viewer in cabin mode, including the surface HUD and cockpit controls.
//
//   npm run clip:controls -- --out clips/control-cockpit-demo.mp4
//   npm run clip:controls -- --replay /tmp/body-live.json --out clips/body-live-cockpit.mp4 --seconds 12
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";
import { MatchReplaySchema, type MatchReplay } from "../protocol/schema";

const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
const secondsIdx = argv.indexOf("--seconds");
const replayIdx = argv.indexOf("--replay");
const cameraIdx = argv.indexOf("--camera");
function argValue(index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
const out = resolve(outIdx >= 0 ? argValue(outIdx, "--out") : "clips/control-cockpit-demo.mp4");
const seconds = secondsIdx >= 0 ? Number(argv[secondsIdx + 1]) : 12;
const replayPath = replayIdx >= 0 ? resolve(argValue(replayIdx, "--replay")) : undefined;
const cameraMode = cameraIdx >= 0 ? argValue(cameraIdx, "--camera") : "cabin";
const hudOn = !argv.includes("--no-hud");
const captionsOn = argv.includes("--captions");
const width = Number(process.env.CLIP_WIDTH ?? 1280);
const height = Number(process.env.CLIP_HEIGHT ?? 720);
const fps = Number(process.env.CLIP_FPS ?? 30);

if (cameraMode !== "cabin" && cameraMode !== "orbit") {
  throw new Error("--camera must be cabin or orbit");
}

async function startFfmpeg(mp4Path: string): Promise<ReturnType<typeof spawn>> {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("CLIP_FPS must be a positive number");
  await mkdir(dirname(mp4Path), { recursive: true });
  return spawn(
    "ffmpeg",
    [
      "-y",
      "-f",
      "image2pipe",
      "-framerate",
      String(fps),
      "-i",
      "-",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      mp4Path,
    ],
    { stdio: ["pipe", "ignore", "inherit"] },
  );
}

async function main(): Promise<void> {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error("--seconds must be a positive number");
  }

  const server = await createServer({
    root: process.cwd(),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();

  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Vite did not expose a local port");
  const url = `http://127.0.0.1:${(address as AddressInfo).port}/`;

  const browser = await chromium.launch({
    args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--use-gl=angle", "--use-angle=swiftshader"],
  });
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
  });
  const page = await context.newPage();
  const replay = replayPath ? await readReplay(replayPath) : undefined;
  const replayJson = replay ? JSON.stringify(replay) : undefined;
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));

  try {
    // Keep the match browser out of capture. With --replay, /match.json is the exact replay under
    // test; without --replay, 404 keeps the generated in-browser demo path.
    await page.route("**/matches/index.json", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
    );
    await page.route("**/match.json", (route) => {
      if (replayJson) {
        return route.fulfill({ status: 200, contentType: "application/json", body: replayJson });
      } else {
        return route.fulfill({ status: 404, contentType: "text/plain", body: "not found" });
      }
    });

    const params = new URLSearchParams({
      camera: cameraMode,
      hud: hudOn ? "1" : "0",
      captions: captionsOn ? "1" : "0",
    });
    await page.goto(`${url}?${params.toString()}`);
    await page.getByRole("slider", { name: "Replay frame" }).waitFor({ state: "visible", timeout: 45_000 });
    await page.locator("canvas").first().waitFor({ state: "visible", timeout: 10_000 });
    if (replay) {
      await page.waitForFunction(
        () =>
          typeof (window as unknown as { __flightSetReplayPosition?: unknown }).__flightSetReplayPosition ===
          "function",
        undefined,
        { timeout: 10_000 },
      );
    }
    if (cameraMode === "cabin" && hudOn) {
      await page.getByLabel("Control surface HUD").waitFor({ state: "visible", timeout: 10_000 });
      await page.getByText("AIL L").waitFor({ state: "visible", timeout: 10_000 });
    }
    if (pageErrors.length > 0) throw new Error(`viewer page error: ${pageErrors[0]}`);

    const frameCount = Math.max(1, Math.round(seconds * fps));
    const ff = await startFfmpeg(out);
    const ffDone = once(ff, "close");
    for (let i = 0; i < frameCount; i += 1) {
      if (i % Math.max(1, fps) === 0) console.error(`capture frame ${i}/${frameCount}`);
      if (replay) {
        const maxIndex = Math.max(1, replay.frames.length - 1);
        const position = ((i / fps) / replay.frameDt) % maxIndex;
        await page.evaluate((nextPosition) => {
          (window as unknown as { __flightSetReplayPosition?: (position: number) => void }).__flightSetReplayPosition?.(
            nextPosition,
          );
        }, position);
        await page.waitForTimeout(0);
      }
      const png = await page.screenshot({ type: "png", timeout: 10_000 });
      if (!ff.stdin!.write(png)) await once(ff.stdin!, "drain");
      if (!replay) await page.waitForTimeout(1000 / fps);
    }
    ff.stdin!.end();
    const [code] = (await ffDone) as [number];
    if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
    await context.close();
  } finally {
    await browser.close().catch(() => {});
    await server.close();
  }

  console.error(`done -> ${out}`);
}

async function readReplay(path: string): Promise<MatchReplay> {
  const raw = await readFile(path, "utf8");
  return MatchReplaySchema.parse(JSON.parse(raw));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
