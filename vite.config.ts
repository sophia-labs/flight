import type { IncomingMessage, ServerResponse } from "node:http";
import { loadEnv, type Plugin } from "vite";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import { runScenarioApiRequest } from "./src/server/scenarioRun";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  for (const key of SERVER_ENV_KEYS) {
    if (env[key] && !process.env[key]) process.env[key] = env[key];
  }

  return {
    plugins: [react(), scenarioApiPlugin()],
    test: {
      include: ["tests/**/*.test.ts"],
      exclude: ["tests/e2e/**", "node_modules/**", "dist/**"],
    },
    server: {
      host: "127.0.0.1",
      port: 5173,
    },
    preview: {
      host: "127.0.0.1",
      port: 4173,
    },
  };
});

const SERVER_ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "DEEPSEEK_API_KEY",
  "SCENARIO_DECISION_TIMEOUT_MS",
  "SCENARIO_PILOT_MAX_TOKENS",
  "SCENARIO_BODY_TIMEOUT_MS",
  "SCENARIO_BODY_MAX_TOKENS",
  "SCENARIO_BODY_MAX_RETRIES",
  "SCENARIO_BODY_EMPTY_RETRIES",
  "BODY_TIMEOUT_MS",
  "BODY_MAX_TOKENS",
  "BODY_MAX_RETRIES",
  "BODY_EMPTY_RETRIES",
] as const;

function scenarioApiPlugin(): Plugin {
  return {
    name: "flight-scenario-api",
    configureServer(server) {
      server.middlewares.use("/api/scenario/run", async (req, res, next) => {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: "POST required" });
          return;
        }
        try {
          const body = await readJson(req);
          const result = await runScenarioApiRequest(body);
          sendJson(res, 200, result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          sendJson(res, 500, { error: message });
        }
      });
    },
  };
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk: string) => {
      raw += chunk;
      if (raw.length > 2_000_000) reject(new Error("request body too large"));
    });
    req.on("error", reject);
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("invalid JSON request body"));
      }
    });
  });
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}
