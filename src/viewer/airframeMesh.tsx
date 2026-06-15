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
const PROP_COLOR = "#1b2328";
const CANOPY_COLOR = "#8ad8ff";
const GEAR_COLOR = "#d8dee2";
const WEAPON_COLOR = "#2b3338";
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

  if (part.kind === "prop") {
    const radius = part.radius * s;
    const hubRadius = radius * 0.13;
    const bladeLength = radius * 0.88;
    const bladeWidth = Math.max(radius * 0.11, 0.012);
    const bladeThickness = Math.max(radius * 0.025, 0.004);
    return (
      <group position={pos} quaternion={quat}>
        <mesh castShadow rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[hubRadius, hubRadius * 0.85, bladeThickness * 3, 14]} />
          <meshStandardMaterial color={ENGINE_COLOR} roughness={0.38} metalness={0.5} />
        </mesh>
        {Array.from({ length: part.bladeCount }, (_, i) => {
          const angle = (i / part.bladeCount) * Math.PI * 2;
          return (
            <mesh
              key={`${part.id}-blade-${i}`}
              castShadow
              position={[Math.cos(angle) * bladeLength * 0.42, Math.sin(angle) * bladeLength * 0.42, 0]}
              rotation={[0, 0, angle]}
            >
              <boxGeometry args={[bladeLength, bladeWidth, bladeThickness]} />
              <meshStandardMaterial color={PROP_COLOR} roughness={0.46} metalness={0.18} />
            </mesh>
          );
        })}
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[radius, radius, 0.003, 48]} />
          <meshBasicMaterial color="#d9eef6" transparent opacity={0.13} depthWrite={false} />
        </mesh>
      </group>
    );
  }

  if (part.kind === "canopy") {
    const w = part.dims.width * s;
    const h = part.dims.height * s;
    const l = part.dims.length * s;
    const frameCount = part.style === "greenhouse" ? 5 : part.style === "framed" ? 3 : 1;
    return (
      <group position={pos} quaternion={quat}>
        <mesh castShadow>
          <boxGeometry args={[w, h, l]} />
          <meshStandardMaterial
            color={CANOPY_COLOR}
            transparent
            opacity={0.48}
            roughness={0.08}
            metalness={0.08}
          />
        </mesh>
        {Array.from({ length: frameCount }, (_, i) => {
          const z = frameCount === 1 ? 0 : -l * 0.38 + (i / (frameCount - 1)) * l * 0.76;
          return (
            <mesh key={`${part.id}-frame-${i}`} position={[0, 0, z]}>
              <boxGeometry args={[w * 1.08, h * 0.12, Math.max(l * 0.035, 0.006)]} />
              <meshStandardMaterial color={NOSE_COLOR} roughness={0.36} metalness={0.32} />
            </mesh>
          );
        })}
      </group>
    );
  }

  if (part.kind === "gear") {
    const track = part.trackM * s;
    const height = part.heightM * s;
    const wheelRadius = part.wheelRadiusM * s;
    const stance: number[] = part.style === "skid" ? [-0.45, 0.45] : [-0.5, 0.5];
    return (
      <group position={pos} quaternion={quat}>
        {stance.map((side) => (
          <group key={`${part.id}-${side}`} position={[side * track, -height * 0.45, 0]}>
            <mesh castShadow>
              <boxGeometry args={[Math.max(wheelRadius * 0.18, 0.005), height, Math.max(wheelRadius * 0.18, 0.005)]} />
              <meshStandardMaterial color={GEAR_COLOR} roughness={0.5} metalness={0.45} />
            </mesh>
            {part.style === "skid" ? (
              <mesh castShadow position={[0, -height * 0.52, 0.08]}>
                <boxGeometry args={[wheelRadius * 0.35, wheelRadius * 0.18, wheelRadius * 2.8]} />
                <meshStandardMaterial color={PROP_COLOR} roughness={0.62} metalness={0.12} />
              </mesh>
            ) : (
              <mesh castShadow position={[0, -height * 0.55, 0]} rotation={[0, 0, Math.PI / 2]}>
                <cylinderGeometry args={[wheelRadius, wheelRadius, Math.max(wheelRadius * 0.42, 0.012), 16]} />
                <meshStandardMaterial color={PROP_COLOR} roughness={0.68} metalness={0.12} />
              </mesh>
            )}
          </group>
        ))}
      </group>
    );
  }

  if (part.kind === "weapon") {
    const len = part.dims.length * s;
    const w = part.dims.width * s;
    const h = part.dims.height * s;
    const spacing = Math.max(w * 2.2, 0.035);
    const start = -((part.count - 1) * spacing) / 2;
    return (
      <group position={pos} quaternion={quat}>
        {Array.from({ length: part.count }, (_, i) => (
          <mesh key={`${part.id}-${i}`} castShadow position={[start + i * spacing, 0, 0]}>
            <boxGeometry args={[w, h, len]} />
            <meshStandardMaterial
              color={part.role === "bomb-rack" || part.role === "rocket-rail" ? TANK_COLOR : WEAPON_COLOR}
              roughness={0.48}
              metalness={0.42}
            />
          </mesh>
        ))}
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
