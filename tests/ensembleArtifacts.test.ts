import { describe, expect, it } from "vitest";
import { ensembleArtifactPaths, safeModelSlug } from "../src/headless/ensembleArtifacts";

describe("ensemble artifact paths", () => {
  it("uses the model slug for cockpit, sensor, replay, and transcript outputs", () => {
    expect(safeModelSlug("deepseek/deepseek-v4-flash")).toBe("deepseek-deepseek-v4-flash");

    const paths = ensembleArtifactPaths({
      model: "deepseek/deepseek-v4-flash",
      bodyModel: "deepseek/deepseek-v4-flash",
    });

    expect(paths.slug).toBe("deepseek-deepseek-v4-flash");
    expect(paths.cockpitOut).toMatch(/clips\/deepseek-deepseek-v4-flash-ensemble-cockpit\.mp4$/);
    expect(paths.sensorOut).toMatch(/clips\/deepseek-deepseek-v4-flash-ensemble-sensor\.mp4$/);
    expect(paths.replayOut).toMatch(/clips\/deepseek-deepseek-v4-flash-ensemble-replay\.json$/);
    expect(paths.transcriptOut).toMatch(/clips\/deepseek-deepseek-v4-flash-ensemble-transcript\.md$/);
  });

  it("includes the Body model when Pilot and Body differ", () => {
    const paths = ensembleArtifactPaths({
      model: "pilot/model",
      bodyModel: "body/model",
      transcriptOut: "clips/custom.md",
    });

    expect(paths.slug).toBe("pilot-model-body-body-model");
    expect(paths.transcriptOut).toMatch(/clips\/custom\.md$/);
  });
});
