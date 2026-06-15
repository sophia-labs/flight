import { Line, OrbitControls, Sky } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useMemo, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import type {
  AircraftSnapshot,
  ControlInput,
  MatchReplay,
  Part,
  ReplayFrame,
  SurfaceControlSnapshot,
  Vec3,
} from "../protocol/schema";
import { defaultAirframe } from "../sim/airframe";
import { mountedSensorPose, selectCameraDevice } from "../sim/mountedSensor";
import type { SensorDevice } from "../sim/parts";
import { PART_VISUAL_SCALE, PartMeshes } from "./airframeMesh";
import { deriveSurfaceControls } from "./surfaceTelemetry";
import type { PlaybackClock } from "./usePlayback";

export type CameraMode = "orbit" | "cabin";

const SCENE_SCALE = 0.01;
const ACTIVE_AIRCRAFT_SCALE = 1.42;
const DEAD_AIRCRAFT_SCALE = 1.05;

interface FlightSceneProps {
  frame: ReplayFrame;
  replay: MatchReplay;
  cameraMode: CameraMode;
  pilotId?: string;
  clock: PlaybackClock;
  onIndex: (index: number) => void;
  onSample: (position: number) => void;
}

export function FlightScene({
  frame,
  replay,
  cameraMode,
  pilotId = "blue-1",
  clock,
  onIndex,
  onSample,
}: FlightSceneProps) {
  const controlsRef = useRef<any>(null);
  // Persistent aircraft groups, keyed by id — the SceneDriver moves them imperatively every
  // render frame so they glide between recorded states instead of snapping per tick.
  const shipRefs = useRef<Record<string, THREE.Group | null>>({});
  const roster = replay.frames[0].aircraft;
  // The plane each aircraft flew. Legacy replays (no airframes) fall back to the default so they still
  // render a recognizable jet rather than nothing.
  const fallbackParts = useMemo(() => defaultAirframe().parts, []);
  const pilotParts = replay.airframes?.[pilotId]?.parts ?? fallbackParts;
  const cockpitDevice = selectCameraDevice(pilotParts, "cockpit-cam");

  return (
    <>
      <color attach="background" args={["#aacbe6"]} />
      <fog attach="fog" args={["#c4dcef", 26, 130]} />
      <Sky distance={450000} sunPosition={[12, 22, 8]} turbidity={5} rayleigh={1.6} />
      <ambientLight intensity={0.5} />
      <hemisphereLight args={["#dff0ff", "#5a6b4a", 1.4]} />
      <directionalLight
        castShadow
        position={[12, 22, 8]}
        intensity={2.6}
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
      />
      <Terrain />

      <SceneDriver
        replay={replay}
        clock={clock}
        cameraMode={cameraMode}
        pilotId={pilotId}
        cockpitDevice={cockpitDevice}
        shipRefs={shipRefs}
        controlsRef={controlsRef}
        onIndex={onIndex}
        onSample={onSample}
      />
      {cameraMode === "orbit" ? (
        <OrbitControls
          ref={controlsRef}
          makeDefault
          enableDamping
          dampingFactor={0.08}
          minDistance={8}
          maxDistance={70}
        />
      ) : null}

      {roster.map((entry) => {
        const ship = frame.aircraft.find((candidate) => candidate.id === entry.id) ?? entry;
        const parts = replay.airframes?.[entry.id]?.parts ?? fallbackParts;
        return (
          <AircraftMesh
            key={entry.id}
            ship={ship}
            shipId={entry.id}
            parts={parts}
            showCockpit={entry.id === pilotId}
            refMap={shipRefs}
          />
        );
      })}

      {frame.aircraft.map((ship) => (
        <PathLine key={`path-${ship.id}`} ship={ship} replay={replay} frameIndex={frame.index} />
      ))}

      {frame.events
        .filter((event) => event.origin && event.impact)
        .map((event, index) => (
          <Line
            key={`${event.type}-${index}`}
            points={[toScenePoint(event.origin as Vec3), toScenePoint(event.impact as Vec3)]}
            color={event.type === "hit" ? "#f2c94c" : "#d7e5ea"}
            lineWidth={event.type === "hit" ? 3 : 1}
            transparent
            opacity={event.type === "hit" ? 0.95 : 0.42}
          />
        ))}
    </>
  );
}

