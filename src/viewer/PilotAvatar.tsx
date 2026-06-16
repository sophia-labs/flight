import { useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState, type MutableRefObject, type RefObject } from "react";
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
import type { PilotProfile } from "../studio/schema";
import { normalizeVrmWearableIds, type VrmWearableId } from "../studio/vrmWearables";
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
  buildPilotLoadoutPose,
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

interface CockpitPilotAvatarProps {
  parts?: Part[];
  profile?: PilotProfile;
  ship: AircraftSnapshot;
}

interface LoadoutPilotAvatarProps {
  profile: PilotProfile;
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

interface PilotAvatarRuntime {
  lookTarget: THREE.Object3D;
  probeConfig: PilotRenderProbeConfig;
  probeStats: MutableRefObject<PilotRenderProbeStats | undefined>;
  runtimeRig: MutableRefObject<PilotRuntimeRig | null>;
  vrm: VRM | null;
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
  wearables?: string[];
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

function prepareVrmScene(
  scene: THREE.Object3D,
  config: PilotRenderProbeConfig,
  appearance?: PilotAppearanceConfig,
): PilotRenderProbeStats {
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
      if (config.material !== "vrm") replaceMaterial(mesh, meshIndex, config.material, appearance);
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

function applyVrmAppearance(
  scene: THREE.Object3D,
  config: PilotRenderProbeConfig,
  appearance?: PilotAppearanceConfig,
) {
  if (config.material === "vrm") return;

  scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;

    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const nextColor = materialNameColor(material.name || mesh.name, material, appearance);
      const target = material as THREE.Material & { color?: THREE.Color };
      if (nextColor && target.color instanceof THREE.Color) target.color.copy(nextColor);
    }
  });
}

interface PilotAppearanceConfig {
  accentTint?: string;
  eyeTint?: string;
  hairTint?: string;
  outfitTint?: string;
  skinWarmth?: number;
}

function usePilotAvatarRuntime(profile?: PilotProfile): PilotAvatarRuntime {
  const lookTarget = useMemo(() => new THREE.Object3D(), []);
  const probeConfig = useMemo(() => readPilotRenderProbeConfig(profile), [profile?.materialPreset]);
  const appearance = useMemo(() => profile?.appearance, [profile?.appearance]);
  const modelUrl = profile?.modelUrl ?? PILOT_MODEL_URL;
  const runtimeRig = useRef<PilotRuntimeRig | null>(null);
  const probeStats = useRef<PilotRenderProbeStats | undefined>(undefined);
  const appearanceRef = useRef<PilotAppearanceConfig | undefined>(appearance);
  const [vrm, setVrm] = useState<VRM | null>(null);

  useEffect(() => {
    appearanceRef.current = appearance;
    if (vrm) applyVrmAppearance(vrm.scene, probeConfig, appearance);
  }, [appearance, probeConfig, vrm]);

  useEffect(() => {
    let disposed = false;
    runtimeRig.current = null;
    probeStats.current = undefined;
    setVrm(null);
    const loader = new GLTFLoader();
    loader.crossOrigin = "anonymous";
    loader.register((parser) => new VRMLoaderPlugin(parser));

    loader
      .loadAsync(modelUrl)
      .then((gltf: GLTF) => {
        if (disposed) return;
        const loaded = gltf.userData.vrm as VRM | undefined;
        if (!loaded) throw new Error("Pilot model did not contain VRM data.");

        VRMUtils.rotateVRM0(loaded);
        probeStats.current = prepareVrmScene(loaded.scene, probeConfig, appearanceRef.current);
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
  }, [lookTarget, modelUrl, probeConfig]);

  return { lookTarget, probeConfig, probeStats, runtimeRig, vrm };
}

export function PilotAvatar({ parts, profile, ship }: CockpitPilotAvatarProps) {
  const avatarRootRef = useRef<THREE.Group>(null);
  const elapsedRef = useRef(0);
  const { lookTarget, probeConfig, probeStats, runtimeRig, vrm } = usePilotAvatarRuntime(profile);
  const wearableIds = usePilotWearables(vrm, profile);
  const avatarScale = profile?.scale ?? PILOT_AVATAR_SCALE;
  const avatarYaw = profile?.yawRad ?? PILOT_AVATAR_YAW_RAD;
  const expressionPreset = profile?.expressionPreset ?? "focused";
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

  useFrame((_, delta) => {
    const avatarRoot = avatarRootRef.current;
    const rig = runtimeRig.current;
    if (!avatarRoot || !rig || !vrm) {
      publishPilotDebug(null, null, false, undefined, undefined, undefined, undefined, wearableIds);
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
        scale: avatarScale,
        seatHip: cockpit.anchors.seatHip,
        yawRad: avatarYaw,
      }),
    );
    avatarRoot.rotation.set(0, avatarYaw, 0);
    avatarRoot.scale.setScalar(avatarScale);

    const forces = computePilotForces(ship);
    const pose = buildPilotPose({
      elapsed: elapsedRef.current,
      forces,
      trigger: ship.controls.trigger,
    });
    applyExpressionPreset(pose, expressionPreset);
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
    publishPilotDebug(vrm, avatarRoot, true, forces, anchors, probeStats.current, cockpit.station, wearableIds);
  });

  return (
    <PilotAvatarObjects
      anchors={anchors}
      avatarRootRef={avatarRootRef}
      lookTarget={lookTarget}
      vrm={vrm}
    />
  );
}

