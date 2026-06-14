import type { Part } from "../protocol/schema";

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

function PartMesh({ part, color }: { part: Part; color: string }) {
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

export function PartMeshes({
  parts,
  color,
  stalled,
}: {
  parts: Part[];
  color: string;
  stalled: boolean;
}) {
  return (
    <>
      {parts.map((part) => (
        <PartMesh key={part.id} part={part} color={color} />
      ))}
      {/* energy/stall glow, sized to the airframe centre */}
      <mesh>
        <sphereGeometry args={[0.12, 16, 16]} />
        <meshBasicMaterial color={stalled ? "#f2c94c" : color} transparent opacity={0.7} />
      </mesh>
    </>
  );
}