function Terrain() {
  return (
    <group>
      {/* Larger ground so it reaches the fog horizon instead of reading as a floating island. */}
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <planeGeometry args={[240, 240]} />
        <meshStandardMaterial color="#4b6b48" roughness={0.95} metalness={0.02} />
      </mesh>
      <gridHelper args={[240, 96, "#6f8f74", "#3f5a42"]} position={[0, 0, 0]} />
    </group>
  );
}

// Single render-loop driver: advances the clock, interpolates every aircraft between the
// bracketing recorded frames (position lerp + orientation slerp), drives the camera from the
// same interpolated state, and reports the integer frame up to React at tick rate.
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const tmpQa = new THREE.Quaternion();
const tmpQb = new THREE.Quaternion();
const tmpPilotQ = new THREE.Quaternion();
const tmpVec = new THREE.Vector3();
const SAMPLE_REPORT_INTERVAL_S = 1 / 24;

function SceneDriver({
  replay,
  clock,
  cameraMode,
  pilotId,
  cockpitDevice,
  shipRefs,
  controlsRef,
  onIndex,
  onSample,
}: {
  replay: MatchReplay;
  clock: PlaybackClock;
  cameraMode: CameraMode;
  pilotId: string;
  cockpitDevice: SensorDevice;
  shipRefs: MutableRefObject<Record<string, THREE.Group | null>>;
  controlsRef: MutableRefObject<any>;
  onIndex: (index: number) => void;
  onSample: (position: number) => void;
}) {
  const { camera } = useThree();
  const orbitTarget = useRef<THREE.Vector3 | null>(null);
  const lastReported = useRef(-1);
  const lastSampleReportedAt = useRef(-Infinity);
  const lastMode = useRef<CameraMode | null>(null);

  useFrame((state, delta) => {
    const frames = replay.frames;
    const maxIndex = frames.length - 1;
    if (maxIndex < 0) return;

    if (clock.playing) {
      clock.position += delta * clock.framesPerSecond;
      if (clock.position > maxIndex) clock.position = 0; // loop
    }
    clock.position = Math.min(maxIndex, Math.max(0, clock.position));

    const i = Math.floor(clock.position);
    const j = Math.min(maxIndex, i + 1);
    const t = clock.position - i;
    const fa = frames[i];
    const fb = frames[j];

    let centerX = 0;
    let centerY = 0;
    let centerZ = 0;
    let count = 0;
    let pilotX = 0;
    let pilotY = 0;
    let pilotZ = 0;
    let pilotScale = ACTIVE_AIRCRAFT_SCALE;
    let havePilot = false;

    for (const a of fa.aircraft) {
      const b = fb.aircraft.find((s) => s.id === a.id) ?? a;
      const px = THREE.MathUtils.lerp(a.position.x, b.position.x, t);
      const py = THREE.MathUtils.lerp(a.position.y, b.position.y, t);
      const pz = THREE.MathUtils.lerp(a.position.z, b.position.z, t);
      centerX += px;
      centerY += py;
      centerZ += pz;
      count += 1;

      tmpQa.set(a.orientation.x, a.orientation.y, a.orientation.z, a.orientation.w);
      tmpQb.set(b.orientation.x, b.orientation.y, b.orientation.z, b.orientation.w);
      const group = shipRefs.current[a.id];
      if (group) {
        group.position.set(px * SCENE_SCALE, py * SCENE_SCALE, pz * SCENE_SCALE);
        group.quaternion.slerpQuaternions(tmpQa, tmpQb, t);
      }

      if (a.id === pilotId) {
        havePilot = true;
        pilotX = px;
        pilotY = py;
        pilotZ = pz;
        pilotScale = a.health <= 0 ? DEAD_AIRCRAFT_SCALE : ACTIVE_AIRCRAFT_SCALE;
        tmpPilotQ.slerpQuaternions(tmpQa, tmpQb, t);
      }
    }
    if (count === 0) return;
    if (!havePilot) tmpPilotQ.identity();

    const cx = (centerX / count) * SCENE_SCALE;
    const cy = (centerY / count) * SCENE_SCALE;
    const cz = (centerZ / count) * SCENE_SCALE;

    const entering = lastMode.current !== cameraMode;
    lastMode.current = cameraMode;

    if (cameraMode === "cabin") {
      const ex = (havePilot ? pilotX : centerX / count) * SCENE_SCALE;
      const ey = (havePilot ? pilotY : centerY / count) * SCENE_SCALE;
      const ez = (havePilot ? pilotZ : centerZ / count) * SCENE_SCALE;

      const pose = mountedSensorPose(
        cockpitDevice,
        {
          position: { x: ex, y: ey, z: ez },
          orientation: { x: tmpPilotQ.x, y: tmpPilotQ.y, z: tmpPilotQ.z, w: tmpPilotQ.w },
        },
        { offsetScale: PART_VISUAL_SCALE * pilotScale },
      );
      camera.position.set(pose.eye.x, pose.eye.y, pose.eye.z);
      camera.quaternion.set(pose.orientation.x, pose.orientation.y, pose.orientation.z, pose.orientation.w);
      camera.updateMatrixWorld();
    } else {
      if (entering || !orbitTarget.current) {
        // Snap to a clean chase view when (re)entering orbit, then let OrbitControls own the
        // camera while we keep panning the target to follow the action.
        orbitTarget.current = new THREE.Vector3(cx, cy, cz);
        camera.up.copy(WORLD_UP);
        camera.position.set(cx, cy + 14, cz + 32);
        camera.lookAt(cx, cy, cz);
      } else {
        orbitTarget.current.lerp(tmpVec.set(cx, cy, cz), 0.1);
      }
      const controls = controlsRef.current;
      if (
        controls &&
        controls.target instanceof THREE.Vector3 &&
        typeof controls.update === "function"
      ) {
        controls.target.copy(orbitTarget.current);
        controls.update();
      }
    }

    if (i !== lastReported.current) {
      lastReported.current = i;
      onIndex(i);
    }
    if (state.clock.elapsedTime - lastSampleReportedAt.current >= SAMPLE_REPORT_INTERVAL_S) {
      lastSampleReportedAt.current = state.clock.elapsedTime;
      onSample(clock.position);
    }
  });

  return null;
}