export function LoadoutPilotAvatar({ profile }: LoadoutPilotAvatarProps) {
  const avatarRootRef = useRef<THREE.Group>(null);
  const elapsedRef = useRef(0);
  const lookAnchor = useMemo(() => new THREE.Vector3(0, 0.95, 0), []);
  const { lookTarget, probeConfig, probeStats, runtimeRig, vrm } = usePilotAvatarRuntime(profile);
  const wearableIds = usePilotWearables(vrm, profile);
  const expressionPreset = profile.expressionPreset ?? "focused";

  useFrame((_, delta) => {
    const avatarRoot = avatarRootRef.current;
    const rig = runtimeRig.current;
    if (!avatarRoot || !rig || !vrm) {
      publishPilotDebug(null, null, false, undefined, undefined, undefined, undefined, wearableIds);
      return;
    }

    elapsedRef.current += Math.min(delta, 0.05);
    avatarRoot.parent?.updateMatrixWorld(true);
    avatarRoot.position.set(0, 0, 0);
    avatarRoot.rotation.set(0, Math.sin(elapsedRef.current * 0.38) * 0.08, 0);
    avatarRoot.scale.setScalar(0.72);

    const forces = { vertical: 0, lateral: 0, foreAft: 0 };
    const pose = buildPilotLoadoutPose({
      elapsed: elapsedRef.current,
      expressionPreset,
    });
    applyPilotPose(vrm, rig, pose, lookTarget, lookAnchor, probeConfig);

    avatarRoot.updateMatrixWorld(true);
    vrm.scene.updateMatrixWorld(true);
    if (probeConfig.vrmUpdate) vrm.update(delta);
    avatarRoot.updateMatrixWorld(true);
    vrm.scene.updateMatrixWorld(true);
    publishPilotDebug(vrm, avatarRoot, true, forces, undefined, probeStats.current, undefined, wearableIds);
  });

  return <PilotAvatarObjects avatarRootRef={avatarRootRef} lookTarget={lookTarget} vrm={vrm} />;
}

function PilotAvatarObjects({
  anchors,
  avatarRootRef,
  lookTarget,
  vrm,
}: {
  anchors?: Record<string, THREE.Object3D>;
  avatarRootRef: RefObject<THREE.Group | null>;
  lookTarget: THREE.Object3D;
  vrm: VRM | null;
}) {
  return (
    <>
      {Object.entries(anchors ?? {}).map(([name, anchor]) => (
        <primitive key={name} object={anchor} />
      ))}
      <primitive object={lookTarget} />
      <group ref={avatarRootRef}>{vrm ? <primitive object={vrm.scene} /> : null}</group>
    </>
  );
}

