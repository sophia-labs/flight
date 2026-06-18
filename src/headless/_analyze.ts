import { readFileSync } from "node:fs";
const path = process.argv[2];
const r = JSON.parse(readFileSync(path, "utf8"));
const bf = r.frames.flatMap((f: any) => f.aircraft.filter((a: any) => a.id === "balloon"));
const hits = r.frames.flatMap((f: any) =>
  f.events.filter((e: any) => e.targetId === "balloon" && e.type === "hit").map((e: any) => ({ time: f.time, turn: f.turn })),
);
const shots = r.frames.flatMap((f: any) =>
  f.events.filter((e: any) => e.targetId === "balloon").map((e: any) => e.type),
);
const finalHealth = bf.length ? bf[bf.length - 1].health : "n/a";
const ticks = (r.bodyTicks ?? []).filter((t: any) => t.agentId === "blue-1");
const lat = ticks.map((t: any) => t.latencyMs).filter((x: any) => typeof x === "number");
const avgLat = lat.length ? (lat.reduce((a: number, b: number) => a + b, 0) / lat.length / 1000).toFixed(2) : "n/a";
const errors = ticks.filter((t: any) => t.modelError).length;
const fallbacks = (r.decisions ?? []).filter((d: any) => d.agentId === "blue-1" && d.source === "fallback").length;
console.log(`=== ${path} ===`);
console.log(`balloon final health: ${finalHealth}  KILLED: ${finalHealth === 0}`);
console.log(`balloon events: ${shots.join(",") || "(none)"}`);
if (hits.length) console.log(`first hit at turn ${hits[0].turn} t=${hits[0].time.toFixed(1)}s`);
console.log(`body ticks: ${ticks.length}  avgLatency: ${avgLat}s  modelErrors: ${errors}  pilot fallbacks: ${fallbacks}`);
console.log(`winner: ${r.outcome?.winnerTeam ?? "draw"}`);