function AircraftMesh({
  ship,
  shipId,
  parts,
  showCockpit,
  refMap,
}: {
  ship: AircraftSnapshot;
  shipId: string;
  parts: Part[];
  showCockpit: boolean;
  refMap: MutableRefObject<Record<string, THREE.Group | null>>;
}) {
  // Stable ref callback so the persistent group isn't torn down on per-tick re-renders.
  const register = useCallback(
    (group: THREE.Group | null) => {
      refMap.current[shipId] = group;
    },
    [refMap, shipId],
  );

  // Position/orientation are driven imperatively by SceneDriver; the geometry comes from the airframe
  // parts (the plane you built) and the discrete visual props (colour, death scale, stall tint) from
  // the current frame's snapshot.
  return (
    <group ref={register} scale={ship.health <= 0 ? DEAD_AIRCRAFT_SCALE : ACTIVE_AIRCRAFT_SCALE}>
      <PartMeshes
        parts={parts}
        color={ship.color}
        accentColor={ship.team === "blue" ? "#f4d35e" : "#f0f2f2"}
        stalled={ship.stalled}
        surfaceControls={ship.surfaceControls ?? deriveSurfaceControls(parts, ship.controls)}
        controls={ship.controls}
      />
      {showCockpit ? (
        <AircraftCockpitControls
          controls={ship.controls}
          surfaceControls={ship.surfaceControls ?? deriveSurfaceControls(parts, ship.controls)}
        />
      ) : null}
    </group>
  );
}