function usePilotWearables(vrm: VRM | null, profile?: PilotProfile): VrmWearableId[] {
  const wearableIds = useMemo(
    () => normalizeVrmWearableIds(profile?.vrmWearables),
    [profile?.vrmWearables],
  );
  const appearance = useMemo(() => profile?.appearance, [profile?.appearance]);

  useEffect(() => {
    if (!vrm) return;

    const attached: THREE.Object3D[] = [];
    for (const id of wearableIds) {
      for (const attachment of createWearableAttachments(id, appearance)) {
        const bone = getNormalizedBone(vrm, attachment.boneName) ?? getRawBone(vrm, attachment.boneName);
        if (!bone) continue;
        bone.add(attachment.object);
        attached.push(attachment.object);
      }
    }

    return () => {
      for (const object of attached) {
        object.parent?.remove(object);
        disposeObject(object);
      }
    };
  }, [appearance, vrm, wearableIds]);

  return wearableIds;
}

function createWearableAttachments(
  id: VrmWearableId,
  appearance?: PilotAppearanceConfig,
): Array<{ boneName: string; object: THREE.Object3D }> {
  if (id === "flight-headset") return [{ boneName: "head", object: createFlightHeadset(appearance) }];
  if (id === "g-suit-harness") return [{ boneName: "chest", object: createSuitHarness(appearance) }];
  if (id === "data-gloves") {
    return [
      { boneName: "leftHand", object: createDataGlove("left", appearance) },
      { boneName: "rightHand", object: createDataGlove("right", appearance) },
    ];
  }
  return [];
}

function createFlightHeadset(appearance?: PilotAppearanceConfig): THREE.Group {
  const colors = wearableColors(appearance);
  const group = new THREE.Group();
  group.name = "vrm-wearable-flight-headset";
  group.position.set(0, 0.055, -0.005);

  group.add(wearableBox([0.22, 0.018, 0.022], colors.dark, [0, 0.095, 0]));
  group.add(wearableBox([0.048, 0.084, 0.052], colors.dark, [-0.118, 0.018, 0]));
  group.add(wearableBox([0.048, 0.084, 0.052], colors.dark, [0.118, 0.018, 0]));
  group.add(wearableBox([0.028, 0.052, 0.058], colors.accent, [-0.119, 0.015, -0.002]));
  group.add(wearableBox([0.028, 0.052, 0.058], colors.accent, [0.119, 0.015, -0.002]));
  group.add(wearableBox([0.012, 0.012, 0.13], colors.accent, [-0.13, -0.034, -0.05], [0.42, 0, 0.18]));
  group.add(wearableBox([0.026, 0.018, 0.018], colors.light, [-0.102, -0.074, -0.102]));
  return group;
}

function createSuitHarness(appearance?: PilotAppearanceConfig): THREE.Group {
  const colors = wearableColors(appearance);
  const group = new THREE.Group();
  group.name = "vrm-wearable-g-suit-harness";
  group.position.set(0, -0.055, -0.078);

  group.add(wearableBox([0.036, 0.38, 0.018], colors.dark, [-0.048, 0, 0], [0, 0, -0.42]));
  group.add(wearableBox([0.036, 0.38, 0.018], colors.dark, [0.048, 0, 0], [0, 0, 0.42]));
  group.add(wearableBox([0.18, 0.036, 0.02], colors.accent, [0, -0.086, -0.006]));
  group.add(wearableBox([0.082, 0.052, 0.026], colors.light, [0, -0.087, -0.023]));
  return group;
}

