import { complete, getModels, type TextContent } from "@earendil-works/pi-ai";
import { buildBodyPrompt } from "./telemetry";
import type { BodyModel } from "./model";

export interface PiBodyModelOptions {
  slug: string;
  maxTokens?: number;
  maxRetries?: number;
}

function resolveOpenRouterModel(slug: string) {
  const model = getModels("openrouter").find((m) => m.id === slug);
  if (!model) throw new Error(`OpenRouter model not in pi-ai registry: ${slug}`);
  return model;
}

function textFromResponse(content: unknown[]): string {
  return content
    .filter((block): block is TextContent => {
      return typeof block === "object" && block !== null && (block as { type?: unknown }).type === "text";
    })
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export function piBodyModel(options: PiBodyModelOptions): BodyModel {
  const model = resolveOpenRouterModel(options.slug);
  const maxTokens = options.maxTokens ?? 96;
  const maxRetries = options.maxRetries ?? 2;
  const systemPrompt = [
    "You are the vehicle's body, not the pilot.",
    "You live one tick at a time.",
    "Move the muscles of this body using only the required command format.",
    "Do not explain, ask questions, or make long plans.",
    "If the pilot asks for something physically dangerous, preserve control and report the body feeling.",
  ].join("\n");

  return async ({ manifest, pilotIntent, proprioception, memory }) => {
    const prompt = buildBodyPrompt(manifest, pilotIntent, proprioception, memory);
    const response = await complete(
      model,
      {
        systemPrompt,
        messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
      },
      { maxTokens, maxRetries },
    );

    if (response.stopReason === "error" || response.content.length === 0) {
      throw new Error(response.errorMessage ?? `body model returned stopReason=${response.stopReason}`);
    }
    const text = textFromResponse(response.content);
    if (!text) throw new Error("body model produced no text");
    return text;
  };
}