function AircraftCockpitControls({
  controls,
  surfaceControls,
}: {
  controls: ControlInput;
  surfaceControls: SurfaceControlSnapshot[];
}) {
  const s = PART_VISUAL_SCALE;
  const stickPitch = THREE.MathUtils.clamp(controls.pitch, -1, 1) * 0.42;
  const stickRoll = THREE.MathUtils.clamp(-controls.roll, -1, 1) * 0.36;
  const throttleAngle = -0.55 + THREE.MathUtils.clamp(controls.throttle, 0, 1) * 1.05;
  const yaw = THREE.MathUtils.clamp(controls.yaw, -1, 1);
  const pedalTravel = yaw * 0.42 * s;
  const pedalAngle = yaw * 0.24;

  return (
    <group>
      <mesh position={[0, -0.38 * s, -5.25 * s]} castShadow>
        <boxGeometry args={[1.7 * s, 0.16 * s, 0.64 * s]} />
        <meshStandardMaterial color="#172229" roughness={0.62} metalness={0.12} />
      </mesh>
      <mesh position={[0, 0.05 * s, -5.75 * s]} castShadow>
        <boxGeometry args={[1.8 * s, 0.12 * s, 0.12 * s]} />
        <meshStandardMaterial color="#24333b" roughness={0.5} metalness={0.2} />
      </mesh>

      <group position={[0.18 * s, -0.3 * s, -5.65 * s]} rotation={[stickPitch, 0, stickRoll]}>
        <mesh position={[0, 0.32 * s, 0]} castShadow>
          <cylinderGeometry args={[0.035 * s, 0.045 * s, 0.64 * s, 12]} />
          <meshStandardMaterial color="#d7e5ea" roughness={0.42} metalness={0.25} />
        </mesh>
        <mesh position={[0, 0.68 * s, 0]} castShadow>
          <boxGeometry args={[0.28 * s, 0.13 * s, 0.1 * s]} />
          <meshStandardMaterial
            color={controls.trigger ? "#f2c94c" : "#4da3ff"}
            emissive={controls.trigger ? "#5b4200" : "#061d35"}
            emissiveIntensity={0.28}
            roughness={0.36}
            metalness={0.18}
          />
        </mesh>
      </group>

      <mesh position={[-0.46 * s, -0.32 * s, -5.52 * s]} castShadow>
        <boxGeometry args={[0.24 * s, 0.08 * s, 0.36 * s]} />
        <meshStandardMaterial color="#11191f" roughness={0.58} metalness={0.16} />
      </mesh>
      <group position={[-0.46 * s, -0.28 * s, -5.52 * s]} rotation={[throttleAngle, 0, 0]}>
        <mesh position={[0, 0.25 * s, 0]} castShadow>
          <cylinderGeometry args={[0.026 * s, 0.034 * s, 0.52 * s, 10]} />
          <meshStandardMaterial color="#33424a" roughness={0.45} metalness={0.25} />
        </mesh>
        <mesh position={[0, 0.55 * s, 0]} castShadow>
          <sphereGeometry args={[0.09 * s, 12, 8]} />
          <meshStandardMaterial color="#58d38c" emissive="#0d321d" emissiveIntensity={0.2} />
        </mesh>
      </group>

      <mesh position={[0, -0.17 * s, -6.12 * s]} castShadow>
        <boxGeometry args={[1.05 * s, 0.05 * s, 0.08 * s]} />
        <meshStandardMaterial color="#26343c" roughness={0.52} metalness={0.2} />
      </mesh>
      <CockpitPedal position={[-0.32 * s, -0.15 * s, -6.02 * s + pedalTravel]} rotationX={-0.24 + pedalAngle} />
      <CockpitPedal position={[0.32 * s, -0.15 * s, -6.02 * s - pedalTravel]} rotationX={-0.24 - pedalAngle} />
      <SurfaceRepeaterPanel surfaceControls={surfaceControls} />
    </group>
  );
}

function SurfaceRepeaterPanel({ surfaceControls }: { surfaceControls: SurfaceControlSnapshot[] }) {
  const s = PART_VISUAL_SCALE;
  const rows = surfaceControlsForPanel(surfaceControls);

  return (
    <group position={[0.02 * s, 0.08 * s, -5.44 * s]} rotation={[-0.12, 0, 0]}>
      <mesh castShadow>
        <boxGeometry args={[1.16 * s, 0.86 * s, 0.08 * s]} />
        <meshBasicMaterial color="#101a20" />
      </mesh>
      <mesh position={[0, 0, 0.046 * s]}>
        <boxGeometry args={[1.02 * s, 0.72 * s, 0.014 * s]} />
        <meshBasicMaterial color="#17252d" />
      </mesh>
      <SurfaceSynoptic surfaceControls={surfaceControls} />
      {rows.map((surface, index) => (
        <SurfaceRepeaterRow
          key={surface.id}
          surface={surface}
          position={[0, (-0.09 - index * 0.115) * s, 0.07 * s]}
        />
      ))}
    </group>
  );
}

