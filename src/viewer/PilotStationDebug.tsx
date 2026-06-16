import { Line } from "@react-three/drei";
import * as THREE from "three";
import type { ControlInput, Part } from "../protocol/schema";
import { computeCockpitFitDiagnostics, computeCockpitRig, neutralControls, sampleAvatarJointInCockpit } from "./pilotRig";

export function PilotStationDebug({
  controls = neutralControls(),
  parts,
  pointScale = 1,
}: {
  controls?: ControlInput;
  parts: Part[];
  pointScale?: number;
}) {
  const cockpit = computeCockpitRig(controls, parts);
  const diagnostics = computeCockpitFitDiagnostics(controls, parts);
  const canopy = cockpit.station.canopy;
  const head = sampleAvatarJointInCockpit("head", diagnostics.root);
  const hip = sampleAvatarJointInCockpit("hips", diagnostics.root);

  return (
    <group>
      {canopy ? (
        <mesh position={toTuple(canopy.center)}>
          <boxGeometry args={[canopy.size.x, canopy.size.y, canopy.size.z]} />
          <meshBasicMaterial color="#00e5ff" wireframe transparent opacity={0.8} depthTest={false} />
        </mesh>
      ) : null}
      <DebugPoint color="#f2c94c" position={cockpit.anchors.seatHip} size={0.015 * pointScale} />
      <DebugPoint color="#ffffff" position={cockpit.station.eye} size={0.012 * pointScale} />
      <DebugPoint color="#ff4fd8" position={head} size={0.012 * pointScale} />
      <DebugPoint color="#f4a340" position={hip} size={0.011 * pointScale} />
      <DebugPoint color="#4da3ff" position={cockpit.anchors.rightGrip} size={0.011 * pointScale} />
      <DebugPoint color="#58d38c" position={cockpit.anchors.leftThrottle} size={0.011 * pointScale} />
      <DebugPoint color="#ff865c" position={cockpit.anchors.leftFoot} size={0.01 * pointScale} />
      <DebugPoint color="#ff865c" position={cockpit.anchors.rightFoot} size={0.01 * pointScale} />
      <Line points={[cockpit.station.eye, head]} color="#ffffff" lineWidth={1} transparent opacity={0.72} />
      <Line points={[cockpit.anchors.seatHip, cockpit.anchors.seatBack]} color="#f2c94c" lineWidth={1} transparent opacity={0.8} />
      <Line points={[cockpit.anchors.leftFoot, cockpit.anchors.rightFoot]} color="#ff865c" lineWidth={1} transparent opacity={0.8} />
    </group>
  );
}

function DebugPoint({ color, position, size }: { color: string; position: THREE.Vector3; size: number }) {
  return (
    <mesh position={toTuple(position)}>
      <sphereGeometry args={[size, 12, 8]} />
      <meshBasicMaterial color={color} depthTest={false} />
    </mesh>
  );
}

function toTuple(v: THREE.Vector3): [number, number, number] {
  return [v.x, v.y, v.z];
}
