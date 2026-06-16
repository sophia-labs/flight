import type { AddressInfo } from "node:net";
import { chromium, type Browser } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";

interface ProbeVariant {
  label: string;
  params: Record<string, string>;
}

interface RecorderProbeResult {
  canvas: {
    clientHeight: number;
    clientWidth: number;
    height: number;
    width: number;
  };
  dataUrl: {
    length: number;
    ms: number;
  };
  mediaRecorder: {
    dataEvents: number;
    mimeType: string;
    nonEmptyEvents: number;
    sizes: number[];
    supported: string[];
    trackCount: number;
    videoTrackCount: number;
  };
  pilotProbe?: unknown;
}

const launchArgs = [
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
  "--use-gl=angle",
  "--use-angle=swiftshader",
];
const recordMs = Number(process.env.PROBE_CAPTURE_MS ?? 3_000);

const variants: ProbeVariant[] = [
  { label: "cabin-no-avatar", params: { camera: "cabin" } },
  { label: "capture-safe-default", params: { camera: "pilot-cinema" } },
  { label: "original-vrm-shader", params: { camera: "pilot-cinema", pilotMaterial: "vrm" } },
  { label: "avatar-hidden", params: { camera: "pilot-cinema", pilotVisible: "0" } },
  { label: "basic-material", params: { camera: "pilot-cinema", pilotMaterial: "basic" } },
  { label: "standard-material", params: { camera: "pilot-cinema", pilotMaterial: "standard" } },
  {
    label: "basic-no-morphs",
    params: { camera: "pilot-cinema", pilotMaterial: "basic", pilotMorphs: "strip" },
  },
  { label: "vrm-no-morphs", params: { camera: "pilot-cinema", pilotMaterial: "vrm", pilotMorphs: "strip" } },
  { label: "vrm-no-shadows", params: { camera: "pilot-cinema", pilotMaterial: "vrm", pilotShadows: "0" } },
  {
    label: "no-expressions",
    params: { camera: "pilot-cinema", pilotMaterial: "vrm", pilotExpressions: "0", pilotLookAt: "0" },
  },
  { label: "no-vrm-update", params: { camera: "pilot-cinema", pilotMaterial: "vrm", pilotVrmUpdate: "0" } },
  { label: "no-ik", params: { camera: "pilot-cinema", pilotMaterial: "vrm", pilotIk: "0" } },
  { label: "mesh-limit-0", params: { camera: "pilot-cinema", pilotMaterial: "vrm", pilotMeshLimit: "0" } },
  { label: "mesh-limit-1", params: { camera: "pilot-cinema", pilotMaterial: "vrm", pilotMeshLimit: "1" } },
  { label: "mesh-limit-1-basic", params: { camera: "pilot-cinema", pilotMeshLimit: "1", pilotMaterial: "basic" } },
  { label: "mesh-limit-1-no-morphs", params: { camera: "pilot-cinema", pilotMaterial: "vrm", pilotMeshLimit: "1", pilotMorphs: "strip" } },
  { label: "mesh-limit-2", params: { camera: "pilot-cinema", pilotMaterial: "vrm", pilotMeshLimit: "2" } },
  { label: "mesh-limit-4", params: { camera: "pilot-cinema", pilotMaterial: "vrm", pilotMeshLimit: "4" } },
];

