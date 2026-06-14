import { OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { useMemo, useState, type CSSProperties } from "react";
import type { Airframe, EnginePart, FuselagePart, MatchReplay, Part, WingPart } from "../protocol/schema";
import { generateAirframeMatch } from "../runtime/scenario";
import { airframeReport, compileAirframe, defaultAirframe, noseCamera } from "../sim/airframe";
import { quatIdentity, vec3 } from "../sim/math";
import { PartMeshes } from "./airframeMesh";

const BLUE = "#4da3ff";

// A small KSP-style hangar: edit the airframe as a parts list, watch the model recompile live (mass,
// thrust, wing area, the 3 control rates, T:W) with flyability warnings, see the plane you're building
// in 3D, then "Fly this" to send it into a deterministic scripted duel against the default.
export function HangarScreen({
  onExit,
  onFly,
}: {
  onExit: () => void;
  onFly: (replay: MatchReplay) => void;
}) {
  const [airframe, setAirframe] = useState<Airframe>(() => defaultAirframe());
  const [flying, setFlying] = useState(false);

  const compiled = useMemo(() => compileAirframe(airframe), [airframe]);
  const report = useMemo(() => airframeReport(compiled.model), [compiled]);
  const base = useMemo(() => compileAirframe(defaultAirframe()).model, []);

  const updatePart = (id: string, fn: (p: Part) => Part) =>
    setAirframe((a) => ({ ...a, parts: a.parts.map((p) => (p.id === id ? fn(p) : p)) }));
  const removePart = (id: string) =>
    setAirframe((a) => ({ ...a, parts: a.parts.filter((p) => p.id !== id) }));
  const addPart = (kind: Part["kind"]) =>
    setAirframe((a) => ({ ...a, parts: [...a.parts, makePart(kind, a.parts)] }));
  const duplicatePart = (id: string) =>
    setAirframe((a) => {
      const p = a.parts.find((x) => x.id === id);
      if (!p) return a;
      return { ...a, parts: [...a.parts, { ...structuredClone(p), id: uniqueId(p.kind, a.parts) }] };
    });

  const fly = async () => {
    setFlying(true);
    const replay = await generateAirframeMatch(airframe);
    onFly(replay);
  };

  return (
    <div style={S.overlay}>
      <header style={S.header}>
        <div>
          <p style={S.eyebrow}>Flight Duel — Hangar</p>
          <h1 style={S.title}>Build your aircraft</h1>
        </div>
        <div style={{ display: "flex", gap: 10 }}>
          <button type="button" style={S.ghostBtn} onClick={() => setAirframe(defaultAirframe())}>
            Reset to default
          </button>
          <button type="button" style={S.ghostBtn} onClick={onExit}>
            ← Back to flight
          </button>
          <button type="button" style={S.flyBtn} onClick={fly} disabled={flying}>
            {flying ? "Flying…" : "Fly this ▶"}
          </button>
        </div>
      </header>

      <div style={S.body}>
        <section style={S.editor}>
          <div style={S.sectionHead}>
            <span>PARTS</span>
            <div style={{ display: "flex", gap: 6 }}>
              {(["wing", "engine", "fuselage", "sensor"] as const).map((k) => (
                <button key={k} type="button" style={S.addBtn} onClick={() => addPart(k)}>
                  + {k}
                </button>
              ))}
            </div>
          </div>
          <div style={S.partList}>
            {airframe.parts.map((part) => (
              <PartCard
                key={part.id}
                part={part}
                onChange={(fn) => updatePart(part.id, fn)}
                onRemove={() => removePart(part.id)}
                onDuplicate={() => duplicatePart(part.id)}
              />
            ))}
          </div>
        </section>

        <section style={S.right}>
          <div style={S.preview}>
            <Canvas camera={{ position: [2.4, 1.3, 3.2], fov: 50 }}>
              <color attach="background" args={["#0c141b"]} />
              <ambientLight intensity={0.6} />
              <directionalLight position={[5, 8, 4]} intensity={2.2} />
              <gridHelper args={[8, 16, "#2c3a44", "#1b2730"]} position={[0, -0.9, 0]} />
              <group scale={1.42}>
                <PartMeshes parts={airframe.parts} color={BLUE} stalled={false} />
              </group>
              <OrbitControls enableDamping dampingFactor={0.1} />
            </Canvas>
          </div>

          <div style={S.stats}>
            <Stat label="mass" value={`${Math.round(compiled.model.massKg)} kg`} />
            <Stat
              label="thrust"
              value={`${(compiled.model.maxThrustN / 1000).toFixed(0)} kN`}
              ratio={compiled.model.maxThrustN / base.maxThrustN}
            />
            <Stat label="wing area" value={`${compiled.model.wingAreaM2.toFixed(1)} m²`} />
            <Stat label="thrust : weight" value={report.thrustToWeight.toFixed(2)} />
            <Stat
              label="roll"
              value={`${compiled.model.maxRollRate.toFixed(2)} rad/s`}
              ratio={compiled.model.maxRollRate / base.maxRollRate}
            />
            <Stat
              label="pitch"
              value={`${compiled.model.maxPitchRate.toFixed(2)} rad/s`}
              ratio={compiled.model.maxPitchRate / base.maxPitchRate}
            />
            <Stat
              label="yaw"
              value={`${compiled.model.maxYawRate.toFixed(2)} rad/s`}
              ratio={compiled.model.maxYawRate / base.maxYawRate}
            />
            <Stat
              label="wing loading"
              value={Number.isFinite(report.wingLoadingNm2) ? `${Math.round(report.wingLoadingNm2)} N/m²` : "—"}
            />
          </div>

          <div style={S.warnings}>
            {report.warnings.length === 0 ? (
              <span style={{ color: "#58d38c" }}>✓ flyable — no warnings</span>
            ) : (
              report.warnings.map((w) => (
                <div key={w} style={{ color: "#f2c94c" }}>
                  ⚠ {w}
                </div>
              ))
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function Stat({ label, value, ratio }: { label: string; value: string; ratio?: number }) {
  return (
    <div style={S.stat}>
      <span style={S.statLabel}>{label}</span>
      <span style={S.statValue}>{value}</span>
      {ratio !== undefined && Math.abs(ratio - 1) > 0.005 ? (
        <span style={{ ...S.statRatio, color: ratio > 1 ? "#58d38c" : "#ff8d83" }}>
          ×{ratio.toFixed(2)}
        </span>
      ) : null}
    </div>
  );
}

function PartCard({
  part,
  onChange,
  onRemove,
  onDuplicate,
}: {
  part: Part;
  onChange: (fn: (p: Part) => Part) => void;
  onRemove: () => void;
  onDuplicate: () => void;
}) {
  return (
    <div style={S.card}>
      <div style={S.cardHead}>
        <span style={S.cardKind}>{part.kind}</span>
        <span style={S.cardId}>{part.id}</span>
        <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
          <button type="button" style={S.iconBtn} title="Duplicate" onClick={onDuplicate}>
            ⧉
          </button>
          <button type="button" style={S.iconBtn} title="Remove" onClick={onRemove}>
            ✕
          </button>
        </div>
      </div>
      <PartFields part={part} onChange={onChange} />
    </div>
  );
}

function PartFields({ part, onChange }: { part: Part; onChange: (fn: (p: Part) => Part) => void }) {
  if (part.kind === "fuselage") {
    const set = (k: keyof FuselagePart["dims"], v: number) =>
      onChange((p) => ({ ...(p as FuselagePart), dims: { ...(p as FuselagePart).dims, [k]: v } }));
    return (
      <>
        <Slider label="length" value={part.dims.length} min={2} max={20} step={0.5} onChange={(v) => set("length", v)} />
        <Slider label="width" value={part.dims.width} min={0.4} max={4} step={0.1} onChange={(v) => set("width", v)} />
        <Slider label="height" value={part.dims.height} min={0.4} max={4} step={0.1} onChange={(v) => set("height", v)} />
        <MassSlider part={part} onChange={onChange} max={12000} />
      </>
    );
  }

  if (part.kind === "wing") {
    const setPlan = (k: keyof WingPart["planform"], v: number) =>
      onChange((p) => ({ ...(p as WingPart), planform: { ...(p as WingPart).planform, [k]: v } }));
    const wing = part;
    return (
      <>
        <Slider label="span" value={wing.planform.span} min={1} max={24} step={0.5} onChange={(v) => setPlan("span", v)} />
        <Slider label="chord" value={wing.planform.chord} min={0.3} max={4} step={0.1} onChange={(v) => setPlan("chord", v)} />
        <MassSlider part={part} onChange={onChange} max={4000} />
        <div style={S.fieldRow}>
          <span style={S.fieldLabel}>control</span>
          <select
            style={S.select}
            value={wing.control?.axis ?? "none"}
            onChange={(e) =>
              onChange((p) => {
                const w = p as WingPart;
                if (e.target.value === "none") return { ...w, control: undefined };
                return { ...w, control: { axis: e.target.value as "roll" | "pitch" | "yaw", area: w.control?.area ?? 1 } };
              })
            }
          >
            <option value="none">none (lift only)</option>
            <option value="roll">aileron (roll)</option>
            <option value="pitch">elevator (pitch)</option>
            <option value="yaw">rudder (yaw)</option>
          </select>
        </div>
        {wing.control ? (
          <Slider
            label="surface area"
            value={wing.control.area}
            min={0.2}
            max={6}
            step={0.1}
            onChange={(v) =>
              onChange((p) => {
                const w = p as WingPart;
                return { ...w, control: { axis: w.control!.axis, area: v } };
              })
            }
          />
        ) : null}
      </>
    );
  }

  if (part.kind === "engine") {
    return (
      <>
        <Slider
          label="thrust (kN)"
          value={part.thrustN / 1000}
          min={5}
          max={200}
          step={1}
          onChange={(v) => onChange((p) => ({ ...(p as EnginePart), thrustN: v * 1000 }))}
        />
        <MassSlider part={part} onChange={onChange} max={4000} />
      </>
    );
  }

  // sensor — pose/optics editing is advanced; show its identity for now.
  return <div style={S.sensorNote}>{part.modality} sensor · range {Math.round(part.for.maxRangeM)} m</div>;
}

function MassSlider({
  part,
  onChange,
  max,
}: {
  part: Part;
  onChange: (fn: (p: Part) => Part) => void;
  max: number;
}) {
  if (part.kind === "sensor") return null;
  return (
    <Slider
      label="mass"
      value={part.massKg}
      min={0}
      max={max}
      step={50}
      onChange={(v) => onChange((p) => ({ ...(p as FuselagePart | WingPart | EnginePart), massKg: v }))}
    />
  );
}

function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div style={S.fieldRow}>
      <span style={S.fieldLabel}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={S.range}
      />
      <span style={S.fieldValue}>{value % 1 === 0 ? value : value.toFixed(2)}</span>
    </div>
  );
}

function uniqueId(kind: string, parts: Part[]): string {
  let n = parts.length + 1;
  const ids = new Set(parts.map((p) => p.id));
  while (ids.has(`${kind}-${n}`)) n += 1;
  return `${kind}-${n}`;
}

function makePart(kind: Part["kind"], parts: Part[]): Part {
  const id = uniqueId(kind, parts);
  const pose = { offset: vec3(0, 0, 1), rotation: quatIdentity() };
  switch (kind) {
    case "fuselage":
      return { id, kind, pose: { offset: vec3(0, 0, 0), rotation: quatIdentity() }, dims: { length: 6, width: 1, height: 1 }, massKg: 1_000 };
    case "wing":
      return { id, kind, pose, planform: { span: 6, chord: 1 }, massKg: 300, control: { axis: "roll", area: 1 } };
    case "engine":
      return { id, kind, pose: { offset: vec3(0, 0, 4), rotation: quatIdentity() }, thrustN: 30_000, massKg: 600, dims: { radius: 0.4, length: 2 } };
    case "sensor":
      return { ...noseCamera(), id };
  }
}

const panel = "rgba(14, 20, 24, 0.92)";
const S: Record<string, CSSProperties> = {
  overlay: {
    position: "fixed",
    inset: 0,
    background: "#0b1116",
    color: "#e7eef2",
    display: "flex",
    flexDirection: "column",
    zIndex: 50,
    fontFamily: "inherit",
  },
  header: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "18px 26px",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
  },
  eyebrow: { margin: 0, fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: "#7f95a3" },
  title: { margin: "2px 0 0", fontSize: 24 },
  body: { flex: 1, display: "grid", gridTemplateColumns: "minmax(360px, 460px) 1fr", minHeight: 0 },
  editor: { borderRight: "1px solid rgba(255,255,255,0.08)", display: "flex", flexDirection: "column", minHeight: 0 },
  sectionHead: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "12px 18px",
    fontSize: 12,
    letterSpacing: 1.5,
    color: "#9fb2bd",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
  },
  partList: { overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 12 },
  right: { display: "flex", flexDirection: "column", minHeight: 0 },
  preview: { flex: 1, minHeight: 240, background: "#0c141b" },
  stats: {
    display: "grid",
    gridTemplateColumns: "repeat(4, 1fr)",
    gap: 1,
    background: "rgba(255,255,255,0.06)",
    borderTop: "1px solid rgba(255,255,255,0.08)",
  },
  stat: { background: "#0e1418", padding: "10px 12px", display: "flex", flexDirection: "column", gap: 2 },
  statLabel: { fontSize: 10, textTransform: "uppercase", letterSpacing: 1, color: "#7f95a3" },
  statValue: { fontSize: 16, fontWeight: 600 },
  statRatio: { fontSize: 11, fontWeight: 600 },
  warnings: { padding: "10px 16px", fontSize: 13, display: "flex", flexDirection: "column", gap: 4, background: "#0e1418" },
  card: { background: panel, borderRadius: 10, padding: 12, border: "1px solid rgba(255,255,255,0.06)" },
  cardHead: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 },
  cardKind: { fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, color: BLUE },
  cardId: { fontSize: 12, color: "#8aa0ad" },
  fieldRow: { display: "flex", alignItems: "center", gap: 10, marginTop: 6 },
  fieldLabel: { fontSize: 12, color: "#9fb2bd", width: 96, flexShrink: 0 },
  fieldValue: { fontSize: 12, color: "#e7eef2", width: 48, textAlign: "right", flexShrink: 0, fontVariantNumeric: "tabular-nums" },
  range: { flex: 1, accentColor: BLUE },
  select: { flex: 1, background: "#0e1418", color: "#e7eef2", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, padding: "4px 6px" },
  sensorNote: { fontSize: 12, color: "#8aa0ad" },
  addBtn: { background: "rgba(77,163,255,0.14)", color: BLUE, border: "1px solid rgba(77,163,255,0.3)", borderRadius: 6, padding: "4px 8px", fontSize: 12, cursor: "pointer" },
  iconBtn: { background: "transparent", color: "#9fb2bd", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, width: 26, height: 26, cursor: "pointer" },
  ghostBtn: { background: "transparent", color: "#cdd9e0", border: "1px solid rgba(255,255,255,0.18)", borderRadius: 8, padding: "8px 14px", cursor: "pointer", fontSize: 14, whiteSpace: "nowrap" },
  flyBtn: { background: BLUE, color: "#04101c", border: "none", borderRadius: 8, padding: "8px 18px", cursor: "pointer", fontSize: 14, fontWeight: 700, whiteSpace: "nowrap" },
};
