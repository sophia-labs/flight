import { resolve } from "node:path";

export interface EnsembleArtifactPaths {
  slug: string;
  cockpitOut: string;
  sensorOut: string;
  replayOut: string;
  transcriptOut: string;
}

export function safeModelSlug(slug: string): string {
  return slug.replace(/[^a-z0-9.]+/gi, "-").replace(/^-+|-+$/g, "");
}

export function ensembleArtifactPaths(input: {
  model: string;
  bodyModel: string;
  out?: string;
  sensorOut?: string;
  replayOut?: string;
  transcriptOut?: string;
}): EnsembleArtifactPaths {
  const slug = safeModelSlug(
    input.bodyModel === input.model ? input.model : `${input.model}-body-${input.bodyModel}`,
  );
  return {
    slug,
    cockpitOut: resolve(input.out ?? `clips/${slug}-ensemble-cockpit.mp4`),
    sensorOut: resolve(input.sensorOut ?? `clips/${slug}-ensemble-sensor.mp4`),
    replayOut: resolve(input.replayOut ?? `clips/${slug}-ensemble-replay.json`),
    transcriptOut: resolve(input.transcriptOut ?? `clips/${slug}-ensemble-transcript.md`),
  };
}