async function main() {
  const server = await createServer({
    root: process.cwd(),
    logLevel: "silent",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();

  const address = server.httpServer?.address();
  if (!address || typeof address === "string") throw new Error("Vite did not expose a local port");
  const baseUrl = `http://127.0.0.1:${(address as AddressInfo).port}/`;

  const browser = await chromium.launch({ args: launchArgs });
  try {
    const rows = [];
    for (const variant of variants) {
      const result = await runVariant(browser, baseUrl, variant);
      const nonEmpty = result.mediaRecorder.nonEmptyEvents;
      rows.push({
        variant: variant.label,
        ok: nonEmpty > 0,
        sizes: result.mediaRecorder.sizes.join(","),
        visibleMeshes: probeNumber(result.pilotProbe, "visibleMeshCount"),
        material: probeString(result.pilotProbe, "config.material"),
        morphs: probeString(result.pilotProbe, "config.morphs"),
      });
      console.error(`${variant.label}: ${nonEmpty > 0 ? "ok" : "zero"} [${result.mediaRecorder.sizes.join(", ")}]`);
    }
    console.table(rows);
  } finally {
    await browser.close().catch(() => {});
    await closeServer(server);
  }
}

async function runVariant(browser: Browser, baseUrl: string, variant: ProbeVariant): Promise<RecorderProbeResult> {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  });
  try {
    await page.route("**/matches/index.json", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
    );
    await page.route("**/match.json", (route) =>
      route.fulfill({ status: 404, contentType: "text/plain", body: "not found" }),
    );

    const params = new URLSearchParams({
      hud: "0",
      ...variant.params,
    });
    await page.goto(`${baseUrl}?${params.toString()}`);
    await page.getByRole("slider", { name: "Replay frame" }).waitFor({ state: "visible", timeout: 45_000 });
    if (variant.params.camera !== "cabin") {
      await page.waitForFunction(
        () => Boolean((window as { __flightPilotRig?: { loaded: boolean } }).__flightPilotRig?.loaded),
        undefined,
        { timeout: 30_000 },
      );
    }

    return await page.evaluate(async (durationMs) => {
      const canvas = document.querySelector("canvas");
      if (!(canvas instanceof HTMLCanvasElement)) throw new Error("missing flight canvas");

      const supported = [
        "video/webm;codecs=vp8",
        "video/webm;codecs=vp9",
        "video/webm",
      ].filter((mimeType) => MediaRecorder.isTypeSupported(mimeType));
      const stream = canvas.captureStream(12);
      const trackCount = stream.getTracks().length;
      const videoTrackCount = stream.getVideoTracks().length;
      const recorder = new MediaRecorder(stream, {
        mimeType: supported[0] ?? "",
        videoBitsPerSecond: 2_000_000,
      });
      const sizes: number[] = [];

      await new Promise<void>((resolve, reject) => {
        recorder.addEventListener("dataavailable", (event) => sizes.push(event.data.size));
        recorder.addEventListener("error", () => reject(new Error("MediaRecorder error")));
        recorder.addEventListener("stop", () => resolve(), { once: true });
        recorder.start(500);
        setTimeout(() => {
          recorder.requestData();
          recorder.stop();
        }, durationMs);
      });
      stream.getTracks().forEach((track) => track.stop());

      return {
        canvas: {
          clientHeight: canvas.clientHeight,
          clientWidth: canvas.clientWidth,
          height: canvas.height,
          width: canvas.width,
        },
        dataUrl: {
          length: 0,
          ms: 0,
        },
        mediaRecorder: {
          dataEvents: sizes.length,
          mimeType: recorder.mimeType,
          nonEmptyEvents: sizes.filter((size) => size > 0).length,
          sizes,
          supported,
          trackCount,
          videoTrackCount,
        },
        pilotProbe: (window as { __flightPilotRig?: { probe?: unknown } }).__flightPilotRig?.probe,
      };
    }, recordMs);
  } finally {
    await page.close().catch(() => {});
  }
}

async function closeServer(server: ViteDevServer) {
  await new Promise<void>((resolve, reject) => {
    server.httpServer?.close((error) => (error ? reject(error) : resolve()));
  }).catch(() => {});
  await server.close();
}

function probeNumber(value: unknown, path: string): number | null {
  const found = probeValue(value, path);
  return typeof found === "number" ? found : null;
}

function probeString(value: unknown, path: string): string | null {
  const found = probeValue(value, path);
  return typeof found === "string" ? found : null;
}

function probeValue(value: unknown, path: string): unknown {
  let current = value;
  for (const part of path.split(".")) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
