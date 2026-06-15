// Records the live React viewer in cabin mode, including the surface HUD and cockpit controls.
//
//   npm run clip:controls -- --out clips/control-cockpit-demo.mp4
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { dirname, resolve } from "node:path";
import { chromium } from "@playwright/test";
import { createServer } from "vite";

const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
const secondsIdx = argv.indexOf("--seconds");
const out = resolve(outIdx >= 0 ? argv[outIdx + 1] : "clips/control-cockpit-demo.mp4");
const seconds = secondsIdx >= 0 ? Number(argv[secondsIdx + 1]) : 12;
const width = Number(process.env.CLIP_WIDTH ?? 1280);
const height = Number(process.env.CLIP_HEIGHT ?? 720);

async function transcode(webmPath: string, mp4Path: string): Promise<void> {
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
  const videoDir = resolve("/private/tmp", `flight-control-clip-${process.pid}`);

  const browser = await chromium.launch({
    args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--use-gl=angle", "--use-angle=swiftshader"],
  });
  const context = await browser.newContext({
    viewport: { width, height },
    deviceScaleFactor: 1,
    recordVideo: { dir: videoDir, size: { width, height } },
  });
  const page = await context.newPage();

  try {
    // Force the generated in-browser demo path so this clip always uses the current replay schema,
    // including fresh per-surface telemetry, instead of old sweep JSON from public/matches.
    await page.route("**/matches/index.json", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
    );
    await page.route("**/match.json", (route) =>
      route.fulfill({ status: 404, contentType: "text/plain", body: "not found" }),
    );

    await page.goto(url);
    await page.getByRole("button", { name: "Cabin" }).click({ timeout: 45_000 });
    await page.getByRole("button", { name: "CC" }).click({ timeout: 10_000 });
    await page.getByLabel("Control surface HUD").waitFor({ state: "visible", timeout: 10_000 });
    await page.getByText("AIL L").waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForTimeout(seconds * 1000);

    const video = page.video();
    if (!video) throw new Error("Playwright did not create a video artifact");
    await context.close();
    const webmPath = await video.path();
    await transcode(webmPath, out);
  } finally {
    await browser.close().catch(() => {});
    await server.close();
  }

  console.error(`done -> ${out}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