function SurfaceSynoptic({ surfaceControls }: { surfaceControls: SurfaceControlSnapshot[] }) {
  const s = PART_VISUAL_SCALE;
  const surfaces = surfaceControlsForSynoptic(surfaceControls);

  return (
    <group position={[0, 0.16 * s, 0.076 * s]} scale={[0.62, 0.62, 1]}>
      <mesh position={[0, 0.02 * s, 0]}>
        <boxGeometry args={[0.055 * s, 0.58 * s, 0.018 * s]} />
        <meshBasicMaterial color="#6f8188" />
      </mesh>
      <mesh position={[0, 0.06 * s, 0]}>
        <boxGeometry args={[0.72 * s, 0.038 * s, 0.018 * s]} />
        <meshBasicMaterial color="#52666f" />
      </mesh>
      <mesh position={[0, -0.22 * s, 0]}>
        <boxGeometry args={[0.4 * s, 0.034 * s, 0.018 * s]} />
        <meshBasicMaterial color="#52666f" />
      </mesh>
      <mesh position={[0.055 * s, -0.14 * s, -0.002 * s]} rotation={[0, 0, -0.36]}>
        <boxGeometry args={[0.035 * s, 0.2 * s, 0.016 * s]} />
        <meshBasicMaterial color="#52666f" />
      </mesh>

      <SynopticSurfacePlate
        surface={surfaces.leftAileron}
        position={[-0.34 * s, 0.015 * s, -0.018 * s]}
        size={[0.22 * s, 0.072 * s, 0.032 * s]}
      />
      <SynopticSurfacePlate
        surface={surfaces.rightAileron}
        position={[0.34 * s, 0.015 * s, -0.018 * s]}
        size={[0.22 * s, 0.072 * s, 0.032 * s]}
      />
      <SynopticSurfacePlate
        surface={surfaces.elevator}
        position={[0, -0.255 * s, -0.018 * s]}
        size={[0.28 * s, 0.064 * s, 0.032 * s]}
      />
      <SynopticSurfacePlate
        surface={surfaces.rudder}
        position={[0.09 * s, -0.105 * s, -0.02 * s]}
        size={[0.072 * s, 0.18 * s, 0.032 * s]}
        rotationScale={0.72}
      />
    </group>
  );
}

function SynopticSurfacePlate({
  surface,
  position,
  size,
  rotationScale = 1,
}: {
  surface?: SurfaceControlSnapshot;
  position: [number, number, number];
  size: [number, number, number];
  rotationScale?: number;
}) {
  const s = PART_VISUAL_SCALE;
  const deflectionRad = ((surface?.deflectionDeg ?? 0) * Math.PI) / 180;
  const flowRad = (((surface?.totalAoADeg ?? surface?.effectiveAoADeg ?? 0) * Math.PI) / 180) * 0.55;
  const load = THREE.MathUtils.clamp((surface?.loadN ?? 0) / 65_000, 0, 1);
  const stalled = (surface?.stallSeverity ?? 0) > 0.2;
  const plateColor = stalled ? "#f2c94c" : "#f4a340";
  const loadColor = stalled ? "#f2c94c" : "#58d38c";

  return (
    <group position={position}>
      <mesh position={[0, 0, 0.01 * s]} rotation={[0, 0, deflectionRad * rotationScale]} castShadow>
        <boxGeometry args={size} />
        <meshBasicMaterial color={plateColor} />
      </mesh>
      <mesh position={[0, 0, 0.029 * s]} rotation={[0, 0, flowRad]} castShadow>
        <boxGeometry args={[size[0] * 1.18, Math.max(size[1] * 0.22, 0.014 * s), 0.018 * s]} />
        <meshBasicMaterial color="#00ffff" />
      </mesh>
      <mesh position={[0, -size[1] * 0.56, 0.026 * s]} castShadow>
        <boxGeometry args={[Math.max(size[0] * (0.25 + load * 0.75), 0.024 * s), 0.016 * s, 0.016 * s]} />
        <meshBasicMaterial color={loadColor} />
      </mesh>
    </group>
  );
}

function SurfaceRepeaterRow({
  surface,
  position,
}: {
  surface: SurfaceControlSnapshot;
  position: [number, number, number];
}) {
  const s = PART_VISUAL_SCALE;
  const travel = THREE.MathUtils.clamp(surface.deflectionDeg / 14, -1, 1) * 0.42 * s;
  const flow = THREE.MathUtils.clamp((surface.totalAoADeg ?? surface.effectiveAoADeg) / 12, -1, 1) * 0.28 * s;
  const loadWidth = THREE.MathUtils.clamp((surface.loadN ?? 0) / 65_000, 0, 1) * 0.84 * s;
  const loadColor = (surface.stallSeverity ?? 0) > 0.2 ? "#f2c94c" : "#58d38c";

  return (
    <group position={position}>
      <mesh position={[0, 0, 0]} castShadow>
        <boxGeometry args={[0.86 * s, 0.035 * s, 0.02 * s]} />
        <meshBasicMaterial color="#39515b" />
      </mesh>
      <mesh position={[0, 0, -0.012 * s]} castShadow>
        <boxGeometry args={[0.024 * s, 0.11 * s, 0.024 * s]} />
        <meshBasicMaterial color="#dce7eb" />
      </mesh>
      <mesh position={[travel, 0, -0.03 * s]} rotation={[0, 0, surface.deflectionDeg * (Math.PI / 180)]} castShadow>
        <boxGeometry args={[0.22 * s, 0.1 * s, 0.052 * s]} />
        <meshBasicMaterial color="#ff4fd8" />
      </mesh>
      <mesh position={[flow, -0.028 * s, -0.034 * s]} castShadow>
        <boxGeometry args={[0.22 * s, 0.1 * s, 0.05 * s]} />
        <meshBasicMaterial color="#00ffff" />
      </mesh>
      <mesh position={[-0.42 * s + loadWidth / 2, -0.062 * s, -0.036 * s]} castShadow>
        <boxGeometry args={[Math.max(loadWidth, 0.012 * s), 0.028 * s, 0.032 * s]} />
        <meshBasicMaterial color={loadColor} />
      </mesh>
    </group>
  );
}

