import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import {
  type VRM,
  type VRMHumanBoneName,
  VRMLoaderPlugin,
  VRMUtils,
} from "@pixiv/three-vrm";
import type { AircraftSnapshot, Part } from "../protocol/schema";
import { solveCcdIk } from "./contactIk";
import {
  computeCockpitRig,
  computePilotForces,
  PILOT_AVATAR_SCALE,
  PILOT_AVATAR_YAW_RAD,
  PILOT_IK_CONFIG,
  PILOT_MODEL_URL,
  positionAvatarRootForSeat,
} from "./pilotRig";
import {
  buildPilotPose,
  CONTROLLED_PILOT_BONES,
  PILOT_EXPRESSION_NAMES,
  type PilotPose,
  type Rotation,
} from "./pilotPose";

declare global {
  interface Window {
    __flightPilotRig?: PilotRigDebug;
  }
}

interface PilotAvatarProps {
  parts?: Part[];
  ship: AircraftSnapshot;
}

interface PilotRuntimeRig {
  hips: THREE.Vector3;
  rests: Map<string, THREE.Quaternion>;
}

interface PilotRenderProbeConfig {
  expressions: boolean;
  ik: boolean;
  lookAt: boolean;
  material: "vrm" | "basic" | "standard";
  meshLimit: number | null;
  morphs: "keep" | "strip";
  shadows: boolean;
  visible: boolean;
  vrmUpdate: boolean;
}

interface PilotRenderProbeStats {
  config: PilotRenderProbeConfig;
  meshCount: number;
  morphMeshCount: number;
  shaderMaterialCount: number;
  skinnedMeshCount: number;
  visibleMeshCount: number;
}

interface PilotRigDebug {
  contactErrors: Record<string, number | null>;
  forces: ReturnType<typeof computePilotForces>;
  loaded: boolean;
  probe?: PilotRenderProbeStats;
  root: [number, number, number] | null;
  station: {
    canopyId: string | null;
    source: string;
    stationId: string | null;
  } | null;
}

const CONTACT_SPECS = [
  {
    anchor: "rightGrip",
    chain: ["rightShoulder", "rightUpperArm", "rightLowerArm"],
    effector: "rightHand",
    iterations: PILOT_IK_CONFIG.handIterations,
    maxAngle: PILOT_IK_CONFIG.handMaxAngleRad,
    weight: 0.96,
  },
  {
    anchor: "leftThrottle",
    chain: ["leftShoulder", "leftUpperArm", "leftLowerArm"],
    effector: "leftHand",
    iterations: PILOT_IK_CONFIG.handIterations,
    maxAngle: PILOT_IK_CONFIG.handMaxAngleRad,
    weight: 0.92,
  },
  {
    anchor: "rightFoot",
    chain: ["rightUpperLeg", "rightLowerLeg"],
    effector: "rightFoot",
    iterations: PILOT_IK_CONFIG.footIterations,
    maxAngle: PILOT_IK_CONFIG.footMaxAngleRad,
    weight: 0.42,
  },
  {
    anchor: "leftFoot",
    chain: ["leftUpperLeg", "leftLowerLeg"],
    effector: "leftFoot",
    iterations: PILOT_IK_CONFIG.footIterations,
    maxAngle: PILOT_IK_CONFIG.footMaxAngleRad,
    weight: 0.42,
  },
] as const;

