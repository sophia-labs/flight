import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GardenMcpConnection {
  mcpUrl: string;
  token: string;
  graphId: string;
  apiUrl?: string;
  source: "env" | "manifest";
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

export interface GardenConnectionDisabled {
  enabled: false;
  reason: string;
}

export type GardenConnectionResolution =
  | { enabled: true; connection: GardenMcpConnection }
  | GardenConnectionDisabled;

interface LoopbackManifest {
  apiUrl?: string;
  mcpUrl?: string;
  token?: string;
}

const DEFAULT_TIMEOUT_MS = 60_000;

export async function resolveGardenConnection(
  env: Record<string, string | undefined> = process.env,
): Promise<GardenConnectionResolution> {
  const graphId = firstEnv(env, "FLIGHT_GARDEN_GRAPH_ID", "GARDEN_GRAPH_ID");
  if (!graphId) {
    return {
      enabled: false,
      reason: "set FLIGHT_GARDEN_GRAPH_ID to enable Garden sortie journaling",
    };
  }

  const timeoutMs = positiveNumber(firstEnv(env, "FLIGHT_GARDEN_TIMEOUT_MS"), DEFAULT_TIMEOUT_MS);
  const explicitMcpUrl = firstEnv(env, "FLIGHT_GARDEN_MCP_URL", "GARDEN_MCP_URL");
  if (explicitMcpUrl) {
    const token = firstEnv(
      env,
      "FLIGHT_GARDEN_TOKEN",
      "GARDEN_TOKEN",
      "GARDEN_LOOPBACK_TOKEN",
      "PN_DEV_TOKEN",
    );
    if (!token) {
      return {
        enabled: false,
        reason: "set FLIGHT_GARDEN_TOKEN when FLIGHT_GARDEN_MCP_URL is configured",
      };
    }
    return {
      enabled: true,
      connection: {
        mcpUrl: explicitMcpUrl,
        token,
        graphId,
        source: "env",
        timeoutMs,
      },
    };
  }

  const manifestPath = firstEnv(
    env,
    "FLIGHT_GARDEN_MANIFEST",
    "SOPHIA_LOOPBACK_MANIFEST",
    "GARDEN_LOOPBACK_MANIFEST",
  ) ?? defaultLoopbackManifestPath();
  let manifest: LoopbackManifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8")) as LoopbackManifest;
  } catch (error) {
    return {
      enabled: false,
      reason: `Garden loopback manifest not readable at ${manifestPath}: ${errorMessage(error)}`,
    };
  }

  if (!manifest.mcpUrl || !manifest.token) {
    return {
      enabled: false,
      reason: `Garden loopback manifest at ${manifestPath} is missing mcpUrl or token`,
    };
  }

  return {
    enabled: true,
    connection: {
      mcpUrl: manifest.mcpUrl,
      apiUrl: manifest.apiUrl,
      token: manifest.token,
      graphId,
      source: "manifest",
      timeoutMs,
    },
  };
}

export async function callGardenTool<T = unknown>(
  connection: GardenMcpConnection,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const response = await fetchGardenJson(connection, {
    jsonrpc: "2.0",
    id: `flight-${name}-${Date.now()}`,
    method: "tools/call",
    params: { name, arguments: args },
  });
  if (isObject(response) && "error" in response) {
    throw new Error(`Garden MCP tool ${name} failed: ${JSON.stringify(response.error)}`);
  }

  const result = isObject(response) ? response.result : undefined;
  if (isObject(result)) {
    const content = Array.isArray(result.content) ? result.content : [];
    const textBlock = content.find(
      (block): block is { type?: string; text: string } =>
        isObject(block) && typeof block.text === "string",
    );
    if (textBlock) {
      try {
        return JSON.parse(textBlock.text) as T;
      } catch {
        return textBlock.text as T;
      }
    }
    if ("structuredContent" in result) return result.structuredContent as T;
  }
  return result as T;
}

async function fetchGardenJson(connection: GardenMcpConnection, body: unknown): Promise<unknown> {
  const fetchImpl = connection.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), connection.timeoutMs);
  try {
    const response = await fetchImpl(connection.mcpUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${connection.token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    const parsed = text ? safeJson(text) : null;
    if (!response.ok) {
      throw new Error(`POST ${connection.mcpUrl} -> ${response.status}: ${text}`);
    }
    return parsed;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`POST ${connection.mcpUrl} timed out after ${connection.timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function firstEnv(env: Record<string, string | undefined>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function defaultLoopbackManifestPath(): string {
  return join(homedir(), "Library/Application Support/dev.sophia.garden/profiles/default/loopback.json");
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
