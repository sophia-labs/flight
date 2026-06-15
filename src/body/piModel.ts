import { complete, getModels, type TextContent } from "@earendil-works/pi-ai";
import { buildBodyPrompt } from "./telemetry";
import type { BodyModel } from "./model";

export interface PiBodyModelOptions {
  slug: string;
  maxTokens?: number;
  maxRetries?: number;
  emptyRetries?: number;
  timeoutMs?: number;
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

function contentTypes(content: unknown[]): string {
  return content
    .map((block) =>
      typeof block === "object" && block !== null && typeof (block as { type?: unknown }).type === "string"
        ? String((block as { type: unknown }).type)
        : typeof block,
    )
    .join(",");
}

export function piBodyModel(options: PiBodyModelOptions): BodyModel {
  const model = resolveOpenRouterModel(options.slug);
  const maxTokens = options.maxTokens ?? 96;
  const maxRetries = options.maxRetries ?? 2;
  const emptyRetries = options.emptyRetries ?? 1;
  const systemPrompt = [
    "You are the vehicle's body, not the pilot.",
    "You live one tick at a time.",
    "Move the muscles of this body using exactly the required five-line command format.",
    "Return only these five lines, with no Markdown, labels, prose, or extra text before or after them.",
    "The first line must begin with MUSCLE and use integer ROLL, PITCH, YAW, and PUSH fields.",
    "Do not invent words such as gentle_right, throttle_up, or pull_gently; use only signed numbers.",
    "If the pilot asks for something physically dangerous, preserve control and report the body feeling.",
  ].join("\n");

  return async ({ manifest, pilotIntent, proprioception, memory, signal, timeoutMs: inputTimeoutMs }) => {
    const prompt = buildBodyPrompt(manifest, pilotIntent, proprioception, memory);
    let lastEmpty = "body model produced no text";
    let usage = { inputTokens: 0, outputTokens: 0, costUsd: 0 };

    for (let attempt = 0; attempt <= emptyRetries; attempt += 1) {
      const retrySuffix =
        attempt === 0
          ? ""
          : "\n\nEMPTY_RESPONSE_RECOVERY\nYour previous response was empty. Return exactly the five command lines now.";
      const response = await complete(
        model,
        {
          systemPrompt,
          messages: [{ role: "user", content: `${prompt}${retrySuffix}`, timestamp: Date.now() }],
        },
        { maxTokens, maxRetries, signal, timeoutMs: inputTimeoutMs ?? options.timeoutMs },
      );

      usage = {
        inputTokens: usage.inputTokens + response.usage.input,
        outputTokens: usage.outputTokens + response.usage.output,
        costUsd: usage.costUsd + response.usage.cost.total,
      };
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage ?? `body model returned stopReason=${response.stopReason}`);
      }
      const text = textFromResponse(response.content);
      if (!text) {
        lastEmpty = `body model produced no text (stop=${response.stopReason}, content=${contentTypes(response.content) || "empty"})`;
        continue;
      }
      return {
        output: text,
        usage,
        raw: { model: response.model, stopReason: response.stopReason, emptyRetries: attempt },
      };
    }

    throw new Error(lastEmpty);
  };
}
