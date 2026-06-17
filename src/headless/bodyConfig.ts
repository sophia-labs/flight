import { fixedWingBodyManifest } from "../body/manifest";
import { scriptedFixedWingBodyModel } from "../body/model";
import { piBodyModel } from "../body/piModel";
import type { BodyRuntimeConfig } from "../body/runtime";

export const SCRIPTED_BODY_MODEL = "scripted";

export interface HeadlessBodyConfigOptions {
  modelSlug?: string;
  maxTokens?: number;
  maxRetries?: number;
  emptyRetries?: number;
  timeoutMs?: number;
  bodyTickDt?: number;
}

export function isLiveBodyModel(modelSlug = SCRIPTED_BODY_MODEL): boolean {
  return modelSlug !== SCRIPTED_BODY_MODEL;
}

export function bodyModelLabel(modelSlug = SCRIPTED_BODY_MODEL): string {
  return isLiveBodyModel(modelSlug) ? modelSlug : SCRIPTED_BODY_MODEL;
}

export function createHeadlessBodyConfig(options: HeadlessBodyConfigOptions = {}): BodyRuntimeConfig {
  const modelSlug = options.modelSlug ?? SCRIPTED_BODY_MODEL;
  const timeoutMs = options.timeoutMs;
  const manifest =
    options.bodyTickDt !== undefined
      ? { ...fixedWingBodyManifest, bodyTickDt: options.bodyTickDt }
      : fixedWingBodyManifest;
  if (!isLiveBodyModel(modelSlug)) {
    return {
      manifest,
      model: scriptedFixedWingBodyModel,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    };
  }

  return {
    manifest,
    model: piBodyModel({
      slug: modelSlug,
      maxTokens: options.maxTokens,
      maxRetries: options.maxRetries,
      emptyRetries: options.emptyRetries,
      timeoutMs,
    }),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    recordLatency: true,
  };
}
