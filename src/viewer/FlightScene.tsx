import { Line, OrbitControls, Sky } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useMemo, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import type {
  AircraftSnapshot,
  ControlInput,
  MatchReplay,
  Part,
  ProjectileSnapshot,
  ReplayFrame,
  SurfaceControlSnapshot,
  Vec3,
} from "../protocol/schema";
import { defaultAirframe } from "../sim/airframe";
import { mountedSensorPose, selectCameraDevice } from "../sim/mountedSensor";
import type { SensorDevice } from "../sim/parts";
import type { PilotProfile } from "../studio/schema";
import { PART_VISUAL_SCALE, PartMeshes } from "./airframeMesh";
import { PilotAvatar } from "./PilotAvatar";
import { computePilotCinemaShot } from "./pilotCinema";
import { PilotStationDebug } from "./PilotStationDebug";
import { COCKPIT_SCALE, computeCockpitRig } from "./pilotRig";
import { deriveSurfaceControls } from "./surfaceTelemetry";
import type { PlaybackClock } from "./usePlayback";

export type CameraMode = "orbit" | "cabin" | "pilot-cinema";

const SCENE_SCALE = 0.01;
const ACTIVE_AIRCRAFT_SCALE = 1.42;
const DEAD_AIRCRAFT_SCALE = 1.05;

function readSceneFlag(name: string, fallback: boolean): boolean {
  if (typeof window === "undefined") return fallback;
  const value = new URLSearchParams(window.location.search).get(name);
  if (value === null) return fallback;
  return !["0", "false", "off", "no"].includes(value.toLowerCase());
}

interface FlightSceneProps {
  frame: ReplayFrame;
  replay: MatchReplay;
  cameraMode: CameraMode;
  pilotId?: string;
  pilotProfile?: PilotProfile;
  clock: PlaybackClock;
  onIndex: (index: number) => void;
  onSample: (position: number) => void;
}

