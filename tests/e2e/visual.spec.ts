import { expect, test } from "@playwright/test";

test("renders the VTuber Flight Studio first screen", async ({ page }) => {
  await page.goto("/");

  const canvas = page.locator("canvas").first();
  await expect(canvas).toBeVisible();
  await expect(page.getByText("VTuber Flight Studio")).toBeVisible();
  await expect(page.getByRole("button", { name: "Hangar" })).toHaveClass(/active/);
  await expect(page.getByRole("button", { name: "Crew" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Launch/ })).toBeVisible();
  await expect(page.getByLabel("VTuber Flight Studio").getByText("Echo").first()).toBeVisible();
  await expect(page.getByLabel("Flight envelope")).toBeVisible();
  await expect(page.getByText("High-speed energy fighter")).toBeVisible();
  await expect(page.getByText("service ceiling")).toBeVisible();
  await expect(page.getByText("Head clearance")).toBeVisible();
  await expect(page.getByText("Right hand")).toBeVisible();

  const stats = await canvas.evaluate((node) => {
    const canvasElement = node as HTMLCanvasElement;
    const gl =
      canvasElement.getContext("webgl2") ?? canvasElement.getContext("webgl");

    if (!gl) {
      return {
        height: canvasElement.height,
        swatches: 0,
        total: 0,
        width: canvasElement.width,
      };
    }

    const swatches = new Set<string>();
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
      }
    }

    return {
      height: canvasElement.height,
      swatches: swatches.size,
      total,
      width: canvasElement.width,
    };
  });

  expect(stats.width).toBeGreaterThan(300);
  expect(stats.height).toBeGreaterThan(300);
  expect(stats.total).toBeGreaterThan(0);
  expect(stats.swatches).toBeGreaterThanOrEqual(2);
});

test("opens Crew as a pilot loadout and customization screen with a VRM preview", async ({ page }) => {
  test.setTimeout(90_000);

  await page.goto("/");

  await page.getByRole("button", { name: "Crew" }).click();
  await expect(page.getByRole("button", { name: "Crew" })).toHaveClass(/active/);
  await expect(page.getByText("Pilot Loadout")).toBeVisible();
  await expect(page.getByText("Appearance")).toBeVisible();
  await expect(page.getByText("Profile")).toBeVisible();
  await expect(page.getByText("Model Core")).toBeVisible();
  await expect(page.getByLabel("VTuber Flight Studio").getByText("VRM Gear").first()).toBeVisible();
  await expect(page.getByLabel("VTuber Flight Studio").getByText("Echo").first()).toBeVisible();
  await expect(page.getByRole("button", { name: /Khronos Flight Helmet/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Flight Headset/ })).toHaveClass(/active/);
  await expect(page.getByRole("button", { name: "Hair #83d4ff" })).toBeVisible();
  await page.getByRole("button", { name: "Hair #83d4ff" }).click();
  await page.getByRole("button", { name: "Eyes #59d894" }).click();
  await page.getByRole("button", { name: "Test Pilot" }).click();
  await page.getByRole("button", { name: "Instructor" }).click();
  await page.getByRole("button", { name: /Khronos Flight Helmet/ }).click();
  await page.getByRole("button", { name: /Data Gloves/ }).click();
  await expect(page.getByRole("button", { name: "Test Pilot" })).toHaveClass(/active/);
  await expect(page.getByRole("button", { name: "Instructor" })).toHaveClass(/active/);
  await expect(page.getByRole("button", { name: /Khronos Flight Helmet/ })).toHaveClass(/active/);
  await expect(page.getByRole("button", { name: /Flight Headset/ })).not.toHaveClass(/active/);
  await expect(page.getByRole("button", { name: /Data Gloves/ })).toHaveClass(/active/);

  await page.waitForFunction(
    () => {
      const rig = (window as unknown as {
        __flightPilotRig?: {
          loaded: boolean;
          root: [number, number, number] | null;
          station: { source: string } | null;
          wearables?: string[];
        };
      }).__flightPilotRig;
      return Boolean(
        rig?.loaded &&
          rig.root &&
          rig.station === null &&
          rig.wearables?.includes("khronos-flight-helmet") &&
          rig.wearables?.includes("data-gloves") &&
          !rig.wearables?.includes("flight-headset"),
      );
    },
    undefined,
    { timeout: 30_000 },
  );
});

test("opens the advanced builder from the studio screen", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Edit build" }).click();
  await expect(page.getByRole("heading", { name: "Build your aircraft" })).toBeVisible();
  await expect(page.getByText("PART KIT")).toBeVisible();
  await expect(page.getByText("PROP CURVE")).toBeVisible();
  await expect(page.getByText("surfaces")).toBeVisible();
  await expect(page.getByText("engines")).toBeVisible();
  await expect(page.getByRole("button", { name: /wing variable-sweep-wing/i })).toBeVisible();
  await page.getByRole("button", { name: /CREW-STATION pilot-station/i }).click();
  await expect(page.getByText("pilot socket")).toBeVisible();
  await expect(page.getByRole("button", { name: "Fly this ▶" })).toBeVisible();
});

