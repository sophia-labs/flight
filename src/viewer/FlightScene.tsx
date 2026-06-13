import { Line, OrbitControls } from "@react-three/drei";
import { useFrame, useThree } from "@react-three/fiber";
import { useLayoutEffect, useMemo, useRef, type MutableRefObject } from "react";
import * as THREE from "three";
import type { AircraftSnapshot, MatchReplay, ReplayFrame, Vec3 } from "../protocol/schema";

const SCENE_SCALE = 0.01;

interface FlightSceneProps {
  frame: ReplayFrame;
  replay: MatchReplay;
}

export function FlightScene({ frame, replay }: FlightSceneProps) {
  const controlsRef = useRef<any>(null);

  return (
    <>
      <color attach="background" args={["#0b1116"]} />
      <fog attach="fog" args={["#0b1116", 12, 64]} />
      <ambientLight intensity={0.35} />
      <hemisphereLight args={["#c8eefb", "#2a2216", 1.8]} />
      <directionalLight
        castShadow
        position={[12, 22, 8]}
        intensity={3.2}
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
      />
      <Terrain />
      <CameraRig frame={frame} controlsRef={controlsRef} />
      <OrbitControls
        ref={controlsRef}
        makeDefault
        enableDamping
        dampingFactor={0.08}
        minDistance={8}
        maxDistance={70}
      />

      {frame.aircraft.map((ship) => (
        <AircraftMesh key={ship.id} ship={ship} />
      ))}

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
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.02, 0]}>
        <planeGeometry args={[96, 96]} />
        <meshStandardMaterial color="#18221f" roughness={0.92} metalness={0.04} />
      </mesh>
      <gridHelper args={[96, 48, "#526b70", "#223238"]} position={[0, 0, 0]} />
      <Line points={[[-48, 10, 0], [48, 10, 0]]} color="#315b6a" transparent opacity={0.4} />
      <Line points={[[0, 10, -48], [0, 10, 48]]} color="#315b6a" transparent opacity={0.4} />
    </group>
  );
}

function CameraRig({
  frame,
  controlsRef,
}: {
  frame: ReplayFrame;
  controlsRef: MutableRefObject<any>;
}) {
  const { camera } = useThree();
  const target = useMemo(() => new THREE.Vector3(...frameCenter(frame)), [frame]);
  const currentTarget = useRef(target.clone());

  useLayoutEffect(() => {
    currentTarget.current.copy(target);
    const desired = target.clone().add(new THREE.Vector3(0, 14, 32));
    camera.position.copy(desired);
    camera.lookAt(target);
    setControlsTarget(controlsRef.current, target);
  }, []);

  useFrame(() => {
    currentTarget.current.lerp(target, 0.08);
    const desired = currentTarget.current.clone().add(new THREE.Vector3(0, 14, 32));
    camera.position.lerp(desired, 0.05);
    camera.lookAt(currentTarget.current);
    setControlsTarget(controlsRef.current, currentTarget.current);
  });

  return null;
}

function setControlsTarget(controls: unknown, target: THREE.Vector3) {
  if (
    controls &&
    typeof controls === "object" &&
    "target" in controls &&
    "update" in controls &&
    controls.target instanceof THREE.Vector3 &&
    typeof controls.update === "function"
  ) {
    controls.target.copy(target);
    controls.update();
  }
}

function AircraftMesh({ ship }: { ship: AircraftSnapshot }) {
  const position = toScenePoint(ship.position);
  const quaternion = useMemo(
    () => new THREE.Quaternion(ship.orientation.x, ship.orientation.y, ship.orientation.z, ship.orientation.w),
    [ship.orientation.w, ship.orientation.x, ship.orientation.y, ship.orientation.z],
  );
  const velocityEnd = toScenePoint({
    x: ship.position.x + ship.velocity.x * 1.2,
    y: ship.position.y + ship.velocity.y * 1.2,
    z: ship.position.z + ship.velocity.z * 1.2,
  });

  return (
    <group>
      <group position={position} quaternion={quaternion} scale={ship.health <= 0 ? 1.05 : 1.42}>
        <mesh castShadow>
          <boxGeometry args={[0.12, 0.12, 0.86]} />
          <meshStandardMaterial color={ship.color} roughness={0.44} metalness={0.25} />
        </mesh>
        <mesh castShadow position={[0, 0, -0.52]} rotation={[Math.PI / 2, 0, 0]}>
          <coneGeometry args={[0.12, 0.26, 16]} />
          <meshStandardMaterial color="#f4fbff" roughness={0.28} metalness={0.18} />
        </mesh>
        <mesh castShadow position={[0, 0, 0.03]}>
          <boxGeometry args={[1.06, 0.035, 0.18]} />
          <meshStandardMaterial color={ship.color} roughness={0.5} metalness={0.18} />
        </mesh>
        <mesh castShadow position={[0, 0.06, 0.38]}>
          <boxGeometry args={[0.42, 0.04, 0.16]} />
          <meshStandardMaterial color="#dce6e9" roughness={0.36} metalness={0.22} />
        </mesh>
        <mesh castShadow position={[0, 0.12, 0.3]}>
          <boxGeometry args={[0.08, 0.36, 0.17]} />
          <meshStandardMaterial color={ship.color} roughness={0.42} metalness={0.16} />
        </mesh>
      </group>
      <Line points={[position, velocityEnd]} color={ship.color} lineWidth={1} transparent opacity={0.38} />
      <mesh position={position}>
        <sphereGeometry args={[0.14, 16, 16]} />
        <meshBasicMaterial color={ship.stalled ? "#f2c94c" : ship.color} transparent opacity={0.78} />
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

function frameCenter(frame: ReplayFrame): [number, number, number] {
  if (frame.aircraft.length === 0) {
    return [0, 8, 0];
  }

  const center = frame.aircraft.reduce(
    (acc, ship) => {
      acc.x += ship.position.x;
      acc.y += ship.position.y;
      acc.z += ship.position.z;
      return acc;
    },
    { x: 0, y: 0, z: 0 },
  );

  center.x /= frame.aircraft.length;
  center.y /= frame.aircraft.length;
  center.z /= frame.aircraft.length;

  return toScenePoint(center);
}

function toScenePoint(point: Vec3): [number, number, number] {
  return [point.x * SCENE_SCALE, point.y * SCENE_SCALE, point.z * SCENE_SCALE];
}
