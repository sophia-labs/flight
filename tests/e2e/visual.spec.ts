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
