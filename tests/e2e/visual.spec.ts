import { expect, test } from "@playwright/test";

test("renders a nonblank flight scene and usable replay controls", async ({ page }) => {
  await page.goto("/");

  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible();
  await expect(page.getByRole("heading", { name: "Physics Turn Lab" })).toBeVisible();
  await expect(page.getByRole("slider", { name: "Replay frame" })).toBeVisible();

  await page.getByRole("button", { name: "Pause replay" }).click();
  await page.getByRole("button", { name: "Next frame" }).click();
  await page.waitForTimeout(500);

  const stats = await canvas.evaluate((node) => {
    const canvasElement = node as HTMLCanvasElement;
    const gl =
      canvasElement.getContext("webgl2") ?? canvasElement.getContext("webgl");

    if (!gl) {
      return {
        width: canvasElement.width,
        height: canvasElement.height,
        saturated: 0,
        swatches: 0,
        total: 0,
      };
    }

    const swatches = new Set<string>();
    let saturated = 0;
    let total = 0;

    for (let y = 0.16; y < 0.86; y += 0.1) {
      for (let x = 0.12; x < 0.9; x += 0.1) {
        const pixel = new Uint8Array(4);
        gl.readPixels(
          Math.floor(canvasElement.width * x),
          Math.floor(canvasElement.height * y),
          1,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixel,
        );
        total += pixel[0] + pixel[1] + pixel[2] + pixel[3];
        swatches.add(`${pixel[0] >> 4}:${pixel[1] >> 4}:${pixel[2] >> 4}`);
        if (Math.max(pixel[0], pixel[1], pixel[2]) - Math.min(pixel[0], pixel[1], pixel[2]) > 18) {
          saturated += 1;
        }
      }
    }

    return {
      width: canvasElement.width,
      height: canvasElement.height,
      saturated,
      swatches: swatches.size,
      total,
    };
  });

  expect(stats.width).toBeGreaterThan(300);
  expect(stats.height).toBeGreaterThan(300);
  expect(stats.total).toBeGreaterThan(0);
  expect(stats.swatches).toBeGreaterThanOrEqual(2);
});

test("opens the hangar with physical surface controls", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Hangar" }).click();
  await expect(page.getByRole("heading", { name: "Build your aircraft" })).toBeVisible();
  await expect(page.getByText("surfaces")).toBeVisible();
  await expect(page.getByText("engines")).toBeVisible();
  await expect(page.getByText("incidence").first()).toBeVisible();
  await expect(page.getByText("x offset").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Fly this ▶" })).toBeVisible();
});

test("shows actual surface telemetry in cabin view", async ({ page }) => {
  await page.route("**/matches/index.json", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: "[]" }),
  );
  await page.route("**/match.json", (route) =>
    route.fulfill({ status: 404, contentType: "text/plain", body: "not found" }),
  );
  await page.goto("/");

  await page.getByRole("button", { name: "Cabin" }).click();
  const hud = page.getByLabel("Control surface HUD");
  await expect(hud).toBeVisible();
  await expect(hud.getByText("AIL L")).toBeVisible();
  await expect(hud.getByText("AIL R")).toBeVisible();
  await expect(hud.getByText("ELEV")).toBeVisible();
  await expect(hud.getByText("RUD", { exact: true })).toBeVisible();
  await expect(hud.getByText("PED")).toBeVisible();
  await expect(hud.getByText("THR")).toBeVisible();
  await expect(hud.getByText(/hinge [+-]?\d+\.\d deg/).first()).toBeVisible();
  await expect(hud.getByText(/ctrl [+-]?\d+\.\d deg/).first()).toBeVisible();
  await expect(hud.getByText(/flow [+-]?\d+\.\d deg/).first()).toBeVisible();
  await expect(hud.getByText(/load \d+(\.\d)? kN/).first()).toBeVisible();

  await page.getByRole("button", { name: "HUD" }).click();
  await expect(hud).toBeHidden();
  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible();
  await page.waitForTimeout(500);
  const cockpitIndicators = await canvas.evaluate((node) => {
    const canvasElement = node as HTMLCanvasElement;
    const gl =
      canvasElement.getContext("webgl2") ?? canvasElement.getContext("webgl");
    if (!gl) return { magenta: 0, cyan: 0 };

    let magenta = 0;
    let cyan = 0;
    for (let y = 0.12; y < 0.92; y += 0.007) {
      for (let x = 0.02; x < 0.86; x += 0.007) {
        const pixel = new Uint8Array(4);
        gl.readPixels(
          Math.floor(canvasElement.width * x),
          Math.floor(canvasElement.height * y),
          1,
          1,
          gl.RGBA,
          gl.UNSIGNED_BYTE,
          pixel,
        );
        if (pixel[0] > 120 && pixel[2] > 120 && pixel[1] < Math.min(pixel[0], pixel[2]) * 0.78) {
          magenta += 1;
        }
        if (pixel[1] > 120 && pixel[2] > 120 && pixel[0] < Math.min(pixel[1], pixel[2]) * 0.78) {
          cyan += 1;
        }
      }
    }
    return { magenta, cyan };
  });
  expect(cockpitIndicators.magenta).toBeGreaterThan(0);
  expect(cockpitIndicators.cyan).toBeGreaterThan(0);

  await page.getByRole("button", { name: "HUD" }).click();
  await expect(hud).toBeVisible();
});