export function PilotAvatar({ parts, ship }: PilotAvatarProps) {
  const avatarRootRef = useRef<THREE.Group>(null);
  const elapsedRef = useRef(0);
  const lookTarget = useMemo(() => new THREE.Object3D(), []);
  const probeConfig = useMemo(() => readPilotRenderProbeConfig(), []);
  const anchors = useMemo(
    () => ({
      leftFoot: new THREE.Object3D(),
      leftThrottle: new THREE.Object3D(),
      rightFoot: new THREE.Object3D(),
      rightGrip: new THREE.Object3D(),
      seatBack: new THREE.Object3D(),
      seatHip: new THREE.Object3D(),
    }),
    [],
  );
  const runtimeRig = useRef<PilotRuntimeRig | null>(null);
  const probeStats = useRef<PilotRenderProbeStats | undefined>(undefined);
  const [vrm, setVrm] = useState<VRM | null>(null);

  useEffect(() => {
    let disposed = false;
    const loader = new GLTFLoader();
    loader.crossOrigin = "anonymous";
    loader.register((parser) => new VRMLoaderPlugin(parser));

    loader
      .loadAsync(PILOT_MODEL_URL)
      .then((gltf: GLTF) => {
        if (disposed) return;
        const loaded = gltf.userData.vrm as VRM | undefined;
        if (!loaded) throw new Error("Pilot model did not contain VRM data.");

        VRMUtils.rotateVRM0(loaded);
        probeStats.current = prepareVrmScene(loaded.scene, probeConfig);
        fitAvatarToLocalOrigin(loaded.scene);
        loaded.scene.updateMatrixWorld(true);

        const rig = capturePilotRuntimeRig(loaded);
        if (loaded.lookAt && probeConfig.lookAt) loaded.lookAt.target = lookTarget;
        runtimeRig.current = rig;
        setVrm(loaded);
      })
      .catch((error: unknown) => {
        console.error("Pilot avatar load failed", error);
      });

    return () => {
      disposed = true;
    };
  }, [lookTarget, probeConfig]);

  useFrame((_, delta) => {
    const avatarRoot = avatarRootRef.current;
    const rig = runtimeRig.current;
    if (!avatarRoot || !rig || !vrm) {
      publishPilotDebug(null, null, false);
      return;
    }

    elapsedRef.current += Math.min(delta, 0.05);
    const cockpit = computeCockpitRig(ship.controls, parts);
    for (const [name, anchor] of Object.entries(anchors)) {
      anchor.position.copy(cockpit.anchors[name as keyof typeof cockpit.anchors]);
      anchor.updateMatrixWorld(true);
    }

    avatarRoot.parent?.updateMatrixWorld(true);
    avatarRoot.position.copy(
      positionAvatarRootForSeat({
        hipLocalMeters: rig.hips,
        seatHip: cockpit.anchors.seatHip,
      }),
    );
    avatarRoot.rotation.set(0, PILOT_AVATAR_YAW_RAD, 0);
    avatarRoot.scale.setScalar(PILOT_AVATAR_SCALE);

    const forces = computePilotForces(ship);
    const pose = buildPilotPose({
      elapsed: elapsedRef.current,
      forces,
      trigger: ship.controls.trigger,
    });
    applyPilotPose(vrm, rig, pose, lookTarget, cockpit.anchors.seatHip, probeConfig);

    avatarRoot.updateMatrixWorld(true);
    vrm.scene.updateMatrixWorld(true);
    if (probeConfig.ik) {
      solvePilotContacts(vrm, avatarRoot, anchors);
    }
    if (probeConfig.vrmUpdate) {
      vrm.update(delta);
    }
    avatarRoot.updateMatrixWorld(true);
    vrm.scene.updateMatrixWorld(true);
    publishPilotDebug(vrm, avatarRoot, true, forces, anchors, probeStats.current, cockpit.station);
  });

  return (
    <>
      {Object.entries(anchors).map(([name, anchor]) => (
        <primitive key={name} object={anchor} />
      ))}
      <primitive object={lookTarget} />
      <group ref={avatarRootRef}>{vrm ? <primitive object={vrm.scene} /> : null}</group>
    </>
  );
}

function prepareVrmScene(scene: THREE.Object3D, config: PilotRenderProbeConfig): PilotRenderProbeStats {
  let meshIndex = 0;
  let morphMeshCount = 0;
  let shaderMaterialCount = 0;
  let skinnedMeshCount = 0;
  let visibleMeshCount = 0;

  scene.traverse((object) => {
    object.frustumCulled = false;
    const mesh = object as THREE.Mesh;
    if (mesh.isMesh) {
      const visible = config.visible && (config.meshLimit === null || meshIndex < config.meshLimit);
      mesh.visible = visible;
      mesh.castShadow = config.shadows;
      mesh.receiveShadow = config.shadows;
      if (visible) visibleMeshCount += 1;
      if ((mesh as THREE.Mesh & { isSkinnedMesh?: boolean }).isSkinnedMesh) skinnedMeshCount += 1;
      if (mesh.morphTargetInfluences?.length) morphMeshCount += 1;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      shaderMaterialCount += materials.filter((material) => material?.type === "ShaderMaterial").length;
      if (config.morphs === "strip") stripMorphTargets(mesh);
      if (config.material !== "vrm") replaceMaterial(mesh, meshIndex, config.material);
      meshIndex += 1;
    }
  });

  return {
    config,
    meshCount: meshIndex,
    morphMeshCount,
    shaderMaterialCount,
    skinnedMeshCount,
    visibleMeshCount,
  };
}

