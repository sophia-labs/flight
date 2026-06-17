import { complete, getModels, type TextContent, type ToolCall } from "@earendil-works/pi-ai";
import type { ActionSpec } from "../actionSpec";
import type { Controller } from "../controller";

// Shared briefing describing the observation and the objective; the ActionSpec appends the
// action-vocabulary specifics.
export const FLIGHT_RULES = `You are an autonomous fighter pilot flying one aircraft in a turn-based dogfight. Each turn you receive a JSON observation and choose ONE action, which is held for roughly one turn of flight (~2.4s normally, 2.5s in motor-program mode).

Observation fields:
- self: airspeed (m/s), altitude (m), aoaDeg (angle of attack; the wing stalls past ~24 deg), gLoad, health (0-100), weaponCooldown (seconds; 0 means you can fire), stalled (bool).
- self.missileLoaded means a heat-seeking FOX-2 is loaded. self.radarMissileLoaded means an active-radar BVR missile is loaded.
- contacts[0] is the enemy, ego-relative: range (m); bearingForward (1 = dead ahead, 0 = abeam, negative = behind); bearingRight (+ = to your right); bearingUp (+ = above you); closureRate (+ = opening, - = closing); health. contact.missileLock means a FOX-2 fired now has IR lock; contact.radarLock means an active-radar missile fired now has a radar weapon solution.
- text, when present, is a cockpit camera-ascii@2 view. The + at grid center is the gun boresight/pipper; use the grid and legend as visual input for line-up and aiming geometry.

Sign discipline:
- bearingRight > 0 means target right; bearingRight < 0 means target left.
- bearingUp > 0 means target above the nose/pipper; bearingUp < 0 means target below the nose/pipper.
- In the ASCII legend, "high" means above the pipper and "low" means below it. Keep the target near 12 o'clock level for guns; do not overfly it vertically.

Fly competently and defeat the enemy. Keep your energy up — don't get slow, stalled, or mush into the ground (the floor is 55 m). Point your nose at the enemy; fire only with a clean shot (bearingForward near 1, small bearingRight/bearingUp, range < ~1050 m, weaponCooldown 0).`;

export interface PiControllerOptions {
  slug: string; // OpenRouter model id, or a first-party DeepSeek id when DEEPSEEK_API_KEY is configured.
  spec: ActionSpec;
  rules?: string;
  maxTokens?: number;
}

export function resolveOpenRouterModel(slug: string) {
  if (process.env.DEEPSEEK_API_KEY) {
    const direct = getModels("deepseek").find((m) => m.id === slug);
    if (direct) return direct;
  }
  const model = getModels("openrouter").find((m) => m.id === slug);
  if (!model) throw new Error(`Model not in pi-ai deepseek/openrouter registry: ${slug}`);
  return model;
}

// Pull the first balanced JSON object out of free text (for models without tool calling).
function extractJsonObject(text: string): Record<string, unknown> {
  const cleaned = text.replace(/```(?:json)?/gi, "");
  const start = cleaned.indexOf("{");
  if (start === -1) throw new Error("no JSON object in model output");
  let depth = 0;
  for (let i = start; i < cleaned.length; i += 1) {
    if (cleaned[i] === "{") depth += 1;
    else if (cleaned[i] === "}") {
      depth -= 1;
      if (depth === 0) return JSON.parse(cleaned.slice(start, i + 1)) as Record<string, unknown>;
    }
  }
  throw new Error("unbalanced JSON object in model output");
}

export function piController(options: PiControllerOptions): Controller {
  const model = resolveOpenRouterModel(options.slug);
  const maxTokens = options.maxTokens ?? 512;
  const systemPrompt = `${options.rules ?? FLIGHT_RULES}\n\n${options.spec.rules}`;

  return async (observation, context) => {
    const response = await complete(
      model,
      {
        systemPrompt,
        messages: [
          { role: "user", content: JSON.stringify(observation), timestamp: Date.now() },
        ],
        tools: [
          {
            name: options.spec.name,
            description: options.spec.description,
            parameters: options.spec.toolSchema,
          },
        ],
      },
      { maxTokens, signal: context.signal, maxRetries: 4 },
    );

    if (response.stopReason === "error" || response.content.length === 0) {
      throw new Error(
        response.errorMessage ?? `model returned stopReason=${response.stopReason} with no content`,
      );
    }

    const usage = {
      inputTokens: response.usage.input,
      outputTokens: response.usage.output,
      costUsd: response.usage.cost.total,
    };

    const toolCall = response.content.find((b): b is ToolCall => b.type === "toolCall");
    const args = toolCall
      ? toolCall.arguments
      : extractJsonObject(
          response.content
            .filter((b): b is TextContent => b.type === "text")
            .map((b) => b.text)
            .join("\n"),
        );

    const action = options.spec.toAction(args); // throws on invalid -> runMatch fallback
    const rationale = typeof args.reason === "string" ? args.reason : undefined;
    return { action, rationale, usage, raw: { model: response.model, stopReason: response.stopReason } };
  };
}
