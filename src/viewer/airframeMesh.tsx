import { useMemo } from "react";
import { BufferGeometry, DoubleSide, Float32BufferAttribute } from "three";
import type { ControlInput, Part, SurfaceControlSnapshot } from "../protocol/schema";

// Renders an aircraft from its airframe parts — the plane you build is the plane you see. Shared by the
// flight scene (parent group is driven imperatively by SceneDriver) and the builder preview.
//
// PART_VISUAL_SCALE maps metres → scene units, chosen so the default airframe reads at about the size of
// the previous hand-built mesh. Display-only: the sim works in metres and never reads any of this.
export const PART_VISUAL_SCALE = 0.075;
const WING_THICKNESS = 0.04;
const ENGINE_COLOR = "#9aa6ad";
const PANEL_COLOR = "#d8e6ec";
const TANK_COLOR = "#c9a14a";
const CONTROL_SURFACE_COLOR = "#f4a340";
const PROP_COLOR = "#1b2328";
const CANOPY_COLOR = "#8ad8ff";
const CANOPY_FRAME_COLOR = "#a9c4ce";
const GEAR_COLOR = "#d8dee2";
const WEAPON_COLOR = "#2b3338";
const DEG = Math.PI / 180;

interface TaperedBoxProps {
  length: number;
  frontWidth: number;
  frontHeight: number;
  backWidth: number;
  backHeight: number;
}