function replaceMaterial(mesh: THREE.Mesh, index: number, material: "basic" | "standard") {
  const hue = (index * 0.17) % 1;
  const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const color = materialColor(source) ?? materialNameColor(source?.name) ?? new THREE.Color().setHSL(hue, 0.48, 0.68);
  const map = materialTexture(source, "map") ?? materialTexture(source, "shadeMultiplyTexture");
  const emissive = materialNonWhiteColor(source, "emissive") ?? new THREE.Color("#000000");
  const emissiveMap = materialTexture(source, "emissiveMap");
  const alphaTest = materialNumber(source, "alphaTest") ?? 0;
  const transparent = materialBoolean(source, "transparent") ?? false;
  const opacity = materialNumber(source, "opacity") ?? 1;
  mesh.material =
    material === "basic"
      ? new THREE.MeshBasicMaterial({
          color,
          map,
          alphaTest,
          opacity,
          side: THREE.DoubleSide,
          transparent,
        })
      : new THREE.MeshStandardMaterial({
          color,
          map,
          alphaTest,
          emissive,
          emissiveMap,
          emissiveIntensity: emissiveMap || emissive.getHex() !== 0 ? 0.55 : 0,
          opacity,
          roughness: 0.72,
          metalness: 0.02,
          side: THREE.DoubleSide,
          transparent,
        });
  if (Array.isArray(mesh.material)) {
    for (const oldMaterial of mesh.material) oldMaterial.dispose();
  } else {
    source?.dispose();
  }
}

function materialColor(material: THREE.Material | undefined): THREE.Color | null {
  if (!material) return null;
  const namedColor = materialNameColor(material.name, material);
  if (namedColor) return namedColor;
  const uniformValue =
    materialNonWhiteColor(material, "shadeColorFactor") ??
    materialNonWhiteColor(material, "diffuse") ??
    materialNonWhiteColor(material, "litFactor");
  const directValue = (material as unknown as { color?: unknown }).color;
  if (uniformValue instanceof THREE.Color) return uniformValue.clone();
  if (directValue instanceof THREE.Color && !isNearlyWhite(directValue)) return directValue.clone();
  return null;
}

function materialNameColor(name: string | undefined, material?: THREE.Material): THREE.Color | null {
  const upperName = name?.toUpperCase() ?? "";
  if (upperName.includes("HAIR")) {
    return materialNonWhiteColor(material, "emissive") ?? new THREE.Color("#d58a48");
  }
  if (upperName.includes("IRIS")) return new THREE.Color("#5f8fdc");
  if (upperName.includes("EYEWHITE") || upperName.includes("EYEHIGHLIGHT")) return new THREE.Color("#f4fbff");
  if (upperName.includes("EYELINE") || upperName.includes("BROW")) return new THREE.Color("#28323c");
  if (upperName.includes("MOUTH")) return new THREE.Color("#7d3f56");
  if (upperName.includes("SKIN") || upperName.includes("FACE")) {
    return materialNonWhiteColor(material, "shadeColorFactor") ?? new THREE.Color("#f3c9d2");
  }
  if (upperName.includes("CLOTH") || upperName.includes("TOP") || upperName.includes("BOTTOM")) {
    return materialNonWhiteColor(material, "shadeColorFactor") ?? new THREE.Color("#c6cce8");
  }
  if (upperName.includes("SHOES")) return new THREE.Color("#6e7288");
  return null;
}

function materialNonWhiteColor(material: THREE.Material | undefined, name: string): THREE.Color | null {
  if (!material) return null;
  const value = shaderUniformValue(material, name) ?? (material as unknown as Record<string, unknown>)[name];
  return value instanceof THREE.Color && !isNearlyWhite(value) ? value.clone() : null;
}

