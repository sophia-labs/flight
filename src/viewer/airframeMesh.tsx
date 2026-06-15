import type { Part, SurfaceControlSnapshot } from "../protocol/schema";

// Renders an aircraft from its airframe parts — the plane you build is the plane you see. Shared by the
// flight scene (parent group is driven imperatively by SceneDriver) and the builder preview.
//
// PART_VISUAL_SCALE maps metres → scene units, chosen so the default airframe reads at about the size of
// the previous hand-built mesh. Display-only: the sim works in metres and never reads any of this.
export const PART_VISUAL_SCALE = 0.075;
const WING_THICKNESS = 0.04;
const ENGINE_COLOR = "#9aa6ad";
const NOSE_COLOR = "#f4fbff";
const TANK_COLOR = "#c9a14a";
const CONTROL_SURFACE_COLOR = "#f4a340";
const DEG = Math.PI / 180;

function PartMesh({
  part,
  color,
  surfaceControls,
}: {
  part: Part;
  color: string;
  surfaceControls: Map<string, SurfaceControlSnapshot>;
}) {
  if (part.kind === "sensor") return null; // a sensor has no structural body in the flight view

  const s = PART_VISUAL_SCALE;
  const o = part.pose.offset;
  const r = part.pose.rotation;
  const pos: [number, number, number] = [o.x * s, o.y * s, o.z * s];
  const quat: [number, number, number, number] = [r.x, r.y, r.z, r.w];

  if (part.kind === "fuselage") {
    const w = part.dims.width * s;
    const h = part.dims.height * s;
    const l = part.dims.length * s;
    return (
      <group position={pos} quaternion={quat}>
        <mesh castShadow>
          <boxGeometry args={[w, h, l]} />
          <meshStandardMaterial color={color} roughness={0.44} metalness={0.25} />
        </mesh>
        {/* nose cone at the forward tip (body forward is -Z) */}
        <mesh castShadow position={[0, 0, -l / 2 - h * 0.6]} rotation={[Math.PI / 2, 0, 0]}>
          <coneGeometry args={[Math.max(w, h) / 2, h * 1.6, 16]} />
          <meshStandardMaterial color={NOSE_COLOR} roughness={0.28} metalness={0.18} />
        </mesh>
      </group>
    );
  }

  if (part.kind === "wing") {
    const span = part.planform.span * s;
    const chord = part.planform.chord * s;
    // A yaw surface is vertical (a fin): its span runs up the Y axis. Others lie flat in the XZ plane.
    const vertical = part.control?.axis === "yaw";
    const dims: [number, number, number] = vertical
      ? [WING_THICKNESS, span, chord]
      : [span, WING_THICKNESS, chord];
    return (
      <group position={pos} quaternion={quat}>
        <mesh castShadow>
          <boxGeometry args={dims} />
          <meshStandardMaterial color={color} roughness={0.5} metalness={0.18} />
        </mesh>
        <WingControlSurfaces
          part={part}
          span={span}
          chord={chord}
          vertical={vertical}
          surfaceControls={surfaceControls}
        />
      </group>
    );
  }

  if (part.kind === "engine") {
    const radius = part.dims.radius * s;
    const len = part.dims.length * s;
    return (
      <group position={pos} quaternion={quat}>
        <mesh castShadow rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[radius, radius * 0.85, len, 16]} />
          <meshStandardMaterial color={ENGINE_COLOR} roughness={0.5} metalness={0.55} />
        </mesh>
      </group>
    );
  }

  if (part.kind === "tank") {
    const radius = part.dims.radius * s;
    const len = part.dims.length * s;
    return (
      <group position={pos} quaternion={quat}>
        <mesh castShadow rotation={[Math.PI / 2, 0, 0]}>
          <capsuleGeometry args={[radius, len, 6, 12]} />
          <meshStandardMaterial color={TANK_COLOR} roughness={0.6} metalness={0.3} />
        </mesh>
      </group>
    );
  }

  return null;
}

function WingControlSurfaces({
  part,
  span,
  chord,
  vertical,
  surfaceControls,
}: {
  part: Extract<Part, { kind: "wing" }>;
  span: number;
  chord: number;
  vertical: boolean;
  surfaceControls: Map<string, SurfaceControlSnapshot>;
}) {
  const axis = part.control?.axis;
  if (!axis) return null;

  if (axis === "roll") {
    return (
      <>
        <ControlPanel
          surfaceId={`${part.id}-left`}
          axis={axis}
          side={-1}
          span={span}
          chord={chord}
          vertical={false}
          surfaceControls={surfaceControls}
        />
        <ControlPanel
          surfaceId={`${part.id}-right`}
          axis={axis}
          side={1}
          span={span}
          chord={chord}
          vertical={false}
          surfaceControls={surfaceControls}
        />
      </>
    );
  }

  return (
    <ControlPanel
      surfaceId={part.id}
      axis={axis}
      span={span}
      chord={chord}
      vertical={vertical}
      surfaceControls={surfaceControls}
    />
  );
}

function ControlPanel({
  surfaceId,
  axis,
  side = 0,
  span,
  chord,
  vertical,
  surfaceControls,
}: {
  surfaceId: string;
  axis: "pitch" | "roll" | "yaw";
  side?: -1 | 0 | 1;
  span: number;
  chord: number;
  vertical: boolean;
  surfaceControls: Map<string, SurfaceControlSnapshot>;
}) {
  const state = surfaceControls.get(surfaceId);
  const deflectionRad = (state?.deflectionDeg ?? 0) * DEG;
  const panelChord = Math.max(chord * 0.32, 0.025);
  const hingeZ = chord / 2 - panelChord;
  const panelSpan = axis === "roll" ? span * 0.34 : span * 0.74;
  const centerX = axis === "roll" ? side * span * 0.31 : 0;
  const material = (
    <meshStandardMaterial
      color={CONTROL_SURFACE_COLOR}
      emissive={CONTROL_SURFACE_COLOR}
      emissiveIntensity={Math.min(0.22, Math.abs(deflectionRad) * 0.9 + 0.04)}
      roughness={0.42}
      metalness={0.18}
    />
  );

  if (vertical) {
    return (
      <group position={[0, 0, hingeZ]} rotation={[0, deflectionRad, 0]}>
        <mesh castShadow position={[WING_THICKNESS * 0.02, 0, panelChord / 2]}>
          <boxGeometry args={[WING_THICKNESS * 1.18, panelSpan, panelChord]} />
          {material}
        </mesh>
      </group>
    );
  }

  return (
    <group position={[centerX, WING_THICKNESS * 0.58, hingeZ]} rotation={[deflectionRad, 0, 0]}>
      <mesh castShadow position={[0, 0, panelChord / 2]}>
        <boxGeometry args={[panelSpan, WING_THICKNESS * 0.74, panelChord]} />
        {material}
      </mesh>
    </group>
  );
}

export function PartMeshes({
  parts,
  color,
  stalled,
  surfaceControls = [],
}: {
  parts: Part[];
  color: string;
  stalled: boolean;
  surfaceControls?: SurfaceControlSnapshot[];
}) {
  const surfaceControlsById = new Map(surfaceControls.map((state) => [state.id, state]));
  return (
    <>
      {parts.map((part) => (
        <PartMesh key={part.id} part={part} color={color} surfaceControls={surfaceControlsById} />
      ))}
      {/* energy/stall glow, sized to the airframe centre */}
      <mesh>
        <sphereGeometry args={[0.12, 16, 16]} />
        <meshBasicMaterial color={stalled ? "#f2c94c" : color} transparent opacity={0.7} />
      </mesh>
    </>
  );
}