function createDataGlove(side: "left" | "right", appearance?: PilotAppearanceConfig): THREE.Group {
  const colors = wearableColors(appearance);
  const group = new THREE.Group();
  group.name = `vrm-wearable-${side}-data-glove`;
  group.position.set(0, -0.012, 0);

  group.add(wearableBox([0.076, 0.044, 0.064], colors.dark, [0, 0, 0]));
  group.add(wearableBox([0.044, 0.012, 0.068], colors.accent, [side === "left" ? -0.018 : 0.018, -0.016, -0.006]));
  return group;
}

function wearableColors(appearance?: PilotAppearanceConfig) {
  return {
    accent: colorFromHex(appearance?.accentTint) ?? new THREE.Color("#f2c94c"),
    dark: colorFromHex(appearance?.outfitTint)?.multiplyScalar(0.28) ?? new THREE.Color("#1a2430"),
    light: colorFromHex(appearance?.eyeTint) ?? new THREE.Color("#67a7ff"),
  };
}

function wearableBox(
  size: [number, number, number],
  color: THREE.Color,
  position: [number, number, number],
  rotation: [number, number, number] = [0, 0, 0],
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(...size),
    new THREE.MeshStandardMaterial({
      color,
      emissive: color.clone().multiplyScalar(0.18),
      emissiveIntensity: 0.22,
      roughness: 0.46,
      metalness: 0.18,
    }),
  );
  mesh.name = "vrm-wearable-primitive";
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) material?.dispose();
  });
}

function replaceMaterial(
  mesh: THREE.Mesh,
  index: number,
  material: "basic" | "standard",
  appearance?: PilotAppearanceConfig,
) {
  const hue = (index * 0.17) % 1;
  const oldMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const source = oldMaterials[0];
  const materialName = source?.name || mesh.name;
  const color =
    materialColor(source, appearance) ??
    materialNameColor(materialName, source, appearance) ??
    new THREE.Color().setHSL(hue, 0.48, 0.68);
  const map = materialTexture(source, "map") ?? materialTexture(source, "shadeMultiplyTexture");
  const emissive = materialNonWhiteColor(source, "emissive") ?? new THREE.Color("#000000");
  const emissiveMap = materialTexture(source, "emissiveMap");
  const alphaTest = materialNumber(source, "alphaTest") ?? 0;
  const transparent = materialBoolean(source, "transparent") ?? false;
  const opacity = materialNumber(source, "opacity") ?? 1;
  const replacement =
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
  replacement.name = materialName;
  mesh.material = replacement;
  for (const oldMaterial of oldMaterials) oldMaterial?.dispose();
}