function taperedBoxGeometry({
  length,
  frontWidth,
  frontHeight,
  backWidth,
  backHeight,
}: TaperedBoxProps): BufferGeometry {
  const fz = -length / 2;
  const bz = length / 2;
  const fw = frontWidth / 2;
  const fh = frontHeight / 2;
  const bw = backWidth / 2;
  const bh = backHeight / 2;
  const vertices = new Float32Array([
    -fw,
    -fh,
    fz,
    fw,
    -fh,
    fz,
    fw,
    fh,
    fz,
    -fw,
    fh,
    fz,
    -bw,
    -bh,
    bz,
    bw,
    -bh,
    bz,
    bw,
    bh,
    bz,
    -bw,
    bh,
    bz,
  ]);
  const indices = [
    0, 1, 2, 0, 2, 3,
    5, 4, 7, 5, 7, 6,
    4, 5, 1, 4, 1, 0,
    3, 2, 6, 3, 6, 7,
    1, 5, 6, 1, 6, 2,
    4, 0, 3, 4, 3, 7,
  ];
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function wingPanelGeometry(span: number, rootChord: number, tipChord: number, thickness: number, side: -1 | 1) {
  const tipX = side * span;
  const sweep = rootChord * 0.05;
  const rootFront = -rootChord / 2;
  const rootBack = rootChord / 2;
  const tipFront = -tipChord / 2 + sweep;
  const tipBack = tipChord / 2 + sweep;
  const y0 = -thickness / 2;
  const y1 = thickness / 2;
  const vertices = new Float32Array([
    0,
    y0,
    rootFront,
    0,
    y0,
    rootBack,
    tipX,
    y0,
    tipBack,
    tipX,
    y0,
    tipFront,
    0,
    y1,
    rootFront,
    0,
    y1,
    rootBack,
    tipX,
    y1,
    tipBack,
    tipX,
    y1,
    tipFront,
  ]);
  const indices = [
    0, 1, 2, 0, 2, 3,
    4, 7, 6, 4, 6, 5,
    0, 4, 5, 0, 5, 1,
    3, 2, 6, 3, 6, 7,
    1, 5, 6, 1, 6, 2,
    0, 3, 7, 0, 7, 4,
  ];
  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new Float32BufferAttribute(vertices, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function TaperedBox({
  color,
  args,
  roughness = 0.48,
  metalness = 0.18,
  opacity,
}: {
  color: string;
  args: TaperedBoxProps;
  roughness?: number;
  metalness?: number;
  opacity?: number;
}) {
  const geometry = useMemo(() => taperedBoxGeometry(args), [args]);
  return (
    <mesh castShadow receiveShadow>
      <primitive object={geometry} attach="geometry" />
      <meshStandardMaterial
        color={color}
        roughness={roughness}
        metalness={metalness}
        flatShading
        transparent={opacity !== undefined}
        opacity={opacity ?? 1}
      />
    </mesh>
  );
}

function WingPanel({
  side,
  span,
  chord,
  thickness,
  color,
}: {
  side: -1 | 1;
  span: number;
  chord: number;
  thickness: number;
  color: string;
}) {
  const geometry = useMemo(
    () => wingPanelGeometry(span, chord, Math.max(chord * 0.58, 0.03), thickness, side),
    [span, chord, thickness, side],
  );
  return (
    <mesh castShadow receiveShadow>
      <primitive object={geometry} attach="geometry" />
      <meshStandardMaterial color={color} roughness={0.5} metalness={0.16} flatShading side={DoubleSide} />
    </mesh>
  );
}

function PartMesh({
  part,
  color,
  accentColor,
  propSpin,
  surfaceControls,
}: {
  part: Part;
  color: string;
  accentColor: string;
  propSpin: number;
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
    const noseLength = Math.min(l * 0.2, h * 1.3);
    const tailLength = Math.min(l * 0.16, h * 1.05);
    const coreLength = Math.max(l - noseLength - tailLength, l * 0.48);
    return (
      <group position={pos} quaternion={quat}>
        <group position={[0, 0, -l / 2 + noseLength / 2]}>
          <TaperedBox
            color={color}
            args={{
              length: noseLength,
              frontWidth: w * 0.56,
              frontHeight: h * 0.64,
              backWidth: w * 0.96,
              backHeight: h * 0.9,
            }}
          />
        </group>
        <mesh castShadow receiveShadow position={[0, 0, -l / 2 + noseLength + coreLength / 2]}>
          <boxGeometry args={[w, h, coreLength]} />
          <meshStandardMaterial color={color} roughness={0.48} metalness={0.2} flatShading />
        </mesh>
        <group position={[0, 0, l / 2 - tailLength / 2]}>
          <TaperedBox
            color={color}
            args={{
              length: tailLength,
              frontWidth: w * 0.9,
              frontHeight: h * 0.82,
              backWidth: w * 0.48,
              backHeight: h * 0.56,
            }}
          />
        </group>
        <mesh position={[0, h * 0.525, -l * 0.23]} castShadow>
          <boxGeometry args={[w * 0.42, h * 0.08, l * 0.18]} />
          <meshStandardMaterial color={accentColor} roughness={0.42} metalness={0.18} />
        </mesh>
        <mesh position={[0, h * 0.525, l * 0.24]} castShadow>
          <boxGeometry args={[w * 0.34, h * 0.075, l * 0.14]} />
          <meshStandardMaterial color={PANEL_COLOR} roughness={0.44} metalness={0.18} />
        </mesh>
        <mesh position={[-w * 0.51, h * 0.05, -l * 0.08]} castShadow>
          <boxGeometry args={[w * 0.035, h * 0.12, l * 0.52]} />
          <meshStandardMaterial color={accentColor} roughness={0.44} metalness={0.16} />
        </mesh>
        <mesh position={[w * 0.51, h * 0.05, -l * 0.08]} castShadow>
          <boxGeometry args={[w * 0.035, h * 0.12, l * 0.52]} />
          <meshStandardMaterial color={accentColor} roughness={0.44} metalness={0.16} />
        </mesh>
      </group>
    );
  }

  if (part.kind === "wing") {
    const span = part.planform.span * s;
    const chord = part.planform.chord * s;
    // A yaw surface is vertical (a fin): its span runs up the Y axis. Others lie flat in the XZ plane.
    const vertical = part.control?.axis === "yaw";
    return (
      <group position={pos} quaternion={quat}>
        {vertical ? (
          <group position={[0, -span / 2, 0]} rotation={[0, 0, Math.PI / 2]}>
            <WingPanel side={1} span={span} chord={chord} thickness={WING_THICKNESS} color={color} />
          </group>
        ) : (
          <>
            <mesh castShadow receiveShadow>
              <boxGeometry args={[span * 0.14, WING_THICKNESS * 1.15, chord * 1.08]} />
              <meshStandardMaterial color={color} roughness={0.5} metalness={0.16} flatShading />
            </mesh>
            <WingPanel side={-1} span={span / 2} chord={chord} thickness={WING_THICKNESS} color={color} />
            <WingPanel side={1} span={span / 2} chord={chord} thickness={WING_THICKNESS} color={color} />
            <WingMarkings span={span} chord={chord} accentColor={accentColor} />
          </>
        )}
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
    const radial = part.dims.radius / Math.max(part.dims.length, 0.01) > 0.24;
    return (
      <group position={pos} quaternion={quat}>
        {radial ? (
          <>
            <mesh castShadow rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[radius, radius * 0.92, len, 18]} />
              <meshStandardMaterial color={ENGINE_COLOR} roughness={0.5} metalness={0.55} flatShading />
            </mesh>
            <mesh castShadow position={[0, 0, -len * 0.52]} rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[radius * 1.04, radius * 1.04, len * 0.08, 18]} />
              <meshStandardMaterial color={PANEL_COLOR} roughness={0.38} metalness={0.42} flatShading />
            </mesh>
          </>
        ) : (
          <>
            <TaperedBox
              color={ENGINE_COLOR}
              args={{
                length: len,
                frontWidth: radius * 1.45,
                frontHeight: radius * 1.45,
                backWidth: radius * 2.1,
                backHeight: radius * 1.62,
              }}
              roughness={0.46}
              metalness={0.48}
            />
            <mesh castShadow position={[0, radius * 0.55, -len * 0.04]}>
              <boxGeometry args={[radius * 1.16, radius * 0.18, len * 0.72]} />
              <meshStandardMaterial color={PANEL_COLOR} roughness={0.42} metalness={0.28} />
            </mesh>
          </>
        )}
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
              <meshStandardMaterial
                color={PROP_COLOR}
                roughness={0.46}
                metalness={0.18}
                transparent={propSpin > 0.35}
                opacity={propSpin > 0.35 ? 0.45 : 1}
              />
            </mesh>
          );
        })}
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[radius, radius, 0.003, 48]} />
          <meshBasicMaterial
            color="#d9eef6"
            transparent
            opacity={Math.max(0.02, Math.min(0.24, propSpin * 0.2))}
            depthWrite={false}
          />
        </mesh>
        {propSpin > 0.2 ? (
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[radius * 0.68, Math.max(radius * 0.015, 0.002), 8, 48]} />
            <meshBasicMaterial color={accentColor} transparent opacity={Math.min(0.16, propSpin * 0.12)} depthWrite={false} />
          </mesh>
        ) : null}
      </group>
    );
  }

  if (part.kind === "canopy") {
    const w = part.dims.width * s * 1.42;
    const h = part.dims.height * s * 1.75;
    const l = part.dims.length * s * 1.28;
    const frameCount = part.style === "greenhouse" ? 5 : part.style === "framed" ? 3 : 1;
    return (
      <group position={[pos[0], pos[1] + h * 0.16, pos[2]]} quaternion={quat}>
        <group position={[0, 0, 0]}>
          <TaperedBox
            color={CANOPY_COLOR}
            args={{
              length: l,
              frontWidth: w * 0.64,
              frontHeight: h * 0.72,
              backWidth: part.style === "razorback" ? w * 0.92 : w * 0.68,
              backHeight: part.style === "razorback" ? h * 0.42 : h * 0.72,
            }}
            roughness={0.08}
            metalness={0.18}
            opacity={0.68}
          />
        </group>
        <mesh position={[0, h * 0.47, 0]}>
          <boxGeometry args={[w * 0.52, Math.max(h * 0.035, 0.004), l * 0.76]} />
          <meshStandardMaterial
            color="#78d4ea"
            emissive="#2a6f80"
            emissiveIntensity={0.12}
            roughness={0.08}
            metalness={0.14}
            transparent
            opacity={0.72}
          />
        </mesh>
        {Array.from({ length: frameCount }, (_, i) => {
          const z = frameCount === 1 ? 0 : -l * 0.38 + (i / (frameCount - 1)) * l * 0.76;
          return (
            <mesh key={`${part.id}-frame-${i}`} position={[0, 0, z]}>
              <boxGeometry args={[w * 1.06, Math.max(h * 0.115, 0.008), Math.max(l * 0.035, 0.007)]} />
              <meshStandardMaterial color={CANOPY_FRAME_COLOR} roughness={0.36} metalness={0.28} />
            </mesh>
          );
        })}
        <mesh position={[-w * 0.52, 0, 0]}>
          <boxGeometry args={[Math.max(w * 0.045, 0.006), h * 0.72, l * 0.88]} />
          <meshStandardMaterial color={CANOPY_FRAME_COLOR} roughness={0.36} metalness={0.28} />
        </mesh>
        <mesh position={[w * 0.52, 0, 0]}>
          <boxGeometry args={[Math.max(w * 0.045, 0.006), h * 0.72, l * 0.88]} />
          <meshStandardMaterial color={CANOPY_FRAME_COLOR} roughness={0.36} metalness={0.28} />
        </mesh>
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

function WingMarkings({
  span,
  chord,
  accentColor,
}: {
  span: number;
  chord: number;
  accentColor: string;
}) {
  const markWidth = Math.max(span * 0.055, 0.018);
  const markDepth = Math.max(chord * 0.72, 0.035);
  return (
    <>
      {([-1, 1] as const).map((side) => (
        <group key={`marking-${side}`} position={[side * span * 0.29, WING_THICKNESS * 0.72, -chord * 0.02]}>
          <mesh castShadow>
            <boxGeometry args={[markWidth, WING_THICKNESS * 0.22, markDepth]} />
            <meshStandardMaterial color={accentColor} roughness={0.38} metalness={0.12} />
          </mesh>
          <mesh castShadow position={[side * markWidth * 1.35, 0, 0]}>
            <boxGeometry args={[markWidth * 0.42, WING_THICKNESS * 0.24, markDepth * 0.82]} />
            <meshStandardMaterial color={PANEL_COLOR} roughness={0.4} metalness={0.14} />
          </mesh>
        </group>
      ))}
    </>
  );
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
  accentColor = PANEL_COLOR,
  stalled: _stalled,
  surfaceControls = [],
  controls,
  propSpin,
}: {
  parts: Part[];
  color: string;
  accentColor?: string;
  stalled: boolean;
  surfaceControls?: SurfaceControlSnapshot[];
  controls?: ControlInput;
  propSpin?: number;
}) {
  const surfaceControlsById = new Map(surfaceControls.map((state) => [state.id, state]));
  const spin = propSpin ?? controls?.throttle ?? 0;
  return (
    <>
      {parts.map((part) => (
        <PartMesh
          key={part.id}
          part={part}
          color={color}
          accentColor={accentColor}
          propSpin={spin}
          surfaceControls={surfaceControlsById}
        />
      ))}
    </>
  );
}