function surfaceControlsForPanel(surfaces: SurfaceControlSnapshot[]): SurfaceControlSnapshot[] {
  const byId = new Map(surfaces.map((surface) => [surface.id, surface]));
  const preferred = ["main-wing-left", "main-wing-right", "tailplane", "fin"]
    .map((id) => byId.get(id))
    .filter((surface): surface is SurfaceControlSnapshot => Boolean(surface));
  if (preferred.length > 0) return preferred;

  return [...surfaces].sort((a, b) => a.id.localeCompare(b.id)).slice(0, 4);
}

function surfaceControlsForSynoptic(surfaces: SurfaceControlSnapshot[]) {
  const sorted = [...surfaces].sort((a, b) => a.id.localeCompare(b.id));
  const byId = new Map(sorted.map((surface) => [surface.id, surface]));
  const roll = sorted.filter((surface) => surface.axis === "roll");
  const pitch = sorted.filter((surface) => surface.axis === "pitch");
  const yaw = sorted.filter((surface) => surface.axis === "yaw");

  return {
    leftAileron:
      byId.get("main-wing-left") ??
      roll.find((surface) => surface.id.endsWith("-left")) ??
      roll[0],
    rightAileron:
      byId.get("main-wing-right") ??
      roll.find((surface) => surface.id.endsWith("-right")) ??
      roll[1] ??
      roll[0],
    elevator: byId.get("tailplane") ?? pitch[0],
    rudder: byId.get("fin") ?? yaw[0],
  };
}

function CockpitPedal({
  position,
  rotationX,
}: {
  position: [number, number, number];
  rotationX: number;
}) {
  return (
    <group position={position} rotation={[rotationX, 0, 0]}>
      <mesh castShadow>
        <boxGeometry args={[0.24 * PART_VISUAL_SCALE, 0.08 * PART_VISUAL_SCALE, 0.16 * PART_VISUAL_SCALE]} />
        <meshStandardMaterial color="#f4a340" emissive="#432100" emissiveIntensity={0.16} />
      </mesh>
      <mesh position={[0, 0.07 * PART_VISUAL_SCALE, 0.07 * PART_VISUAL_SCALE]} castShadow>
        <boxGeometry args={[0.19 * PART_VISUAL_SCALE, 0.05 * PART_VISUAL_SCALE, 0.05 * PART_VISUAL_SCALE]} />
        <meshStandardMaterial color="#fff0c2" roughness={0.35} />
      </mesh>
    </group>
  );
}

function PathLine({
  ship,
  replay,
  frameIndex,
}: {
  ship: AircraftSnapshot;
  replay: MatchReplay;
  frameIndex: number;
}) {
  const points = useMemo(() => {
    return replay.frames
      .slice(Math.max(0, frameIndex - 260), frameIndex + 1)
      .map((snapshot) => snapshot.aircraft.find((candidate) => candidate.id === ship.id))
      .filter((candidate): candidate is AircraftSnapshot => Boolean(candidate))
      .map((candidate) => toScenePoint(candidate.position));
  }, [frameIndex, replay.frames, ship.id]);

  if (points.length < 2) {
    return null;
  }

  return <Line points={points} color={ship.color} lineWidth={2} transparent opacity={0.5} />;
}

function toScenePoint(point: Vec3): [number, number, number] {
  return [point.x * SCENE_SCALE, point.y * SCENE_SCALE, point.z * SCENE_SCALE];
}
