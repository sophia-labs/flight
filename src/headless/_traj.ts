import { readFileSync } from "node:fs";
const r = JSON.parse(readFileSync(process.argv[2], "utf8"));
const bpos = r.frames.flatMap((f:any)=>f.aircraft.filter((a:any)=>a.id==="balloon"))[0].position;
for (const d of (r.decisions??[]).filter((d:any)=>d.agentId==="blue-1")){
  const c0:any = d.observation.contacts[0];
  console.log(`turn ${String(d.turn).padStart(2)}: rng=${c0?String(Math.round(c0.range)).padStart(4):"-"} fwd=${c0?c0.bearingForward.toFixed(2):"-"} R=${c0?c0.bearingRight.toFixed(2):"-"} U=${c0?c0.bearingUp.toFixed(2):"-"} trig=${(d.action as any).trigger} alt=${Math.round(d.observation.self.altitude)} spd=${Math.round(d.observation.self.airspeed)}`);
}