test("exposes motor tape scenario tuning in Scene mode", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: "Scene" }).click();
  await expect(page.getByRole("button", { name: "Scene" })).toHaveClass(/active/);
  await expect(page.getByRole("button", { name: "Run Scenario" })).toBeVisible();
  await expect(page.getByText("Loop").first()).toBeVisible();

  await page.getByRole("button", { name: "Motor Tape" }).click();
  await expect(page.getByRole("button", { name: "Motor Tape" })).toHaveClass(/active/);
  await expect(page.getByText("Hard Balloon").first()).toBeVisible();
  await expect(page.getByText("Planner").first()).toBeVisible();
  await expect(page.getByText("Twitch").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "DeepSeek V4 Pro" })).toHaveClass(/active/);
  await expect(page.locator("button.active").filter({ hasText: "DeepSeek V4 Flash" })).toBeVisible();
  await expect(page.getByText("Tape").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "2.5s" })).toHaveClass(/active/);
  await expect(page.getByText("Step").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "50ms" })).toHaveClass(/active/);
  await expect(page.getByText("Slow").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "0.35x" })).toHaveClass(/active/);
});

test("launches a replay from the studio and shows cabin surface telemetry", async ({ page }) => {
  await page.goto("/");

  await page.getByRole("button", { name: /Launch/ }).click();
  await expect(page.getByRole("button", { name: "Pause replay" })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("button", { name: "Replay", exact: true })).toHaveClass(/active/);
  await expect(page.getByRole("slider", { name: "Replay frame" })).toBeVisible();

  await page.getByRole("button", { name: "Cabin" }).click();

  const hud = page.getByLabel("Control surface HUD");
  await expect(hud).toBeVisible();
  await expect(hud.getByText("AIL L")).toBeVisible();
  await expect(hud.getByText("AIL R")).toBeVisible();
  await expect(hud.getByText("ELEV")).toBeVisible();
  await expect(hud.getByText("RUD", { exact: true }).first()).toBeVisible();
  await expect(hud.getByText("PED")).toBeVisible();
  await expect(hud.getByText("THR")).toBeVisible();
  await expect(hud.getByText(/hinge [+-]?\d+\.\d deg/).first()).toBeVisible();
  await expect(hud.getByText(/ctrl [+-]?\d+\.\d deg/).first()).toBeVisible();
  await expect(hud.getByText(/flow [+-]?\d+\.\d deg/).first()).toBeVisible();
  await expect(hud.getByText(/load \d+(\.\d)? kN/).first()).toBeVisible();

  const bodyAudit = page.getByLabel("Body audit");
  await bodyAudit.scrollIntoViewIfNeeded();
  await expect(bodyAudit).toBeVisible();
  await expect(bodyAudit.getByText("Body Loop")).toBeVisible();
  await expect(bodyAudit.getByText("Muscle")).toBeVisible();
  await expect(bodyAudit.getByText("Motion")).toBeVisible();
});

test("runs the scripted pilot cinema camera with a rigged VTuber", async ({ page }) => {
  await page.goto("/?camera=pilot-cinema&hud=0");

  await page.getByRole("button", { name: /Launch/ }).click();
  await expect(page.getByRole("button", { name: "Pilot", exact: true })).toHaveClass(/active/, { timeout: 30_000 });
  await page.locator("canvas").first().waitFor({ state: "visible", timeout: 10_000 });
  await page.waitForFunction(
    () => {
      const rig = (window as unknown as {
        __flightPilotRig?: {
          contactErrors: Record<string, number | null>;
          loaded: boolean;
          root: [number, number, number] | null;
          station: { canopyId: string | null; source: string } | null;
        };
      }).__flightPilotRig;
      return Boolean(rig?.loaded && rig.root && rig.station?.source === "crew-station");
    },
    undefined,
    { timeout: 30_000 },
  );

  const rig = await page.evaluate(() => {
    return (window as unknown as {
      __flightPilotRig?: {
        contactErrors: Record<string, number | null>;
        loaded: boolean;
        root: [number, number, number] | null;
        station: { canopyId: string | null; source: string } | null;
      };
    }).__flightPilotRig;
  });

  expect(rig?.loaded).toBe(true);
  expect(rig?.root).toHaveLength(3);
  expect(rig?.station?.source).toBe("crew-station");
  expect(rig?.station?.canopyId).toBe("canopy");
  expect(rig?.contactErrors.rightHand ?? 1).toBeLessThan(0.09);
  expect(rig?.contactErrors.leftHand ?? 1).toBeLessThan(0.09);
});
