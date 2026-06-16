import { OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import type {
  Airframe,
  CanopyPart,
  CrewStationPart,
  EnginePart,
  FuselagePart,
  GearPart,
  MatchReplay,
  Part,
  PropPart,
  TankPart,
  WeaponPart,
  WingPart,
} from "../protocol/schema";
import { generateAirframeMatch } from "../runtime/scenario";
import { aircraftArchetypes, referencesForArchetype } from "../sim/aircraftCatalog";
import { airframeReport, compileAirframe, defaultAirframe, noseCamera } from "../sim/airframe";
import { quatFromAxisAngle, quatIdentity, vec3 } from "../sim/math";
import { samplePropulsion } from "../sim/propulsion";
import type { PropulsionPoint } from "../sim/types";
import { PartMeshes } from "./airframeMesh";
import { PilotStationDebug } from "./PilotStationDebug";

const BLUE = "#4da3ff";

function useCompactHangar() {
  const [compact, setCompact] = useState(() =>
    typeof window === "undefined" ? false : window.matchMedia("(max-width: 760px)").matches,
  );

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => setCompact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return compact;
}

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
  const firstArchetype = aircraftArchetypes[0];
  const [selectedArchetypeId, setSelectedArchetypeId] = useState(firstArchetype?.id ?? "default");
  const [airframe, setAirframe] = useState<Airframe>(() =>
    firstArchetype ? structuredClone(firstArchetype.airframe) : defaultAirframe(),
  );
  const [selectedPartId, setSelectedPartId] = useState(() =>
    firstArchetype?.airframe.parts[0]?.id ?? defaultAirframe().parts[0]?.id ?? "",
  );
  const [flying, setFlying] = useState(false);
  const compact = useCompactHangar();

  const compiled = useMemo(() => compileAirframe(airframe), [airframe]);
  const report = useMemo(() => airframeReport(compiled.model), [compiled]);
  const base = useMemo(() => compileAirframe(defaultAirframe()).model, []);
  const selectedArchetype = useMemo(
    () => aircraftArchetypes.find((candidate) => candidate.id === selectedArchetypeId) ?? aircraftArchetypes[0],
    [selectedArchetypeId],
  );
  const referenceNotes = useMemo(
    () => (selectedArchetype ? referencesForArchetype(selectedArchetype) : []),
    [selectedArchetype],
  );
  const propSamples = useMemo(() => propulsionSamples(compiled.model.propulsions[0]), [compiled]);
  const selectedPart = useMemo(
    () => airframe.parts.find((part) => part.id === selectedPartId) ?? airframe.parts[0],
    [airframe.parts, selectedPartId],
  );

  const loadArchetype = (id: string) => {
    const archetype = aircraftArchetypes.find((candidate) => candidate.id === id);
    if (!archetype) return;
    setSelectedArchetypeId(id);
    const next = structuredClone(archetype.airframe);
    setSelectedPartId(next.parts[0]?.id ?? "");
    setAirframe(next);
  };

  const updatePart = (id: string, fn: (p: Part) => Part) =>
    setAirframe((a) => ({ ...a, parts: a.parts.map((p) => (p.id === id ? fn(p) : p)) }));
  const removePart = (id: string) =>
    setAirframe((a) => {
      const parts = a.parts.filter((p) => p.id !== id);
      if (selectedPartId === id) setSelectedPartId(parts[0]?.id ?? "");
      return { ...a, parts };
    });
  const addPart = (kind: Part["kind"]) =>
    setAirframe((a) => {
      const part = makePart(kind, a.parts);
      setSelectedPartId(part.id);
      return { ...a, parts: [...a.parts, part] };
    });
  const duplicatePart = (id: string) =>
    setAirframe((a) => {
      const p = a.parts.find((x) => x.id === id);
      if (!p) return a;
      const copy = { ...structuredClone(p), id: uniqueId(p.kind, a.parts) };
      setSelectedPartId(copy.id);
      return { ...a, parts: [...a.parts, copy] };
    });

  const fly = async () => {
    setFlying(true);
    const replay = await generateAirframeMatch(airframe);
    onFly(replay);
  };

  return (
    <div style={S.overlay}>
      <header style={compact ? { ...S.header, ...S.headerCompact } : S.header}>
        <div>
          <p style={S.eyebrow}>Flight Duel — Hangar</p>
          <h1 style={S.title}>Build your aircraft</h1>
        </div>
        <div style={compact ? S.headerActionsCompact : S.headerActions}>
          <button
            type="button"
            style={S.ghostBtn}
            onClick={() => {
              setSelectedArchetypeId("default");
              const next = defaultAirframe();
              setSelectedPartId(next.parts[0]?.id ?? "");
              setAirframe(next);
            }}
          >
            Calibration default
          </button>
          <button type="button" style={S.ghostBtn} onClick={onExit}>
            ← Back to flight
          </button>
          <button type="button" style={S.flyBtn} onClick={fly} disabled={flying}>
            {flying ? "Flying…" : "Fly this ▶"}
          </button>
        </div>
      </header>

      <div style={compact ? S.bodyCompact : S.body}>
        <section style={compact ? { ...S.editor, ...S.editorCompact } : S.editor}>
          <div style={S.sectionHead}>
            <span>AIRCRAFT LINES</span>
          </div>
          <div style={S.archetypeList}>
            {aircraftArchetypes.map((archetype) => (
              <button
                key={archetype.id}
                type="button"
                style={{
                  ...S.archetypeBtn,
                  borderColor:
                    selectedArchetypeId === archetype.id ? archetype.palette.trim : "rgba(255,255,255,0.08)",
                }}
                onClick={() => loadArchetype(archetype.id)}
              >
                <span style={{ ...S.swatch, background: archetype.palette.base, borderColor: archetype.palette.trim }} />
                <span style={S.archetypeName}>{archetype.shortName}</span>
                <span style={S.archetypeRole}>{archetype.role}</span>
              </button>
            ))}
          </div>
          <div style={S.sectionHead}>
            <span>PART KIT</span>
          </div>
          <div style={S.addTray}>
            {(["wing", "engine", "prop", "canopy", "crew-station", "gear", "weapon", "fuselage", "tank", "sensor"] as const).map((k) => (
              <button key={k} type="button" style={S.addBtn} onClick={() => addPart(k)}>
                + {k}
              </button>
            ))}
          </div>
          <div style={compact ? { ...S.partList, ...S.partListCompact } : S.partList}>
            <div style={S.partRoster}>
              {airframe.parts.map((part) => (
                <button
                  key={part.id}
                  type="button"
                  style={{
                    ...S.partRosterBtn,
                    borderColor: selectedPart?.id === part.id ? BLUE : "rgba(255,255,255,0.08)",
                  }}
                  onClick={() => setSelectedPartId(part.id)}
                >
                  <span style={S.partRosterKind}>{part.kind}</span>
                  <span style={S.partRosterId}>{part.id}</span>
                </button>
              ))}
            </div>
            {selectedPart ? (
              <PartCard
                key={selectedPart.id}
                part={selectedPart}
                onChange={(fn) => updatePart(selectedPart.id, fn)}
                onRemove={() => removePart(selectedPart.id)}
                onDuplicate={() => duplicatePart(selectedPart.id)}
              />
            ) : (
              <div style={S.sensorNote}>Add a part to begin shaping this airframe.</div>
            )}
          </div>
        </section>

        <section style={compact ? { ...S.right, ...S.rightCompact } : S.right}>
          {selectedArchetype ? (
            <div style={compact ? { ...S.brief, ...S.briefCompact } : S.brief}>
              <div>
                <p style={S.eyebrow}>Golden-age design line</p>
                <h2 style={S.briefTitle}>{selectedArchetype.name}</h2>
                <p style={S.briefText}>{selectedArchetype.summary}</p>
              </div>
              <div style={compact ? { ...S.referenceGrid, ...S.referenceGridCompact } : S.referenceGrid}>
                {referenceNotes.slice(0, 3).map((ref) => (
                  <div key={ref.id} style={S.referenceCard}>
                    <span style={S.referenceName}>{ref.name}</span>
                    <span>{ref.role}</span>
                    <span>
                      {ref.spanM.toFixed(1)} m span · {ref.powerHp} hp
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          <div style={compact ? { ...S.preview, ...S.previewCompact } : S.preview}>
            <Canvas camera={{ position: [1.9, 1.05, 2.25], fov: 38 }} shadows>
              <color attach="background" args={["#0d1518"]} />
              <hemisphereLight args={["#c6e9ff", "#263018", 1.1]} />
              <ambientLight intensity={0.35} />
              <directionalLight position={[4, 6, 3]} intensity={2.4} castShadow />
              <directionalLight position={[-3, 2, -4]} intensity={0.65} />
              <HangarEnvironment />
              <group scale={2.18} position={[0, -0.05, 0]} rotation={[0.02, -0.34, 0]}>
                <PartMeshes
                  parts={airframe.parts}
                  color={selectedArchetype?.palette.base ?? BLUE}
                  accentColor={selectedArchetype?.palette.trim ?? "#f4d35e"}
                  stalled={false}
                  propSpin={0.18}
                />
                {selectedPart?.kind === "crew-station" ? (
                  <PilotStationDebug parts={airframe.parts} pointScale={1.8} />
                ) : null}
              </group>
              <OrbitControls enableDamping dampingFactor={0.1} />
            </Canvas>
          </div>

          <div style={S.propCurve}>
            <div style={S.sectionHeadCompact}>
              <span>PROP CURVE</span>
              <span>{compiled.model.propulsions.length > 0 ? `${compiled.model.propulsions.length} curve-driven` : "fixed thrust fallback"}</span>
            </div>
            <div style={S.curveBars}>
              {propSamples.length > 0 ? (
                propSamples.map((sample) => (
                  <div key={sample.speed} style={S.curveBarCol}>
                    <div style={S.curveTrack}>
                      <div style={{ ...S.curveFill, height: `${sample.percent}%` }} />
                    </div>
                    <span>{sample.speed}</span>
                    <strong>{sample.thrustKn}</strong>
                  </div>
                ))
              ) : (
                <span style={{ color: "#8aa0ad" }}>Add a powered engine and propeller to see thrust versus airspeed.</span>
              )}
            </div>
          </div>

          <div style={S.stats}>
            <Stat label="mass" value={`${Math.round(compiled.model.massKg)} kg`} />
            <Stat
              label="thrust"
              value={`${(compiled.model.maxThrustN / 1000).toFixed(0)} kN`}
              ratio={compiled.model.maxThrustN / base.maxThrustN}
            />
            <Stat label="wing area" value={`${compiled.model.wingAreaM2.toFixed(1)} m²`} />
            <Stat label="surfaces" value={`${compiled.model.aeroSurfaces.length}`} />
            <Stat label="engines" value={`${compiled.model.thrustPoints.length + compiled.model.propulsions.length}`} />
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
            {compiled.model.fuelCapacityKg > 0 ? (
              <>
                <Stat label="fuel" value={`${Math.round(compiled.model.fuelCapacityKg)} kg`} />
                <Stat
                  label="endurance"
                  value={`${Math.round(compiled.model.fuelCapacityKg / (6e-5 * compiled.model.maxThrustN))} s`}
                />
              </>
            ) : null}
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

function HangarEnvironment() {
  return (
    <group position={[0, -0.66, 0]}>
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.012, 0]}>
        <planeGeometry args={[6.2, 4.8]} />
        <meshStandardMaterial color="#121d20" roughness={0.72} metalness={0.08} />
      </mesh>
      <gridHelper args={[5.6, 14, "#344750", "#1f3036"]} position={[0, 0, 0]} />
      <mesh position={[0, 0.006, -1.42]}>
        <boxGeometry args={[3.4, 0.012, 0.035]} />
        <meshStandardMaterial color="#d8a33c" roughness={0.5} metalness={0.12} />
      </mesh>
      <mesh position={[0, 0.008, 1.22]}>
        <boxGeometry args={[2.2, 0.014, 0.035]} />
        <meshStandardMaterial color="#d8e6ec" roughness={0.48} metalness={0.12} />
      </mesh>
      <mesh position={[-2.34, 0.14, -1.22]} castShadow>
        <boxGeometry args={[0.4, 0.28, 0.18]} />
        <meshStandardMaterial color="#233038" roughness={0.6} metalness={0.18} />
      </mesh>
      <mesh position={[-2.34, 0.34, -1.22]} castShadow>
        <boxGeometry args={[0.46, 0.06, 0.22]} />
        <meshStandardMaterial color="#d8a33c" roughness={0.46} metalness={0.18} />
      </mesh>
      <mesh position={[2.24, 0.14, 1.1]} castShadow>
        <boxGeometry args={[0.36, 0.28, 0.16]} />
        <meshStandardMaterial color="#20323a" roughness={0.6} metalness={0.2} />
      </mesh>
      {([-1, 1] as const).map((side) => (
        <mesh key={`chock-${side}`} position={[side * 0.34, 0.04, 0.24]} rotation={[0, 0.4 * side, 0]} castShadow>
          <boxGeometry args={[0.1, 0.08, 0.18]} />
          <meshStandardMaterial color="#d8a33c" roughness={0.58} metalness={0.1} />
        </mesh>
      ))}
    </group>
  );
}

function propulsionSamples(point: PropulsionPoint | undefined) {
  if (!point) return [];
  const speeds = [0, 40, 80, 120, 160];
  const samples = speeds.map((speed) => {
    const sample = samplePropulsion(point, speed, 1.225, 1);
    return {
      speed,
      thrustN: sample.thrustN,
      thrustKn: `${(sample.thrustN / 1000).toFixed(1)} kN`,
    };
  });
  const max = Math.max(...samples.map((sample) => Math.abs(sample.thrustN)), 1);
  return samples.map((sample) => ({
    ...sample,
    percent: Math.max(4, Math.min(100, (Math.max(sample.thrustN, 0) / max) * 100)),
  }));
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
        <PoseSliders part={part} onChange={onChange} />
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
        <PoseSliders part={part} onChange={onChange} />
        <Slider
          label="incidence"
          value={wingIncidenceDeg(wing)}
          min={-8}
          max={8}
          step={0.5}
          onChange={(v) =>
            onChange((p) => {
              const w = p as WingPart;
              return { ...w, pose: { ...w.pose, rotation: quatFromAxisAngle(vec3(1, 0, 0), (v * Math.PI) / 180) } };
            })
          }
        />
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
    const powerHp = Math.round(((part.maxPowerW ?? part.thrustN * 36) / 745.7) * 10) / 10;
    return (
      <>
        <Slider
          label="power (hp)"
          value={powerHp}
          min={300}
          max={3600}
          step={25}
          onChange={(v) =>
            onChange((p) => ({
              ...(p as EnginePart),
              maxPowerW: Math.round(v * 745.7),
              thrustN: Math.round(v * 46),
            }))
          }
        />
        <Slider
          label="fallback kN"
          value={part.thrustN / 1000}
          min={5}
          max={200}
          step={1}
          onChange={(v) => onChange((p) => ({ ...(p as EnginePart), thrustN: v * 1000 }))}
        />
        <Slider
          label="idle rpm"
          value={part.idleRpm ?? 650}
          min={400}
          max={1100}
          step={25}
          onChange={(v) => onChange((p) => ({ ...(p as EnginePart), idleRpm: v }))}
        />
        <Slider
          label="max rpm"
          value={part.maxRpm ?? 2800}
          min={1800}
          max={3600}
          step={50}
          onChange={(v) => onChange((p) => ({ ...(p as EnginePart), maxRpm: v }))}
        />
        <Slider
          label="critical altitude"
          value={part.criticalAltitudeM ?? 0}
          min={0}
          max={9000}
          step={250}
          onChange={(v) => onChange((p) => ({ ...(p as EnginePart), criticalAltitudeM: v }))}
        />
        <MassSlider part={part} onChange={onChange} max={4000} />
        <PoseSliders part={part} onChange={onChange} />
      </>
    );
  }

  if (part.kind === "prop") {
    return (
      <>
        <Slider label="radius" value={part.radius} min={0.5} max={3.6} step={0.05} onChange={(v) => onChange((p) => ({ ...(p as PropPart), radius: v }))} />
        <Slider label="pitch" value={part.pitchM} min={0.5} max={3.2} step={0.05} onChange={(v) => onChange((p) => ({ ...(p as PropPart), pitchM: v }))} />
        <Slider label="blades" value={part.bladeCount} min={2} max={6} step={1} onChange={(v) => onChange((p) => ({ ...(p as PropPart), bladeCount: Math.round(v) }))} />
        <div style={S.fieldRow}>
          <span style={S.fieldLabel}>mode</span>
          <select
            style={S.select}
            value={part.mode}
            onChange={(e) => onChange((p) => ({ ...(p as PropPart), mode: e.target.value as PropPart["mode"] }))}
          >
            <option value="fixed-pitch">fixed-pitch</option>
            <option value="constant-speed">constant-speed</option>
          </select>
        </div>
        <MassSlider part={part} onChange={onChange} max={600} />
        <PoseSliders part={part} onChange={onChange} />
      </>
    );
  }

  if (part.kind === "canopy") {
    const set = (k: keyof CanopyPart["dims"], v: number) =>
      onChange((p) => ({ ...(p as CanopyPart), dims: { ...(p as CanopyPart).dims, [k]: v } }));
    return (
      <>
        <Slider label="length" value={part.dims.length} min={0.5} max={5} step={0.1} onChange={(v) => set("length", v)} />
        <Slider label="width" value={part.dims.width} min={0.2} max={2} step={0.05} onChange={(v) => set("width", v)} />
        <Slider label="height" value={part.dims.height} min={0.2} max={1.6} step={0.05} onChange={(v) => set("height", v)} />
        <div style={S.fieldRow}>
          <span style={S.fieldLabel}>style</span>
          <select
            style={S.select}
            value={part.style}
            onChange={(e) => onChange((p) => ({ ...(p as CanopyPart), style: e.target.value as CanopyPart["style"] }))}
          >
            <option value="razorback">razorback</option>
            <option value="bubble">bubble</option>
            <option value="framed">framed</option>
            <option value="greenhouse">greenhouse</option>
          </select>
        </div>
        <MassSlider part={part} onChange={onChange} max={400} />
        <PoseSliders part={part} onChange={onChange} />
      </>
    );
  }

  if (part.kind === "gear") {
    return (
      <>
        <Slider label="track" value={part.trackM} min={0.4} max={7} step={0.1} onChange={(v) => onChange((p) => ({ ...(p as GearPart), trackM: v }))} />
        <Slider label="height" value={part.heightM} min={0.2} max={2.5} step={0.05} onChange={(v) => onChange((p) => ({ ...(p as GearPart), heightM: v }))} />
        <Slider label="wheel" value={part.wheelRadiusM} min={0.08} max={0.7} step={0.02} onChange={(v) => onChange((p) => ({ ...(p as GearPart), wheelRadiusM: v }))} />
        <div style={S.fieldRow}>
          <span style={S.fieldLabel}>style</span>
          <select
            style={S.select}
            value={part.style}
            onChange={(e) => onChange((p) => ({ ...(p as GearPart), style: e.target.value as GearPart["style"] }))}
          >
            <option value="taildragger">taildragger</option>
            <option value="tricycle">tricycle</option>
            <option value="skid">skid</option>
          </select>
        </div>
        <MassSlider part={part} onChange={onChange} max={1000} />
        <PoseSliders part={part} onChange={onChange} />
      </>
    );
  }

  if (part.kind === "weapon") {
    return (
      <>
        <Slider label="count" value={part.count} min={1} max={12} step={1} onChange={(v) => onChange((p) => ({ ...(p as WeaponPart), count: Math.round(v) }))} />
        <Slider label="caliber" value={part.caliberMm} min={7.62} max={120} step={0.5} onChange={(v) => onChange((p) => ({ ...(p as WeaponPart), caliberMm: v }))} />
        <div style={S.fieldRow}>
          <span style={S.fieldLabel}>role</span>
          <select
            style={S.select}
            value={part.role}
            onChange={(e) => onChange((p) => ({ ...(p as WeaponPart), role: e.target.value as WeaponPart["role"] }))}
          >
            <option value="machine-gun">machine-gun</option>
            <option value="cannon">cannon</option>
            <option value="rocket-rail">rocket-rail</option>
            <option value="bomb-rack">bomb-rack</option>
          </select>
        </div>
        <MassSlider part={part} onChange={onChange} max={1400} />
        <PoseSliders part={part} onChange={onChange} />
      </>
    );
  }

  if (part.kind === "tank") {
    return (
      <>
        <Slider label="fuel (kg)" value={part.fuelKg} min={0} max={5000} step={50} onChange={(v) => onChange((p) => ({ ...(p as TankPart), fuelKg: v }))} />
        <Slider label="tank mass" value={part.dryMassKg} min={0} max={1000} step={25} onChange={(v) => onChange((p) => ({ ...(p as TankPart), dryMassKg: v }))} />
        <PoseSliders part={part} onChange={onChange} />
      </>
    );
  }

  if (part.kind === "crew-station") {
    const setSeat = (key: keyof CrewStationPart["seat"], axis: "x" | "y" | "z", value: number) =>
      onChange((p) => {
        const station = p as CrewStationPart;
        return { ...station, seat: { ...station.seat, [key]: { ...station.seat[key], [axis]: value } } };
      });
    const setControl = (key: keyof CrewStationPart["controls"], axis: "x" | "y" | "z", value: number) =>
      onChange((p) => {
        const station = p as CrewStationPart;
        return {
          ...station,
          controls: { ...station.controls, [key]: { ...station.controls[key], [axis]: value } },
        };
      });
    return (
      <>
        <div style={S.sensorNote}>pilot socket · canopy {part.canopyId ?? "auto"}</div>
        <PoseSliders part={part} onChange={onChange} />
        <VectorSliders label="hip" value={part.seat.hip} onChange={(axis, value) => setSeat("hip", axis, value)} />
        <VectorSliders label="eye" value={part.seat.eye} onChange={(axis, value) => setSeat("eye", axis, value)} />
        <VectorSliders label="stick" value={part.controls.stick} onChange={(axis, value) => setControl("stick", axis, value)} />
        <VectorSliders
          label="throttle"
          value={part.controls.throttle}
          onChange={(axis, value) => setControl("throttle", axis, value)}
        />
        <VectorSliders label="panel" value={part.controls.panel} onChange={(axis, value) => setControl("panel", axis, value)} />
      </>
    );
  }

  // sensor — pose/optics editing is advanced; show its identity for now.
  return <div style={S.sensorNote}>{part.modality} sensor · range {Math.round(part.for.maxRangeM)} m</div>;
}

function wingIncidenceDeg(part: WingPart): number {
  return (2 * Math.atan2(part.pose.rotation.x, part.pose.rotation.w) * 180) / Math.PI;
}

function PoseSliders({
  part,
  onChange,
}: {
  part: Exclude<Part, { kind: "sensor" }>;
  onChange: (fn: (p: Part) => Part) => void;
}) {
  const setOffset = (axis: "x" | "y" | "z", value: number) =>
    onChange((p) => ({ ...p, pose: { ...p.pose, offset: { ...p.pose.offset, [axis]: value } } }) as Part);
  return (
    <>
      <Slider label="x offset" value={part.pose.offset.x} min={-8} max={8} step={0.25} onChange={(v) => setOffset("x", v)} />
      <Slider label="y offset" value={part.pose.offset.y} min={-3} max={5} step={0.25} onChange={(v) => setOffset("y", v)} />
      <Slider label="z offset" value={part.pose.offset.z} min={-8} max={8} step={0.25} onChange={(v) => setOffset("z", v)} />
    </>
  );
}

function VectorSliders({
  label,
  value,
  onChange,
}: {
  label: string;
  value: { x: number; y: number; z: number };
  onChange: (axis: "x" | "y" | "z", value: number) => void;
}) {
  return (
    <>
      <Slider label={`${label} x`} value={value.x} min={-4} max={4} step={0.05} onChange={(v) => onChange("x", v)} />
      <Slider label={`${label} y`} value={value.y} min={-2} max={3} step={0.05} onChange={(v) => onChange("y", v)} />
      <Slider label={`${label} z`} value={value.z} min={-6} max={3} step={0.05} onChange={(v) => onChange("z", v)} />
    </>
  );
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
  if (part.kind === "sensor" || part.kind === "tank" || part.kind === "crew-station") return null; // sockets/tanks carry no mass slider
  return (
    <Slider
      label="mass"
      value={part.massKg}
      min={0}
      max={max}
      step={50}
      onChange={(v) =>
        onChange((p) => ({
          ...(p as FuselagePart | WingPart | EnginePart | PropPart | CanopyPart | GearPart | WeaponPart),
          massKg: v,
        }))
      }
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
      return {
        id,
        kind,
        pose: { offset: vec3(0, 0, -4), rotation: quatIdentity() },
        thrustN: 55_000,
        maxPowerW: Math.round(1200 * 745.7),
        criticalAltitudeM: 0,
        idleRpm: 650,
        maxRpm: 2850,
        massKg: 600,
        dims: { radius: 0.4, length: 2 },
      };
    case "prop":
      return { id, kind, pose: { offset: vec3(0, 0, -4.7), rotation: quatIdentity() }, radius: 1.6, pitchM: 2.25, bladeCount: 3, mode: "constant-speed", massKg: 85 };
    case "canopy":
      return { id, kind, pose: { offset: vec3(0, 0.75, -1.4), rotation: quatIdentity() }, dims: { length: 1.8, width: 0.75, height: 0.5 }, massKg: 90, style: "bubble" };
    case "crew-station": {
      const eye = vec3(0, 0.78, -1.25);
      const hip = vec3(0, eye.y - 0.456, eye.z - 0.15);
      return {
        id,
        kind,
        role: "pilot",
        pose: { offset: vec3(0, 0, 0), rotation: quatIdentity() },
        canopyId: "canopy",
        seat: {
          hip,
          back: vec3(hip.x, hip.y + 0.426, hip.z + 0.23),
          eye,
        },
        controls: {
          stick: vec3(hip.x + 0.12, hip.y - 0.224, hip.z - 0.6),
          throttle: vec3(hip.x - 0.24, hip.y - 0.224, hip.z - 0.45),
          leftPedal: vec3(hip.x - 0.22, hip.y - 0.104, hip.z - 0.99),
          rightPedal: vec3(hip.x + 0.22, hip.y - 0.104, hip.z - 0.99),
          panel: vec3(hip.x, hip.y + 0.106, hip.z - 0.7),
        },
      };
    }
    case "gear":
      return { id, kind, pose: { offset: vec3(0, -0.75, 0.2), rotation: quatIdentity() }, trackM: 2.6, heightM: 0.8, wheelRadiusM: 0.22, massKg: 220, style: "taildragger" };
    case "weapon":
      return { id, kind, pose: { offset: vec3(0, -0.15, -1.4), rotation: quatIdentity() }, count: 2, caliberMm: 20, massKg: 120, dims: { length: 1.1, width: 0.06, height: 0.06 }, role: "cannon" };
    case "tank":
      return { id, kind, pose: { offset: vec3(0, 0, 0), rotation: quatIdentity() }, fuelKg: 1_500, dryMassKg: 200, dims: { radius: 0.5, length: 2.5 } };
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
  headerCompact: {
    alignItems: "flex-start",
    gap: 12,
    padding: "14px 16px",
    flexWrap: "wrap",
  },
  headerActions: { display: "flex", gap: 10 },
  headerActionsCompact: { display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "flex-start" },
  eyebrow: { margin: 0, fontSize: 11, letterSpacing: 2, textTransform: "uppercase", color: "#7f95a3" },
  title: { margin: "2px 0 0", fontSize: 24 },
  body: { flex: 1, display: "grid", gridTemplateColumns: "minmax(360px, 460px) 1fr", minHeight: 0 },
  bodyCompact: { flex: 1, display: "flex", flexDirection: "column", minHeight: 0, overflowY: "auto" },
  editor: { borderRight: "1px solid rgba(255,255,255,0.08)", display: "flex", flexDirection: "column", minHeight: 0 },
  editorCompact: { borderRight: "none", borderBottom: "1px solid rgba(255,255,255,0.08)", minHeight: "auto", flex: "0 0 auto" },
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
  sectionHeadCompact: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    padding: "9px 14px",
    fontSize: 11,
    letterSpacing: 1.2,
    color: "#9fb2bd",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
  },
  addTray: {
    display: "flex",
    flexWrap: "wrap",
    gap: 7,
    justifyContent: "flex-start",
    padding: "10px 14px 12px",
    borderBottom: "1px solid rgba(255,255,255,0.06)",
  },
  archetypeList: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 8,
    padding: 12,
    borderBottom: "1px solid rgba(255,255,255,0.06)",
  },
  archetypeBtn: {
    width: "100%",
    height: "auto",
    minHeight: 58,
    background: "rgba(14,20,24,0.82)",
    color: "#e7eef2",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 8,
    padding: "8px 9px",
    display: "grid",
    gridTemplateColumns: "18px 1fr",
    gridTemplateRows: "1fr 1fr",
    columnGap: 8,
    textAlign: "left",
    cursor: "pointer",
  },
  swatch: {
    gridRow: "1 / span 2",
    width: 18,
    height: 18,
    borderRadius: 5,
    border: "2px solid rgba(255,255,255,0.35)",
    alignSelf: "center",
  },
  archetypeName: { fontSize: 12, fontWeight: 700, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  archetypeRole: { fontSize: 10, color: "#8aa0ad", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  partList: { overflowY: "auto", padding: 14, display: "flex", flexDirection: "column", gap: 12 },
  partListCompact: { overflowY: "visible" },
  partRoster: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 8,
    maxHeight: 132,
    overflowY: "auto",
    paddingRight: 2,
  },
  partRosterBtn: {
    width: "100%",
    height: "auto",
    minHeight: 48,
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    justifyContent: "center",
    gap: 2,
    padding: "8px 10px",
    border: "1px solid rgba(255,255,255,0.08)",
    borderRadius: 8,
    background: "rgba(255,255,255,0.035)",
    color: "#e7eef2",
    cursor: "pointer",
  },
  partRosterKind: { color: BLUE, fontSize: 11, fontWeight: 800, letterSpacing: 1, textTransform: "uppercase" },
  partRosterId: { maxWidth: "100%", color: "#8aa0ad", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  right: { display: "flex", flexDirection: "column", minHeight: 0 },
  rightCompact: { minHeight: "auto", flex: "0 0 auto" },
  brief: {
    display: "grid",
    gridTemplateColumns: "minmax(280px, 1.2fr) minmax(300px, 1fr)",
    gap: 14,
    padding: "12px 16px",
    background: "#0e1418",
    borderBottom: "1px solid rgba(255,255,255,0.08)",
  },
  briefCompact: { gridTemplateColumns: "1fr", padding: "12px 14px" },
  briefTitle: { margin: "2px 0 4px", fontSize: 18 },
  briefText: { margin: 0, color: "#aebdc5", fontSize: 13, lineHeight: 1.4 },
  referenceGrid: { display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 8 },
  referenceGridCompact: { gridTemplateColumns: "1fr" },
  referenceCard: {
    display: "flex",
    flexDirection: "column",
    gap: 3,
    padding: "8px 9px",
    background: "rgba(255,255,255,0.04)",
    border: "1px solid rgba(255,255,255,0.07)",
    borderRadius: 8,
    color: "#91a7b2",
    fontSize: 11,
    minWidth: 0,
  },
  referenceName: { color: "#e7eef2", fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  preview: { flex: 1, minHeight: 240, background: "#0c141b" },
  previewCompact: { flex: "0 0 auto", minHeight: 280 },
  propCurve: {
    background: "#0e1418",
    borderTop: "1px solid rgba(255,255,255,0.08)",
  },
  curveBars: { minHeight: 94, display: "flex", alignItems: "flex-end", gap: 12, padding: "12px 16px" },
  curveBarCol: { width: 64, display: "flex", flexDirection: "column", alignItems: "center", gap: 4, fontSize: 11, color: "#91a7b2" },
  curveTrack: {
    height: 54,
    width: 14,
    borderRadius: 3,
    background: "rgba(255,255,255,0.08)",
    display: "flex",
    alignItems: "flex-end",
    overflow: "hidden",
  },
  curveFill: { width: "100%", background: "#f4a340" },
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
  card: { background: panel, borderRadius: 8, padding: 12, border: "1px solid rgba(255,255,255,0.06)" },
  cardHead: { display: "flex", alignItems: "center", gap: 8, marginBottom: 8 },
  cardKind: { fontSize: 12, fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, color: BLUE },
  cardId: { fontSize: 12, color: "#8aa0ad" },
  fieldRow: { display: "flex", alignItems: "center", gap: 10, marginTop: 6 },
  fieldLabel: { fontSize: 12, color: "#9fb2bd", width: 96, flexShrink: 0 },
  fieldValue: { fontSize: 12, color: "#e7eef2", width: 48, textAlign: "right", flexShrink: 0, fontVariantNumeric: "tabular-nums" },
  range: { flex: 1, accentColor: BLUE },
  select: { flex: 1, background: "#0e1418", color: "#e7eef2", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, padding: "4px 6px" },
  sensorNote: { fontSize: 12, color: "#8aa0ad" },
  addBtn: {
    width: "auto",
    height: "auto",
    minHeight: 34,
    background: "rgba(77,163,255,0.14)",
    color: BLUE,
    border: "1px solid rgba(77,163,255,0.3)",
    borderRadius: 6,
    padding: "4px 8px",
    fontSize: 12,
    cursor: "pointer",
  },
  iconBtn: { background: "transparent", color: "#9fb2bd", border: "1px solid rgba(255,255,255,0.12)", borderRadius: 6, width: 26, height: 26, cursor: "pointer" },
  ghostBtn: {
    width: "auto",
    height: "auto",
    background: "transparent",
    color: "#cdd9e0",
    border: "1px solid rgba(255,255,255,0.18)",
    borderRadius: 8,
    padding: "8px 14px",
    cursor: "pointer",
    fontSize: 14,
    whiteSpace: "nowrap",
  },
  flyBtn: {
    width: "auto",
    height: "auto",
    background: BLUE,
    color: "#04101c",
    border: "none",
    borderRadius: 8,
    padding: "8px 18px",
    cursor: "pointer",
    fontSize: 14,
    fontWeight: 700,
    whiteSpace: "nowrap",
  },
};