function materialTexture(material: THREE.Material | undefined, name: string): THREE.Texture | null {
  if (!material) return null;
  const uniformValue = shaderUniformValue(material, name);
  const directValue = (material as unknown as Record<string, unknown>)[name];
  const value = uniformValue ?? directValue;
  return value instanceof THREE.Texture ? value : null;
}

function materialNumber(material: THREE.Material | undefined, name: string): number | null {
  if (!material) return null;
  const uniformValue = shaderUniformValue(material, name);
  const directValue = (material as unknown as Record<string, unknown>)[name];
  const value = typeof uniformValue === "number" ? uniformValue : directValue;
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function materialBoolean(material: THREE.Material | undefined, name: string): boolean | null {
  if (!material) return null;
  const directValue = (material as unknown as Record<string, unknown>)[name];
  return typeof directValue === "boolean" ? directValue : null;
}

function shaderUniformValue(material: THREE.Material, name: string): unknown {
  const uniforms = (material as THREE.ShaderMaterial).uniforms;
  return uniforms?.[name]?.value;
}

function isNearlyWhite(color: THREE.Color): boolean {
  return color.r > 0.94 && color.g > 0.94 && color.b > 0.94;
}

function stripMorphTargets(mesh: THREE.Mesh) {
  if (!mesh.morphTargetInfluences?.length) return;

  const geometry = mesh.geometry.clone();
  geometry.morphAttributes = {};
  geometry.morphTargetsRelative = false;
  mesh.geometry = geometry;
  mesh.morphTargetInfluences = [];
  mesh.morphTargetDictionary = {};
}

function fitAvatarToLocalOrigin(object: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(object);
  const center = box.getCenter(new THREE.Vector3());
  object.position.x -= center.x;
  object.position.z -= center.z;
  object.position.y -= box.min.y;
}

function capturePilotRuntimeRig(vrm: VRM): PilotRuntimeRig {
  const rests = new Map<string, THREE.Quaternion>();
  for (const boneName of CONTROLLED_PILOT_BONES) {
    const bone = getNormalizedBone(vrm, boneName);
    if (bone) rests.set(boneName, bone.quaternion.clone());
  }

  const hips = localBonePosition(vrm, "hips");
  return { hips, rests };
}

function applyPilotPose(
  vrm: VRM,
  rig: PilotRuntimeRig,
  pose: PilotPose,
  lookTarget: THREE.Object3D,
  seatHip: THREE.Vector3,
  config: PilotRenderProbeConfig,
) {
  for (const boneName of CONTROLLED_PILOT_BONES) {
    setBoneEuler(vrm, rig, boneName, pose.bones[boneName] ?? { x: 0, y: 0, z: 0 });
  }

  if (config.lookAt) {
    lookTarget.position.set(
      pose.lookAt.x * 0.05,
      seatHip.y + 0.11 + pose.lookAt.y * 0.04,
      seatHip.z - 0.22,
    );
  }

  if (config.expressions) {
    for (const expressionName of PILOT_EXPRESSION_NAMES) {
      setExpression(vrm, expressionName, pose.expressions[expressionName] ?? 0);
    }
  }
}

function solvePilotContacts(
  vrm: VRM,
  avatarRoot: THREE.Object3D,
  anchors: Record<string, THREE.Object3D>,
) {
  avatarRoot.updateMatrixWorld(true);
  vrm.scene.updateMatrixWorld(true);

  for (const spec of CONTACT_SPECS) {
    solveCcdIk({
      chain: spec.chain.map((name) => getIkBone(vrm, name)),
      effector: getIkBone(vrm, spec.effector),
      iterations: spec.iterations,
      maxAngle: spec.maxAngle,
      target: anchors[spec.anchor],
      updateWorld: () => {
        avatarRoot.updateMatrixWorld(true);
        vrm.scene.updateMatrixWorld(true);
      },
      weight: spec.weight,
    });
  }
}

function setBoneEuler(vrm: VRM, rig: PilotRuntimeRig, name: string, rotation: Rotation) {
  const bone = getNormalizedBone(vrm, name);
  const rest = rig.rests.get(name);
  if (!bone || !rest) return;

  const offset = new THREE.Quaternion().setFromEuler(new THREE.Euler(rotation.x, rotation.y, rotation.z, "XYZ"));
  bone.quaternion.copy(rest).multiply(offset);
}

function setExpression(vrm: VRM, name: string, value: number) {
  try {
    vrm.expressionManager?.setValue(name, THREE.MathUtils.clamp(value, 0, 1));
  } catch {
    // Some VRMs omit standard presets. Missing expression slots should not break flight rendering.
  }
}

function getIkBone(vrm: VRM, name: string): THREE.Object3D | null {
  return getNormalizedBone(vrm, name) ?? getRawBone(vrm, name);
}

function getNormalizedBone(vrm: VRM, name: string): THREE.Object3D | null {
  return vrm.humanoid.getNormalizedBoneNode(name as VRMHumanBoneName);
}

function getRawBone(vrm: VRM, name: string): THREE.Object3D | null {
  return (
    vrm.humanoid.getRawBoneNode(name as VRMHumanBoneName) ??
    vrm.humanoid.getBoneNode(name as VRMHumanBoneName)
  );
}

function localBonePosition(vrm: VRM, name: string): THREE.Vector3 {
  const bone = getRawBone(vrm, name) ?? getNormalizedBone(vrm, name);
  if (!bone) return new THREE.Vector3();

  vrm.scene.updateMatrixWorld(true);
  const position = bone.getWorldPosition(new THREE.Vector3());
  return vrm.scene.worldToLocal(position);
}

function publishPilotDebug(
  vrm: VRM | null,
  avatarRoot: THREE.Object3D | null,
  loaded: boolean,
  forces = { vertical: 0, lateral: 0, foreAft: 0 },
  anchors?: Record<string, THREE.Object3D>,
  probe?: PilotRenderProbeStats,
  station?: ReturnType<typeof computeCockpitRig>["station"],
) {
  if (typeof window === "undefined") return;
  if (!vrm || !avatarRoot || !anchors) {
    window.__flightPilotRig = { contactErrors: {}, forces, loaded, probe, root: null, station: null };
    return;
  }

  const contactErrors: Record<string, number | null> = {};
  for (const spec of CONTACT_SPECS) {
    const bone = getRawBone(vrm, spec.effector) ?? getNormalizedBone(vrm, spec.effector);
    const anchor = anchors[spec.anchor];
    contactErrors[spec.effector] = bone && anchor
      ? bone.getWorldPosition(new THREE.Vector3()).distanceTo(anchor.getWorldPosition(new THREE.Vector3()))
      : null;
  }

  window.__flightPilotRig = {
    contactErrors,
    forces,
    loaded,
    probe,
    root: [avatarRoot.position.x, avatarRoot.position.y, avatarRoot.position.z],
    station: station
      ? { canopyId: station.canopy?.id ?? null, source: station.source, stationId: station.stationId }
      : null,
  };
}

function readPilotRenderProbeConfig(): PilotRenderProbeConfig {
  const params =
    typeof window === "undefined"
      ? new URLSearchParams()
      : new URLSearchParams(window.location.search);
  return {
    expressions: queryFlag(params, "pilotExpressions", true),
    ik: queryFlag(params, "pilotIk", true),
    lookAt: queryFlag(params, "pilotLookAt", true),
    material: readMaterialMode(params),
    meshLimit: queryNumber(params, "pilotMeshLimit"),
    morphs: params.get("pilotMorphs") === "strip" ? "strip" : "keep",
    shadows: queryFlag(params, "pilotShadows", true),
    visible: queryFlag(params, "pilotVisible", true),
    vrmUpdate: queryFlag(params, "pilotVrmUpdate", true),
  };
}

function readMaterialMode(params: URLSearchParams): PilotRenderProbeConfig["material"] {
  const value = params.get("pilotMaterial");
  return value === "basic" || value === "vrm" ? value : "standard";
}

function queryFlag(params: URLSearchParams, name: string, fallback: boolean): boolean {
  const value = params.get(name);
  if (value === null) return fallback;
  return !["0", "false", "off", "no"].includes(value.toLowerCase());
}

function queryNumber(params: URLSearchParams, name: string): number | null {
  const value = params.get(name);
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : null;
}