function materialColor(material: THREE.Material | undefined, appearance?: PilotAppearanceConfig): THREE.Color | null {
  if (!material) return null;
  const namedColor = materialNameColor(material.name, material, appearance);
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

function materialNameColor(
  name: string | undefined,
  material?: THREE.Material,
  appearance?: PilotAppearanceConfig,
): THREE.Color | null {
  const upperName = name?.toUpperCase() ?? "";
  if (upperName.includes("HAIR")) {
    return colorFromHex(appearance?.hairTint) ?? materialNonWhiteColor(material, "emissive") ?? new THREE.Color("#d58a48");
  }
  if (upperName.includes("IRIS")) return colorFromHex(appearance?.eyeTint) ?? new THREE.Color("#5f8fdc");
  if (upperName.includes("EYEWHITE") || upperName.includes("EYEHIGHLIGHT")) return new THREE.Color("#f4fbff");
  if (upperName.includes("EYELINE") || upperName.includes("BROW")) return new THREE.Color("#28323c");
  if (upperName.includes("MOUTH")) return new THREE.Color("#7d3f56");
  if (upperName.includes("SKIN") || upperName.includes("FACE")) {
    return warmSkinColor(appearance?.skinWarmth) ?? materialNonWhiteColor(material, "shadeColorFactor") ?? new THREE.Color("#f3c9d2");
  }
  if (upperName.includes("CLOTH") || upperName.includes("TOP") || upperName.includes("BOTTOM")) {
    return colorFromHex(appearance?.outfitTint) ?? materialNonWhiteColor(material, "shadeColorFactor") ?? new THREE.Color("#c6cce8");
  }
  if (upperName.includes("SHOES") || upperName.includes("RIBBON") || upperName.includes("TIE")) {
    return colorFromHex(appearance?.accentTint) ?? new THREE.Color("#6e7288");
  }
  return null;
}

function colorFromHex(value: string | undefined): THREE.Color | null {
  if (!value) return null;
  try {
    return new THREE.Color(value);
  } catch {
    return null;
  }
}

function warmSkinColor(warmth: number | undefined): THREE.Color | null {
  if (warmth === undefined) return null;
  const color = new THREE.Color("#f3c9d2");
  const warm = new THREE.Color("#ffd0b1");
  const cool = new THREE.Color("#e5c7ec");
  return warmth >= 0 ? color.lerp(warm, Math.min(warmth, 1) * 0.45) : color.lerp(cool, Math.min(Math.abs(warmth), 1) * 0.35);
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

function applyExpressionPreset(pose: PilotPose, preset: PilotProfile["expressionPreset"]) {
  if (preset === "neutral") {
    pose.expressions.relaxed = Math.max(pose.expressions.relaxed ?? 0, 0.12);
    return;
  }
  if (preset === "excited") {
    pose.expressions.happy = Math.max(pose.expressions.happy ?? 0, 0.28);
    pose.expressions.aa = Math.max(pose.expressions.aa ?? 0, 0.12);
    pose.lookAt.y += 0.02;
    return;
  }
  if (preset === "strained") {
    pose.expressions.angry = Math.max(pose.expressions.angry ?? 0, 0.22);
    pose.expressions.ih = Math.max(pose.expressions.ih ?? 0, 0.18);
    pose.lookAt.y -= 0.02;
    return;
  }

  pose.expressions.relaxed = Math.max(pose.expressions.relaxed ?? 0, 0.18);
  pose.expressions.ih = Math.max(pose.expressions.ih ?? 0, 0.04);
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
  wearables: readonly string[] = [],
) {
  if (typeof window === "undefined") return;
  if (!vrm || !avatarRoot) {
    window.__flightPilotRig = { contactErrors: {}, forces, loaded, probe, root: null, station: null, wearables: [...wearables] };
    return;
  }

  const contactErrors: Record<string, number | null> = {};
  if (anchors) {
    for (const spec of CONTACT_SPECS) {
      const bone = getRawBone(vrm, spec.effector) ?? getNormalizedBone(vrm, spec.effector);
      const anchor = anchors[spec.anchor];
      contactErrors[spec.effector] = bone && anchor
        ? bone.getWorldPosition(new THREE.Vector3()).distanceTo(anchor.getWorldPosition(new THREE.Vector3()))
        : null;
    }
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
    wearables: [...wearables],
  };
}

function readPilotRenderProbeConfig(profile?: PilotProfile): PilotRenderProbeConfig {
  const params =
    typeof window === "undefined"
      ? new URLSearchParams()
      : new URLSearchParams(window.location.search);
  return {
    expressions: queryFlag(params, "pilotExpressions", true),
    ik: queryFlag(params, "pilotIk", true),
    lookAt: queryFlag(params, "pilotLookAt", true),
    material: readMaterialMode(params, profile),
    meshLimit: queryNumber(params, "pilotMeshLimit"),
    morphs: params.get("pilotMorphs") === "strip" ? "strip" : "keep",
    shadows: queryFlag(params, "pilotShadows", true),
    visible: queryFlag(params, "pilotVisible", true),
    vrmUpdate: queryFlag(params, "pilotVrmUpdate", true),
  };
}

function readMaterialMode(params: URLSearchParams, profile?: PilotProfile): PilotRenderProbeConfig["material"] {
  const value = params.get("pilotMaterial");
  if (value === "basic" || value === "vrm" || value === "standard") return value;
  if (profile?.materialPreset === "vrm") return "vrm";
  if (profile?.materialPreset === "diagnostic") return "basic";
  return "standard";
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
