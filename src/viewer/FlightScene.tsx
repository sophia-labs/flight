import { Line, OrbitControls, Sky } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useCallback, useMemo, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import type { AircraftSnapshot, MatchReplay, Part, ReplayFrame, Vec3 } from "../protocol/schema";
import { defaultAirframe } from "../sim/airframe";
import { PartMeshes } from "./airframeMesh";
import type { PlaybackClock } from "./usePlayback";

export type CameraMode = "orbit" | "cabin";

const SCENE_SCALE = 0.01;

interface FlightSceneProps {
  frame: ReplayFrame;
  replay: MatchReplay;
  cameraMode: CameraMode;
  pilotId?: string;
  clock: PlaybackClock;
  onIndex: (index: number) => void;
}

export function FlightScene({
  frame,
  replay,
  cameraMode,
  pilotId = "blue-1",
  clock,
  onIndex,
}: FlightSceneProps) {
  const controlsRef = useRef<any>(null);
  // Persistent aircraft groups, keyed by id — the SceneDriver moves them imperatively every
  // render frame so they glide between recorded states instead of snapping per tick.
  const shipRefs = useRef<Record<string, THREE.Group | null>>({});
  const roster = replay.frames[0].aircraft;
  // The plane each aircraft flew. Legacy replays (no airframes) fall back to the default so they still
  // render a recognizable jet rather than nothing.
  const fallbackParts = useMemo(() => defaultAirframe().parts, []);

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
        shipRefs={shipRefs}
        controlsRef={controlsRef}
        onIndex={onIndex}
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
const UP_FALLBACK = new THREE.Vector3(0, 0, -1); // only used in near-vertical flight
const tmpQa = new THREE.Quaternion();
const tmpQb = new THREE.Quaternion();
const tmpVec = new THREE.Vector3();
const tmpEye = new THREE.Vector3();
const tmpTarget = new THREE.Vector3();

function SceneDriver({
  replay,
  clock,
  cameraMode,
  pilotId,
  shipRefs,
  controlsRef,
  onIndex,
}: {
  replay: MatchReplay;
  clock: PlaybackClock;
  cameraMode: CameraMode;
  pilotId: string;
  shipRefs: MutableRefObject<Record<string, THREE.Group | null>>;
  controlsRef: MutableRefObject<any>;
  onIndex: (index: number) => void;
}) {
  const { camera } = useThree();
  const camPosition = useRef<THREE.Vector3 | null>(null);
  const camForward = useRef<THREE.Vector3 | null>(null);
  const orbitTarget = useRef<THREE.Vector3 | null>(null);
  const lastReported = useRef(-1);
  const lastMode = useRef<CameraMode | null>(null);

  useFrame((_, delta) => {
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
    let pilotVx = 0;
    let pilotVy = 0;
    let pilotVz = 0;
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

      const group = shipRefs.current[a.id];
      if (group) {
        group.position.set(px * SCENE_SCALE, py * SCENE_SCALE, pz * SCENE_SCALE);
        tmpQa.set(a.orientation.x, a.orientation.y, a.orientation.z, a.orientation.w);
        tmpQb.set(b.orientation.x, b.orientation.y, b.orientation.z, b.orientation.w);
        group.quaternion.slerpQuaternions(tmpQa, tmpQb, t);
      }

      if (a.id === pilotId) {
        havePilot = true;
        pilotX = px;
        pilotY = py;
        pilotZ = pz;
        pilotVx = THREE.MathUtils.lerp(a.velocity.x, b.velocity.x, t);
        pilotVy = THREE.MathUtils.lerp(a.velocity.y, b.velocity.y, t);
        pilotVz = THREE.MathUtils.lerp(a.velocity.z, b.velocity.z, t);
      }
    }
    if (count === 0) return;

    const cx = (centerX / count) * SCENE_SCALE;
    const cy = (centerY / count) * SCENE_SCALE;
    const cz = (centerZ / count) * SCENE_SCALE;

    const entering = lastMode.current !== cameraMode;
    lastMode.current = cameraMode;

    if (cameraMode === "cabin") {
      const ex = (havePilot ? pilotX : centerX / count) * SCENE_SCALE;
      const ey = (havePilot ? pilotY : centerY / count) * SCENE_SCALE;
      const ez = (havePilot ? pilotZ : centerZ / count) * SCENE_SCALE;

      tmpVec.set(pilotVx, pilotVy, pilotVz);
      if (tmpVec.lengthSq() < 1e-6) tmpVec.set(0, 0, -1);
      tmpVec.normalize();
      if (entering || !camForward.current) camForward.current = tmpVec.clone();
      else camForward.current.lerp(tmpVec, 0.08).normalize();

      tmpEye.set(ex, ey, ez).addScaledVector(camForward.current, 0.25);
      tmpEye.y += 0.12;
      if (entering || !camPosition.current) camPosition.current = tmpEye.clone();
      else camPosition.current.lerp(tmpEye, 0.2);

      camera.up.copy(Math.abs(camForward.current.y) > 0.95 ? UP_FALLBACK : WORLD_UP);
      camera.position.copy(camPosition.current);
      tmpTarget.copy(camPosition.current).addScaledVector(camForward.current, 10);
      camera.lookAt(tmpTarget);
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
  });

  return null;
}

function AircraftMesh({
  ship,
  shipId,
  parts,
  refMap,
}: {
  ship: AircraftSnapshot;
  shipId: string;
  parts: Part[];
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
    <group ref={register} scale={ship.health <= 0 ? 1.05 : 1.42}>
      <PartMeshes parts={parts} color={ship.color} stalled={ship.stalled} />
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