export function FlightScene({
  frame,
  replay,
  cameraMode,
  pilotId = "blue-1",
  pilotProfile,
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
  const showPilotDebug = useMemo(() => readSceneFlag("pilotDebug", false), []);

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
        pilotParts={pilotParts}
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
            showPilotDebug={entry.id === pilotId && showPilotDebug}
            showPilotAvatar={entry.id === pilotId && cameraMode !== "cabin"}
            pilotProfile={entry.id === pilotId ? pilotProfile : undefined}
            refMap={shipRefs}
          />
        );
      })}

      {frame.aircraft.map((ship) => (
        <PathLine key={`path-${ship.id}`} ship={ship} replay={replay} frameIndex={frame.index} />
      ))}

      {(frame.projectiles ?? []).map((projectile) => (
        <ProjectileMarker key={projectile.id} projectile={projectile} />
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

function ProjectileMarker({ projectile }: { projectile: ProjectileSnapshot }) {
  const missile = projectile.kind === "missile";
  const speed = Math.hypot(projectile.velocity.x, projectile.velocity.y, projectile.velocity.z);
  const trailM = missile ? 95 : 38;
  const inv = speed > 1e-6 ? 1 / speed : 0;
  const tail = {
    x: projectile.position.x - projectile.velocity.x * inv * trailM,
    y: projectile.position.y - projectile.velocity.y * inv * trailM,
    z: projectile.position.z - projectile.velocity.z * inv * trailM,
  };
  const color = missile ? "#ff8a24" : projectile.team === "blue" ? "#f2c94c" : "#ff8a8a";
  const head = toScenePoint(projectile.position);

  return (
    <group>
      <Line
        points={[toScenePoint(tail), head]}
        color={color}
        lineWidth={missile ? 4 : 2}
        transparent
        opacity={missile ? 0.88 : 0.72}
      />
      {missile ? (
        <mesh position={head}>
          <sphereGeometry args={[0.075, 12, 8]} />
          <meshBasicMaterial color="#ffd27a" />
        </mesh>
      ) : null}
    </group>
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
const tmpEye = new THREE.Vector3();
const tmpOrigin = new THREE.Vector3();
const tmpTarget = new THREE.Vector3();
const tmpUp = new THREE.Vector3();
const SAMPLE_REPORT_INTERVAL_S = 1 / 24;

function SceneDriver({
  replay,
  clock,
  cameraMode,
  pilotId,
  cockpitDevice,
  pilotParts,
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
  pilotParts: Part[];
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
    let pilotControls: ControlInput | null = null;
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
        pilotControls = interpolateControls(a.controls, b.controls, t);
      }
    }
    if (count === 0) return;
    if (!havePilot) tmpPilotQ.identity();

    const cx = (centerX / count) * SCENE_SCALE;
    const cy = (centerY / count) * SCENE_SCALE;
    const cz = (centerZ / count) * SCENE_SCALE;

    const entering = lastMode.current !== cameraMode;
    lastMode.current = cameraMode;

    const ex = (havePilot ? pilotX : centerX / count) * SCENE_SCALE;
    const ey = (havePilot ? pilotY : centerY / count) * SCENE_SCALE;
    const ez = (havePilot ? pilotZ : centerZ / count) * SCENE_SCALE;

    if (cameraMode === "cabin") {
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
    } else if (cameraMode === "pilot-cinema") {
      const shot = computePilotCinemaShot({
        controls: pilotControls ?? { pitch: 0, roll: 0, yaw: 0, throttle: 0.72, trigger: false },
        parts: pilotParts,
        time: clock.position * replay.frameDt,
      });
      tmpOrigin.set(ex, ey, ez);
      aircraftLocalToWorld(shot.eye, tmpOrigin, tmpPilotQ, pilotScale, tmpEye);
      aircraftLocalToWorld(shot.target, tmpOrigin, tmpPilotQ, pilotScale, tmpTarget);
      camera.position.copy(tmpEye);
      camera.up.copy(tmpUp.set(0, 1, 0).applyQuaternion(tmpPilotQ));
      camera.lookAt(tmpTarget);
      if (camera instanceof THREE.PerspectiveCamera && Math.abs(camera.fov - shot.fov) > 0.05) {
        camera.fov = shot.fov;
        camera.updateProjectionMatrix();
      }
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

function interpolateControls(a: ControlInput, b: ControlInput, t: number): ControlInput {
  return {
    pitch: THREE.MathUtils.lerp(a.pitch, b.pitch, t),
    roll: THREE.MathUtils.lerp(a.roll, b.roll, t),
    yaw: THREE.MathUtils.lerp(a.yaw, b.yaw, t),
    throttle: THREE.MathUtils.lerp(a.throttle, b.throttle, t),
    trigger: t < 0.5 ? a.trigger : b.trigger,
  };
}

function aircraftLocalToWorld(
  local: THREE.Vector3,
  aircraftOrigin: THREE.Vector3,
  aircraftRotation: THREE.Quaternion,
  aircraftScale: number,
  out: THREE.Vector3,
): THREE.Vector3 {
  return out.copy(local).multiplyScalar(aircraftScale).applyQuaternion(aircraftRotation).add(aircraftOrigin);
}

function AircraftMesh({
  ship,
  shipId,
  parts,
  pilotProfile,
  showCockpit,
  showPilotDebug,
  showPilotAvatar,
  refMap,
}: {
  ship: AircraftSnapshot;
  shipId: string;
  parts: Part[];
  pilotProfile?: PilotProfile;
  showCockpit: boolean;
  showPilotDebug: boolean;
  showPilotAvatar: boolean;
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
        afterburnerActive={ship.afterburner}
        parts={parts}
        color={ship.color}
        accentColor={ship.team === "blue" ? "#f4d35e" : "#f0f2f2"}
        stalled={ship.stalled}
        surfaceControls={ship.surfaceControls ?? deriveSurfaceControls(parts, ship.controls)}
        controls={ship.controls}
        sweepDeg={ship.sweepDeg}
      />
      {showCockpit ? (
        <>
          <AircraftCockpitControls
            controls={ship.controls}
            parts={parts}
            surfaceControls={ship.surfaceControls ?? deriveSurfaceControls(parts, ship.controls)}
          />
          {showPilotDebug ? <PilotStationDebug controls={ship.controls} parts={parts} /> : null}
          {showPilotAvatar ? <PilotAvatar parts={parts} profile={pilotProfile} ship={ship} /> : null}
        </>
      ) : null}
    </group>
  );
}

function AircraftCockpitControls({
  controls,
  parts,
  surfaceControls,
}: {
  controls: ControlInput;
  parts: Part[];
  surfaceControls: SurfaceControlSnapshot[];
}) {
  const s = COCKPIT_SCALE;
  const cockpit = computeCockpitRig(controls, parts);

  return (
    <group>
      <group position={toTuple(cockpit.station.layoutOffset)}>
        <mesh position={[0, -0.37 * s, -4.55 * s]} castShadow>
          <boxGeometry args={[1.16 * s, 0.16 * s, 0.82 * s]} />
          <meshStandardMaterial color="#162128" roughness={0.72} metalness={0.12} />
        </mesh>
        <mesh position={[0, -0.08 * s, -4.2 * s]} rotation={[0.34, 0, 0]} castShadow>
          <boxGeometry args={[1.12 * s, 0.88 * s, 0.12 * s]} />
          <meshStandardMaterial color="#1f2d34" roughness={0.74} metalness={0.1} />
        </mesh>
        <mesh position={[0, 0.3 * s, -4.0 * s]} rotation={[0.28, 0, 0]} castShadow>
          <boxGeometry args={[0.64 * s, 0.16 * s, 0.13 * s]} />
          <meshStandardMaterial color="#26363d" roughness={0.7} metalness={0.08} />
        </mesh>

        <mesh position={[-0.55 * s, -0.18 * s, -4.75 * s]} castShadow>
          <boxGeometry args={[0.2 * s, 0.28 * s, 1.34 * s]} />
          <meshStandardMaterial color="#101820" roughness={0.6} metalness={0.2} />
        </mesh>
        <mesh position={[0.55 * s, -0.18 * s, -4.75 * s]} castShadow>
          <boxGeometry args={[0.2 * s, 0.28 * s, 1.34 * s]} />
          <meshStandardMaterial color="#101820" roughness={0.6} metalness={0.2} />
        </mesh>

        <mesh position={[0, -0.02 * s, -5.05 * s]} rotation={[-0.18, 0, 0]} castShadow>
          <boxGeometry args={[1.52 * s, 0.78 * s, 0.14 * s]} />
          <meshStandardMaterial color="#17242b" roughness={0.56} metalness={0.22} />
        </mesh>
        <mesh position={[0, 0.38 * s, -5.0 * s]} rotation={[-0.18, 0, 0]}>
          <boxGeometry args={[1.18 * s, 0.1 * s, 0.08 * s]} />
          <meshStandardMaterial color="#32444d" roughness={0.44} metalness={0.35} />
        </mesh>
      </group>

      <group position={toTuple(cockpit.controlPoints.stickPivot)} rotation={[cockpit.stickPitchRad, 0, cockpit.stickRollRad]}>
        <mesh position={[0, 0.32 * s, 0]} castShadow>
          <cylinderGeometry args={[0.032 * s, 0.046 * s, 0.62 * s, 12]} />
          <meshStandardMaterial color="#c8d7dc" roughness={0.42} metalness={0.32} />
        </mesh>
        <mesh position={[0.055 * s, 0.63 * s, -0.025 * s]} castShadow>
          <boxGeometry args={[0.22 * s, 0.16 * s, 0.11 * s]} />
          <meshStandardMaterial
            color={controls.trigger ? "#f2c94c" : "#4da3ff"}
            emissive={controls.trigger ? "#5b4200" : "#061d35"}
            emissiveIntensity={0.28}
            roughness={0.36}
            metalness={0.18}
          />
        </mesh>
        <mesh position={[-0.035 * s, 0.66 * s, -0.026 * s]} castShadow>
          <boxGeometry args={[0.09 * s, 0.08 * s, 0.08 * s]} />
          <meshStandardMaterial color="#1a252b" roughness={0.45} metalness={0.25} />
        </mesh>
      </group>

      <group position={toTuple(cockpit.station.layoutOffset)}>
        <mesh position={[-0.24 * s, -0.28 * s, -4.8 * s]} castShadow>
          <boxGeometry args={[0.26 * s, 0.08 * s, 0.42 * s]} />
          <meshStandardMaterial color="#11191f" roughness={0.58} metalness={0.16} />
        </mesh>
      </group>
      <group position={toTuple(cockpit.controlPoints.throttlePivot)} rotation={[cockpit.throttleAngleRad, 0, 0]}>
        <mesh position={[0, 0.25 * s, 0]} castShadow>
          <cylinderGeometry args={[0.024 * s, 0.034 * s, 0.5 * s, 10]} />
          <meshStandardMaterial color="#33424a" roughness={0.45} metalness={0.25} />
        </mesh>
        <mesh position={[0, 0.46 * s, -0.035 * s]} castShadow>
          <sphereGeometry args={[0.095 * s, 14, 10]} />
          <meshStandardMaterial color="#58d38c" emissive="#0d321d" emissiveIntensity={0.2} />
        </mesh>
      </group>

      <group position={toTuple(cockpit.station.layoutOffset)}>
        <mesh position={[0, -0.14 * s, -5.46 * s]} castShadow>
          <boxGeometry args={[0.92 * s, 0.05 * s, 0.08 * s]} />
          <meshStandardMaterial color="#26343c" roughness={0.52} metalness={0.2} />
        </mesh>
        <SurfaceRepeaterPanel surfaceControls={surfaceControls} />
      </group>
      <CockpitPedal position={toTuple(cockpit.controlPoints.leftPedal)} rotationX={-0.24 + cockpit.pedalAngleRad} />
      <CockpitPedal position={toTuple(cockpit.controlPoints.rightPedal)} rotationX={-0.24 - cockpit.pedalAngleRad} />
    </group>
  );
}

function SurfaceRepeaterPanel({ surfaceControls }: { surfaceControls: SurfaceControlSnapshot[] }) {
  const s = COCKPIT_SCALE;
  const rows = surfaceControlsForPanel(surfaceControls);

  return (
    <group position={[0.02 * s, 0.08 * s, -4.98 * s]} rotation={[-0.16, 0, 0]}>
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
        <boxGeometry args={[0.22 * COCKPIT_SCALE, 0.08 * COCKPIT_SCALE, 0.16 * COCKPIT_SCALE]} />
        <meshStandardMaterial color="#f4a340" emissive="#432100" emissiveIntensity={0.16} />
      </mesh>
      <mesh position={[0, 0.07 * COCKPIT_SCALE, 0.07 * COCKPIT_SCALE]} castShadow>
        <boxGeometry args={[0.17 * COCKPIT_SCALE, 0.05 * COCKPIT_SCALE, 0.05 * COCKPIT_SCALE]} />
        <meshStandardMaterial color="#fff0c2" roughness={0.35} />
      </mesh>
    </group>
  );
}

function toTuple(vector: THREE.Vector3): [number, number, number] {
  return [vector.x, vector.y, vector.z];
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
