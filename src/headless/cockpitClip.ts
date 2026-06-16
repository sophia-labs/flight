// Records the live React viewer in cockpit/cinematic modes.
//
//   npm run clip:controls -- --out clips/control-cockpit-demo.mp4
//   npm run clip:controls -- --replay /tmp/body-live.json --out clips/body-live-cockpit.mp4 --seconds 12
//   npm run clip:controls -- --camera pilot-cinema --out clips/pilot-cinema.mp4 --seconds 16
//   npm run clip:controls -- --camera pilot-cinema --capture stream --out clips/pilot-cinema-stream.mp4
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
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
const captureIdx = argv.indexOf("--capture");
function argValue(index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
const out = resolve(outIdx >= 0 ? argValue(outIdx, "--out") : "clips/control-cockpit-demo.mp4");
const seconds = secondsIdx >= 0 ? Number(argv[secondsIdx + 1]) : 12;
const replayPath = replayIdx >= 0 ? resolve(argValue(replayIdx, "--replay")) : undefined;
const cameraMode = cameraIdx >= 0 ? argValue(cameraIdx, "--camera") : "cabin";
const captureMode = captureIdx >= 0 ? argValue(captureIdx, "--capture") : "data-url";
const hudOn = !argv.includes("--no-hud");
const captionsOn = argv.includes("--captions");
const width = Number(process.env.CLIP_WIDTH ?? 1280);
const height = Number(process.env.CLIP_HEIGHT ?? 720);
const fps = Number(process.env.CLIP_FPS ?? 30);
const videoBitsPerSecond = Number(process.env.CLIP_VIDEO_BITS_PER_SECOND ?? 8_000_000);
const keepWebm = argv.includes("--keep-webm");

if (cameraMode !== "cabin" && cameraMode !== "orbit" && cameraMode !== "pilot-cinema") {
  throw new Error("--camera must be cabin, orbit, or pilot-cinema");
}
if (captureMode !== "data-url" && captureMode !== "stream") {
  throw new Error("--capture must be data-url or stream");
}

async function startImagePipeFfmpeg(mp4Path: string): Promise<ReturnType<typeof spawn>> {
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

async function transcodeWebmToMp4(webmPath: string, mp4Path: string): Promise<void> {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error("CLIP_FPS must be a positive number");
  await mkdir(dirname(mp4Path), { recursive: true });
  const ff = spawn(
    "ffmpeg",
    [
      "-y",
      "-i",
      webmPath,
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      mp4Path,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  const [code] = (await once(ff, "close")) as [number];
  if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
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
    const webmPath = `${out}.webm`;
    const webm = captureMode === "stream" ? createWriteStream(webmPath) : null;
    let recordedBytes = 0;
    let recordedChunks = 0;

    if (webm) {
      await mkdir(dirname(webmPath), { recursive: true });
      await page.exposeBinding("__flightClipChunk", async (_source, base64: string) => {
        const chunk = Buffer.from(base64, "base64");
        recordedBytes += chunk.byteLength;
        recordedChunks += 1;
        if (!webm.write(chunk)) await once(webm, "drain");
      });
    }

    await page.goto(`${url}?${params.toString()}`);
    await page.getByRole("slider", { name: "Replay frame" }).waitFor({ state: "visible", timeout: 45_000 });
    const canvas = page.locator("canvas").first();
    await canvas.waitFor({ state: "visible", timeout: 10_000 });
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
    if (cameraMode === "pilot-cinema") {
      await page.waitForFunction(
        () =>
          Boolean(
            (window as unknown as {
              __flightPilotRig?: { loaded: boolean; root: [number, number, number] | null };
            }).__flightPilotRig?.loaded,
          ),
        undefined,
        { timeout: 30_000 },
      );
    }
    if (pageErrors.length > 0) throw new Error(`viewer page error: ${pageErrors[0]}`);

    if (captureMode === "stream") {
      if (!webm) throw new Error("Stream capture was not initialized");
      console.error(`record canvas stream ${seconds}s @ ${fps}fps`);
      const recordDiagnostics = await page.evaluate(
        recordCanvasStreamScript({ bitsPerSecond: videoBitsPerSecond, captureFps: fps, seconds }),
      );
      await new Promise<void>((resolve, reject) => {
        webm.once("error", reject);
        webm.end(() => resolve());
      });
      if (recordedChunks === 0 || recordedBytes === 0) {
        throw new Error(`MediaRecorder did not produce any video chunks: ${JSON.stringify(recordDiagnostics)}`);
      }
      console.error(`recorded ${recordedChunks} chunks (${(recordedBytes / 1024 / 1024).toFixed(1)} MiB)`);
      if (pageErrors.length > 0) throw new Error(`viewer page error: ${pageErrors[0]}`);
      await transcodeWebmToMp4(webmPath, out);
      if (!keepWebm) {
        await rm(webmPath, { force: true });
      }
    } else {
      const frameCount = Math.max(1, Math.round(seconds * fps));
      const ff = await startImagePipeFfmpeg(out);
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
        const dataUrl = await canvas.evaluate((node) => {
          const canvas = node as HTMLCanvasElement;
          return canvas.toDataURL("image/jpeg", 0.92);
        });
        const image = Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
        if (!ff.stdin!.write(image)) await once(ff.stdin!, "drain");
        if (!replay) await page.waitForTimeout(1000 / fps);
      }
      ff.stdin!.end();
      const [code] = (await ffDone) as [number];
      if (code !== 0) throw new Error(`ffmpeg exited ${code}`);
    }
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

function recordCanvasStreamScript({
  bitsPerSecond,
  captureFps,
  seconds,
}: {
  bitsPerSecond: number;
  captureFps: number;
  seconds: number;
}): string {
  return `
    (async () => {
      const captureFps = ${JSON.stringify(captureFps)};
      const captureSeconds = ${JSON.stringify(seconds)};
      const bitsPerSecond = ${JSON.stringify(bitsPerSecond)};
      const canvas = document.querySelector("canvas");
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error("No canvas found for recording");
      if (typeof canvas.captureStream !== "function") {
        throw new Error("This browser does not support canvas.captureStream()");
      }
      if (typeof MediaRecorder === "undefined") {
        throw new Error("This browser does not support MediaRecorder");
      }

      const mimeType = [
        "video/webm;codecs=vp8",
        "video/webm;codecs=vp9",
        "video/webm",
      ].find((candidate) => MediaRecorder.isTypeSupported(candidate)) || "";
      const stream = canvas.captureStream(captureFps);
      const track = stream.getVideoTracks()[0];
      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: bitsPerSecond,
      });
      const sendChunk = window.__flightClipChunk;
      if (!sendChunk) throw new Error("Clip chunk sink was not installed");

      const blobToBase64 = async (blob) => {
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const chunkSize = 0x8000;
        let binary = "";
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
          binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
        }
        return btoa(binary);
      };

      let dataEvents = 0;
      let nonEmptyDataEvents = 0;
      await new Promise((resolve, reject) => {
        const pendingChunks = [];
        const frameIntervalMs = Math.max(1, Math.round(1000 / Math.max(captureFps, 1)));
        let frameTimer = 0;
        recorder.addEventListener("dataavailable", (event) => {
          dataEvents += 1;
          if (event.data.size === 0) return;
          nonEmptyDataEvents += 1;
          pendingChunks.push(blobToBase64(event.data).then(sendChunk));
        });
        recorder.addEventListener("error", () => reject(new Error("MediaRecorder failed")));
        recorder.addEventListener("stop", () => {
          if (frameTimer) window.clearInterval(frameTimer);
          Promise.all(pendingChunks).then(resolve, reject);
        }, { once: true });
        recorder.start(500);
        frameTimer = window.setInterval(() => track?.requestFrame?.(), frameIntervalMs);
        track?.requestFrame?.();
        window.setTimeout(() => {
          if (recorder.state === "recording") {
            if (frameTimer) window.clearInterval(frameTimer);
            track?.requestFrame?.();
            recorder.requestData();
            recorder.stop();
          }
        }, Math.ceil(captureSeconds * 1000));
      });

      for (const track of stream.getTracks()) {
        track.stop();
      }
      return {
        canvasHeight: canvas.height,
        canvasWidth: canvas.width,
        dataEvents,
        mimeType: recorder.mimeType,
        nonEmptyDataEvents,
        trackCount: stream.getTracks().length,
        videoTrackCount: stream.getVideoTracks().length,
      };
    })()
  `;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
