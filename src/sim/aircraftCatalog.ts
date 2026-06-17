import type { Airframe, Part } from "../protocol/schema";
import { cockpitCamera, noseCamera, noseRadar } from "./airframe";
import { quatFromAxisAngle, quatIdentity, vec3 } from "./math";

type CanopyStyle = Extract<Part, { kind: "canopy" }>["style"];
type GearStyle = Extract<Part, { kind: "gear" }>["style"];
type WeaponRole = Extract<Part, { kind: "weapon" }>["role"];

export interface ReferenceAircraft {
  id: string;
  name: string;
  era: string;
  country: string;
  role: string;
  engine: string;
  powerHp: number;
  spanM: number;
  lengthM: number;
  wingAreaM2: number;
  loadedMassKg: number;
  silhouette: string;
}

export interface AircraftArchetype {
  id: string;
  name: string;
  shortName: string;
  role: string;
  summary: string;
  designLine: string;
  referenceIds: string[];
  palette: {
    base: string;
    trim: string;
  };
  airframe: Airframe;
}

// Rounded public-domain style reference notes. These are research anchors, not replica contracts.
// The playable airframes below intentionally translate them into our own blocky aircraft language.
export const referenceAircraft: ReferenceAircraft[] = [
  {
    id: "p51d",
    name: "North American P-51D Mustang",
    era: "WW2 / Korea",
    country: "US",
    role: "long-range escort fighter",
    engine: "Packard Merlin V-1650 inline",
    powerHp: 1490,
    spanM: 11.28,
    lengthM: 9.83,
    wingAreaM2: 21.83,
    loadedMassKg: 4175,
    silhouette: "long nose, ventral scoop, laminar low wing, bubble canopy",
  },
  {
    id: "spitfire-lfix",
    name: "Supermarine Spitfire LF Mk IX",
    era: "WW2",
    country: "UK",
    role: "interceptor",
    engine: "Rolls-Royce Merlin 66 inline",
    powerHp: 1720,
    spanM: 9.9,
    lengthM: 9.47,
    wingAreaM2: 21.46,
    loadedMassKg: 3354,
    silhouette: "elliptic/clipped wing, compact fuselage, high canopy line",
  },
  {
    id: "bf109g",
    name: "Messerschmitt Bf 109G",
    era: "WW2",
    country: "Germany",
    role: "interceptor",
    engine: "Daimler-Benz DB 605 inline",
    powerHp: 1475,
    spanM: 9.92,
    lengthM: 8.95,
    wingAreaM2: 16.05,
    loadedMassKg: 3148,
    silhouette: "narrow gear, compact wing, heavy nose, small cockpit",
  },
  {
    id: "f4u4",
    name: "Vought F4U-4 Corsair",
    era: "WW2 / Korea",
    country: "US",
    role: "carrier fighter-bomber",
    engine: "Pratt & Whitney R-2800 radial",
    powerHp: 2450,
    spanM: 12.49,
    lengthM: 10.16,
    wingAreaM2: 29.17,
    loadedMassKg: 5634,
    silhouette: "large radial nose, bent carrier wing, tall tail, rear cockpit",
  },
  {
    id: "f6f5",
    name: "Grumman F6F-5 Hellcat",
    era: "WW2",
    country: "US",
    role: "carrier fighter",
    engine: "Pratt & Whitney R-2800 radial",
    powerHp: 2000,
    spanM: 13.06,
    lengthM: 10.24,
    wingAreaM2: 31,
    loadedMassKg: 5699,
    silhouette: "broad wing, barrel radial cowling, rugged deck stance",
  },
  {
    id: "a6m2",
    name: "Mitsubishi A6M2 Zero",
    era: "WW2",
    country: "Japan",
    role: "light carrier fighter",
    engine: "Nakajima Sakae radial",
    powerHp: 940,
    spanM: 12,
    lengthM: 9.06,
    wingAreaM2: 22.44,
    loadedMassKg: 2410,
    silhouette: "thin wing, light tail, narrow fuselage, rounded tips",
  },
  {
    id: "yak3",
    name: "Yakovlev Yak-3",
    era: "WW2",
    country: "USSR",
    role: "light tactical fighter",
    engine: "Klimov VK-105 inline",
    powerHp: 1300,
    spanM: 9.2,
    lengthM: 8.5,
    wingAreaM2: 14.85,
    loadedMassKg: 2692,
    silhouette: "short nose, small wing, compact tail, low frontal area",
  },
  {
    id: "la7",
    name: "Lavochkin La-7",
    era: "WW2",
    country: "USSR",
    role: "radial front-line fighter",
    engine: "Shvetsov ASh-82 radial",
    powerHp: 1850,
    spanM: 9.8,
    lengthM: 8.6,
    wingAreaM2: 17.59,
    loadedMassKg: 3265,
    silhouette: "short radial nose, broad shoulders, clean mid-wing mass",
  },
  {
    id: "p38l",
    name: "Lockheed P-38L Lightning",
    era: "WW2",
    country: "US",
    role: "twin-engine fighter",
    engine: "two Allison V-1710 inline engines",
    powerHp: 3200,
    spanM: 15.85,
    lengthM: 11.53,
    wingAreaM2: 30.43,
    loadedMassKg: 7940,
    silhouette: "twin booms, central pod, twin fins, high aspect wing",
  },
  {
    id: "mosquito-fbvi",
    name: "de Havilland Mosquito FB Mk VI",
    era: "WW2",
    country: "UK",
    role: "fast twin fighter-bomber",
    engine: "two Rolls-Royce Merlin inline engines",
    powerHp: 3420,
    spanM: 16.51,
    lengthM: 12.34,
    wingAreaM2: 42.18,
    loadedMassKg: 10152,
    silhouette: "clean wooden fuselage, twin nacelles, broad wing, framed canopy",
  },
  {
    id: "a1h",
    name: "Douglas AD-6 / A-1H Skyraider",
    era: "Korea / Vietnam",
    country: "US",
    role: "single-seat attack aircraft",
    engine: "Wright R-3350 radial",
    powerHp: 2700,
    spanM: 15.25,
    lengthM: 11.84,
    wingAreaM2: 37.19,
    loadedMassKg: 8179,
    silhouette: "huge straight wing, deep radial nose, many hardpoints, long tail",
  },
  {
    id: "sea-fury",
    name: "Hawker Sea Fury FB.11",
    era: "late WW2 / Korea",
    country: "UK",
    role: "naval fighter-bomber",
    engine: "Bristol Centaurus radial",
    powerHp: 2480,
    spanM: 11.7,
    lengthM: 10.57,
    wingAreaM2: 26,
    loadedMassKg: 5670,
    silhouette: "late-war power nose, clipped wing, carrier stance, bubble canopy",
  },
  {
    id: "f8f1",
    name: "Grumman F8F-1 Bearcat",
    era: "late WW2",
    country: "US",
    role: "light carrier interceptor",
    engine: "Pratt & Whitney R-2800 radial",
    powerHp: 2100,
    spanM: 10.92,
    lengthM: 8.61,
    wingAreaM2: 22.67,
    loadedMassKg: 4354,
    silhouette: "compact radial fighter, big prop, short body, bubble canopy",
  },
  {
    id: "t6g",
    name: "North American T-6G Texan",
    era: "WW2 / Korea",
    country: "US",
    role: "advanced trainer / light attack",
    engine: "Pratt & Whitney R-1340 radial",
    powerHp: 600,
    spanM: 12.81,
    lengthM: 8.84,
    wingAreaM2: 23.6,
    loadedMassKg: 2548,
    silhouette: "long greenhouse canopy, forgiving wing, modest radial nose",
  },
  {
    id: "f14d",
    name: "Grumman F-14D Super Tomcat",
    era: "Cold War",
    country: "US",
    role: "fleet-defense / air-superiority fighter",
    engine: "two General Electric F110-GE-400 afterburning turbofans",
    powerHp: 0,
    spanM: 19.55,
    lengthM: 19.1,
    wingAreaM2: 52.5,
    loadedMassKg: 28_700,
    silhouette: "long twin-engine body, variable-sweep wings, twin tails, tandem canopy",
  },
];

function dayTripperArchetype(): Airframe {
  const body = quatIdentity();
  const lengthM = 7.3;
  const spanM = 10.5;
  const wingAreaM2 = 14.7;
  const chordM = wingAreaM2 / spanM;
  const cockpitEye = vec3(0, 0.95, -1.05);
  const parts: Part[] = [
    {
      id: "fuselage",
      kind: "fuselage",
      pose: { offset: vec3(0, 0, 0), rotation: body },
      dims: { length: lengthM * 0.95, width: 0.95, height: 1.05 },
      massKg: 460,
    },
    {
      id: "main-wing",
      kind: "wing",
      pose: { offset: vec3(0, -0.06, 0.2), rotation: body },
      planform: { span: spanM, chord: chordM },
      massKg: 180,
      control: { axis: "roll", area: wingAreaM2 * 0.12 },
    },
    {
      id: "tailplane",
      kind: "wing",
      pose: { offset: vec3(0, 0.16, lengthM * 0.42), rotation: body },
      planform: { span: 2.8, chord: 0.7 },
      massKg: 55,
      control: { axis: "pitch", area: 1.1 },
    },
    {
      id: "fin",
      kind: "wing",
      pose: { offset: vec3(0, 0.55, lengthM * 0.38), rotation: body },
      planform: { span: 1.5, chord: 0.75 },
      massKg: 28,
      control: { axis: "yaw", area: 0.75 },
    },
    {
      id: "engine",
      kind: "engine",
      pose: { offset: vec3(0, 0.05, -1.1), rotation: body },
      thrustN: 10_000,
      idleThrustFraction: 0.08,
      massKg: 180,
      dims: { radius: 0.35, length: 1.1 },
    },
    {
      id: "canopy",
      kind: "canopy",
      pose: { offset: vec3(0, 0.78, -0.9), rotation: body },
      dims: { length: 1.6, width: 0.72, height: 0.55 },
      massKg: 45,
      style: "bubble",
    },
    {
      id: "tricycle-gear",
      kind: "gear",
      pose: { offset: vec3(0, -0.62, 0.1), rotation: body },
      trackM: 2.4,
      heightM: 0.78,
      wheelRadiusM: 0.22,
      massKg: 75,
      style: "tricycle",
    },
    {
      id: "fuel-cell",
      kind: "tank",
      pose: { offset: vec3(0, -0.05, -0.3), rotation: body },
      fuelKg: 60,
      dryMassKg: 12,
      dims: { radius: 0.32, length: 1.2 },
    },
    pilotStationAt(cockpitEye),
    cockpitAt(cockpitEye, Math.PI / 2.4),
  ];
  return { id: "day-tripper", parts };
}

export const aircraftArchetypes: AircraftArchetype[] = [
  {
    id: "variable-sweep-tomcat",
    name: "Super Tomcat",
    shortName: "Super Tomcat",
    role: "supersonic fleet interceptor",
    summary: "Twin afterburning turbofans, variable-sweep wing schedule, tandem cockpit, twin fins, and heavy fuel.",
    designLine: "F-14D thinking: a carrier fighter whose envelope is defined by F110 thrust, sweep, Mach drag, and high-altitude acceleration.",
    referenceIds: ["f14d"],
    palette: { base: "#8f989e", trim: "#d14438" },
    airframe: variableSweepTomcatArchetype(),
  },
  {
    id: "day-tripper",
    name: "Day Tripper",
    shortName: "Tripper",
    role: "civilian sightseeing aircraft",
    summary: "A tiny, friendly, slow-flying prop plane with a bubble canopy, no radar, and absolutely no weapons.",
    designLine: "Piper Cub / Cessna 172 spirit: low, slow, gentle, and completely unarmed.",
    referenceIds: ["cessna-172", "piper-cub"],
    palette: { base: "#f4c95d", trim: "#4aa3df" },
    airframe: dayTripperArchetype(),
  },
  {
    id: "inline-escort",
    name: "Long-Nose Escort",
    shortName: "Escort",
    role: "energy fighter",
    summary: "Fast inline fighter with long nose, clean low wing, strong pitch/roll balance, and a bubble cockpit.",
    designLine: "Start from the Mustang/Bf 109 family: speed, range, narrow frontal area, and readable elevator authority.",
    referenceIds: ["p51d", "bf109g"],
    palette: { base: "#5f8fa8", trim: "#f4d35e" },
    airframe: singleEngineArchetype({
      id: "inline-escort",
      reference: "p51d",
      engineType: "inline",
      spanM: 11.2,
      lengthM: 9.9,
      wingAreaM2: 21.8,
      loadedMassKg: 4300,
      powerHp: 1520,
      bodyWidthM: 1.05,
      bodyHeightM: 1.15,
      canopyStyle: "bubble",
      propBlades: 4,
      weaponRole: "machine-gun",
      weaponCount: 6,
      gearStyle: "taildragger",
      fuelFraction: 0.13,
      criticalAltitudeM: 7_600,
    }),
  },
  {
    id: "clipped-interceptor",
    name: "Clipped-Wing Interceptor",
    shortName: "Interceptor",
    role: "point defense",
    summary: "Short-span inline fighter tuned for snap roll, climb, and tight cockpit sightlines.",
    designLine: "Blend late Spitfire and Yak thinking: compact, light, and extremely legible control surfaces.",
    referenceIds: ["spitfire-lfix", "yak3", "la7"],
    palette: { base: "#7fa35b", trim: "#d7e8c4" },
    airframe: singleEngineArchetype({
      id: "clipped-interceptor",
      reference: "spitfire-lfix",
      engineType: "inline",
      spanM: 9.8,
      lengthM: 8.9,
      wingAreaM2: 18.2,
      loadedMassKg: 3400,
      powerHp: 1565,
      bodyWidthM: 0.95,
      bodyHeightM: 1.05,
      canopyStyle: "framed",
      propBlades: 4,
      weaponRole: "cannon",
      weaponCount: 4,
      gearStyle: "taildragger",
      fuelFraction: 0.1,
      controlBias: 1.15,
      criticalAltitudeM: 5_000,
    }),
  },
  {
    id: "radial-deck-fighter",
    name: "Radial Deck Fighter",
    shortName: "Deck Fighter",
    role: "carrier fighter-bomber",
    summary: "Big radial, broad wing, rugged stance, high drag tolerance, and strong stores capacity.",
    designLine: "Corsair/Hellcat/Bearcat language: chunky cowling, deck hardware, and hardpoint-ready wings.",
    referenceIds: ["f4u4", "f6f5", "f8f1"],
    palette: { base: "#345a79", trim: "#f0f2f2" },
    airframe: singleEngineArchetype({
      id: "radial-deck-fighter",
      reference: "f4u4",
      engineType: "radial",
      spanM: 12.4,
      lengthM: 10.3,
      wingAreaM2: 29.5,
      loadedMassKg: 5700,
      powerHp: 2450,
      bodyWidthM: 1.35,
      bodyHeightM: 1.35,
      canopyStyle: "bubble",
      propBlades: 4,
      weaponRole: "rocket-rail",
      weaponCount: 8,
      gearStyle: "taildragger",
      fuelFraction: 0.12,
      wingYOffsetM: -0.08,
      criticalAltitudeM: 7_500,
      propPitchRatio: 0.82,
      propRadiusM: 2.03,
    }),
  },
  {
    id: "light-turn-fighter",
    name: "Featherweight Turn Fighter",
    shortName: "Turn Fighter",
    role: "low-speed dogfighter",
    summary: "Low mass, generous wing, modest power, broad ailerons, and forgiving stall behavior.",
    designLine: "Use Zero/Yak proportions as a handling study: less armor, more wing, immediate visual honesty.",
    referenceIds: ["a6m2", "yak3"],
    palette: { base: "#c6c0a2", trim: "#b6423c" },
    airframe: singleEngineArchetype({
      id: "light-turn-fighter",
      reference: "a6m2",
      engineType: "radial",
      spanM: 11.9,
      lengthM: 9.0,
      wingAreaM2: 23.0,
      loadedMassKg: 2550,
      powerHp: 980,
      bodyWidthM: 0.9,
      bodyHeightM: 1.0,
      canopyStyle: "greenhouse",
      propBlades: 3,
      weaponRole: "cannon",
      weaponCount: 2,
      gearStyle: "taildragger",
      fuelFraction: 0.16,
      controlBias: 1.25,
      criticalAltitudeM: 3_000,
      propPitchRatio: 0.76,
    }),
  },
  {
    id: "twin-boom-pursuit",
    name: "Twin-Boom Pursuit",
    shortName: "Twin Boom",
    role: "heavy interceptor",
    summary: "Twin engines, central pilot pod, twin fins, high stability, and excellent forward visibility.",
    designLine: "P-38 as layout grammar: the pilot sits between engines and reads the airframe like a machine.",
    referenceIds: ["p38l"],
    palette: { base: "#8b8f88", trim: "#e25a45" },
    airframe: twinBoomArchetype(),
  },
  {
    id: "fast-wooden-twin",
    name: "Wooden Fast Twin",
    shortName: "Fast Twin",
    role: "fighter-bomber",
    summary: "Large clean twin with nacelles, broad wing, long greenhouse canopy, and heavy nose armament.",
    designLine: "Mosquito thinking: speed from clean surfaces and big engines rather than tiny fighter dimensions.",
    referenceIds: ["mosquito-fbvi"],
    palette: { base: "#6d8a67", trim: "#d2c49f" },
    airframe: twinNacelleArchetype(),
  },
  {
    id: "late-attack-brute",
    name: "Late Prop Attack Brute",
    shortName: "Attack",
    role: "ground attack",
    summary: "Huge wing, giant radial, long loiter fuel, visible racks, and deliberately heavy control feel.",
    designLine: "Skyraider/Sea Fury side of the era: late piston power, obvious stores, and carrier robustness.",
    referenceIds: ["a1h", "sea-fury"],
    palette: { base: "#4e665f", trim: "#f19953" },
    airframe: singleEngineArchetype({
      id: "late-attack-brute",
      reference: "a1h",
      engineType: "radial",
      spanM: 15.0,
      lengthM: 11.8,
      wingAreaM2: 37.5,
      loadedMassKg: 8200,
      powerHp: 2700,
      bodyWidthM: 1.5,
      bodyHeightM: 1.55,
      canopyStyle: "bubble",
      propBlades: 4,
      weaponRole: "bomb-rack",
      weaponCount: 10,
      gearStyle: "taildragger",
      fuelFraction: 0.18,
      controlBias: 0.85,
      wingYOffsetM: -0.12,
      criticalAltitudeM: 3_000,
    }),
  },
  {
    id: "trainer-mule",
    name: "Trainer Builder Mule",
    shortName: "Trainer",
    role: "custom testbed",
    summary: "Gentle radial trainer with readable greenhouse canopy and lots of room for custom experiments.",
    designLine: "T-6-style proportions: forgiving baseline, easy cockpit placement, and transparent builder feedback.",
    referenceIds: ["t6g"],
    palette: { base: "#d6a64f", trim: "#2d4858" },
    airframe: singleEngineArchetype({
      id: "trainer-mule",
      reference: "t6g",
      engineType: "radial",
      spanM: 12.8,
      lengthM: 8.8,
      wingAreaM2: 23.6,
      loadedMassKg: 2600,
      powerHp: 600,
      bodyWidthM: 1.05,
      bodyHeightM: 1.25,
      canopyStyle: "greenhouse",
      propBlades: 2,
      weaponRole: "machine-gun",
      weaponCount: 2,
      gearStyle: "taildragger",
      fuelFraction: 0.12,
      controlBias: 1.05,
      wingYOffsetM: -0.05,
      criticalAltitudeM: 1_200,
      propPitchRatio: 0.74,
    }),
  },
];

export function airframeFromArchetype(id: string): Airframe {
  const archetype = aircraftArchetypes.find((candidate) => candidate.id === id) ?? aircraftArchetypes[0];
  return structuredClone(archetype.airframe);
}

export function referencesForArchetype(archetype: AircraftArchetype): ReferenceAircraft[] {
  const ids = new Set(archetype.referenceIds);
  return referenceAircraft.filter((aircraft) => ids.has(aircraft.id));
}

interface SingleEngineOptions {
  id: string;
  reference: string;
  engineType: "inline" | "radial";
  spanM: number;
  lengthM: number;
  wingAreaM2: number;
  loadedMassKg: number;
  powerHp: number;
  bodyWidthM: number;
  bodyHeightM: number;
  canopyStyle: CanopyStyle;
  propBlades: number;
  weaponRole: WeaponRole;
  weaponCount: number;
  gearStyle: GearStyle;
  fuelFraction: number;
  controlBias?: number;
  wingYOffsetM?: number;
  criticalAltitudeM?: number;
  propPitchRatio?: number;
  propRadiusM?: number;
}

function singleEngineArchetype(opts: SingleEngineOptions): Airframe {
  const body = quatIdentity();
  const chordM = opts.wingAreaM2 / opts.spanM;
  const tailAreaM2 = opts.wingAreaM2 * 0.18;
  const tailSpanM = opts.spanM * 0.34;
  const tailChordM = tailAreaM2 / tailSpanM;
  const finAreaM2 = opts.wingAreaM2 * 0.08;
  const finSpanM = Math.max(1.45, opts.bodyHeightM * 1.45);
  const finChordM = finAreaM2 / finSpanM;
  const controlBias = opts.controlBias ?? 1;
  const fuelKg = Math.round(opts.loadedMassKg * opts.fuelFraction);
  const engineRadius = opts.engineType === "radial" ? opts.bodyWidthM * 0.53 : opts.bodyWidthM * 0.34;
  const engineLength = opts.engineType === "radial" ? opts.bodyWidthM * 1.15 : opts.lengthM * 0.22;
  const cockpitZ = -opts.lengthM * 0.1;
  const cockpitEye = vec3(0, opts.bodyHeightM * 0.62, cockpitZ + 0.15);
  const parts: Part[] = [
    {
      id: "fuselage",
      kind: "fuselage",
      pose: { offset: vec3(0, 0, 0), rotation: body },
      dims: { length: opts.lengthM, width: opts.bodyWidthM, height: opts.bodyHeightM },
      massKg: Math.round(opts.loadedMassKg * 0.36),
    },
    {
      id: "main-wing",
      kind: "wing",
      pose: { offset: vec3(0, opts.wingYOffsetM ?? 0, 0.15), rotation: body },
      planform: { span: opts.spanM, chord: chordM },
      massKg: Math.round(opts.loadedMassKg * 0.15),
      control: { axis: "roll", area: opts.wingAreaM2 * 0.13 * controlBias },
    },
    {
      id: "tailplane",
      kind: "wing",
      pose: { offset: vec3(0, opts.bodyHeightM * 0.18, opts.lengthM * 0.42), rotation: body },
      planform: { span: tailSpanM, chord: tailChordM },
      massKg: Math.round(opts.loadedMassKg * 0.035),
      control: { axis: "pitch", area: tailAreaM2 * 0.55 * controlBias },
    },
    {
      id: "fin",
      kind: "wing",
      pose: { offset: vec3(0, opts.bodyHeightM * 0.56, opts.lengthM * 0.39), rotation: body },
      planform: { span: finSpanM, chord: finChordM },
      massKg: Math.round(opts.loadedMassKg * 0.025),
      control: { axis: "yaw", area: finAreaM2 * 0.6 * controlBias },
    },
    {
      id: "engine",
      kind: "engine",
      pose: { offset: vec3(0, 0, -opts.lengthM * 0.43), rotation: body },
      thrustN: hpToThrustN(opts.powerHp),
      maxPowerW: hpToPowerW(opts.powerHp),
      criticalAltitudeM: opts.criticalAltitudeM ?? 0,
      idleRpm: opts.engineType === "radial" ? 620 : 700,
      maxRpm: opts.engineType === "radial" ? 2800 : 3000,
      massKg: Math.round(opts.loadedMassKg * 0.17),
      dims: { radius: engineRadius, length: engineLength },
    },
    {
      id: "prop",
      kind: "prop",
      pose: { offset: vec3(0, 0, -opts.lengthM * 0.55), rotation: body },
      radius: opts.propRadiusM ?? Math.max(1.55, opts.spanM * 0.14),
      pitchM:
        Math.max(1.85, (opts.propRadiusM ?? Math.max(1.55, opts.spanM * 0.14)) * 2 * (opts.propPitchRatio ?? (opts.engineType === "radial" ? 0.68 : 0.76))),
      bladeCount: opts.propBlades,
      mode: opts.engineType === "radial" && opts.powerHp < 1100 ? "fixed-pitch" : "constant-speed",
      massKg: Math.round(opts.loadedMassKg * 0.018),
    },
    {
      id: "canopy",
      kind: "canopy",
      pose: { offset: vec3(0, opts.bodyHeightM * 0.52, cockpitZ), rotation: body },
      dims: {
        length: opts.canopyStyle === "greenhouse" ? opts.lengthM * 0.34 : opts.lengthM * 0.22,
        width: opts.bodyWidthM * 0.72,
        height: opts.bodyHeightM * 0.52,
      },
      massKg: Math.round(opts.loadedMassKg * 0.014),
      style: opts.canopyStyle,
    },
    {
      id: "main-gear",
      kind: "gear",
      pose: { offset: vec3(0, -opts.bodyHeightM * 0.58, opts.lengthM * 0.03), rotation: body },
      trackM: opts.spanM * 0.28,
      heightM: opts.bodyHeightM * 0.75,
      wheelRadiusM: opts.bodyHeightM * 0.18,
      massKg: Math.round(opts.loadedMassKg * 0.035),
      style: opts.gearStyle,
    },
    {
      id: "armament",
      kind: "weapon",
      pose: { offset: vec3(0, -opts.bodyHeightM * 0.18, -opts.lengthM * 0.02), rotation: body },
      count: opts.weaponCount,
      caliberMm: opts.weaponRole === "machine-gun" ? 12.7 : opts.weaponRole === "cannon" ? 20 : 76,
      massKg: Math.round(opts.loadedMassKg * (opts.weaponRole === "bomb-rack" ? 0.08 : 0.04)),
      dims: {
        length: opts.weaponRole === "bomb-rack" ? 1.4 : 1.1,
        width: opts.weaponRole === "bomb-rack" ? 0.14 : 0.06,
        height: opts.weaponRole === "bomb-rack" ? 0.18 : 0.06,
      },
      role: opts.weaponRole,
    },
    {
      id: "fuel-cell",
      kind: "tank",
      pose: { offset: vec3(0, -opts.bodyHeightM * 0.08, 0.2), rotation: body },
      fuelKg,
      dryMassKg: Math.round(opts.loadedMassKg * 0.012),
      dims: { radius: opts.bodyWidthM * 0.28, length: opts.lengthM * 0.24 },
    },
    pilotStationAt(cockpitEye),
    cockpitAt(cockpitEye, Math.PI / 2.75),
    noseAt(vec3(0, 0.05, -opts.lengthM * 0.58)),
  ];
  return { id: opts.id, parts };
}

function twinBoomArchetype(): Airframe {
  const body = quatIdentity();
  const lengthM = 11.5;
  const spanM = 15.8;
  const loadedMassKg = 7900;
  const wingAreaM2 = 30.5;
  const chordM = wingAreaM2 / spanM;
  const engineX = 2.25;
  const cockpitEye = vec3(0, 0.86, -0.85);
  const parts: Part[] = [
    {
      id: "center-pod",
      kind: "fuselage",
      pose: { offset: vec3(0, 0, -0.25), rotation: body },
      dims: { length: 6.9, width: 0.95, height: 1.25 },
      massKg: 1450,
    },
    {
      id: "boom-left",
      kind: "fuselage",
      pose: { offset: vec3(-engineX, 0.03, 0.35), rotation: body },
      dims: { length: 9.5, width: 0.55, height: 0.62 },
      massKg: 760,
    },
    {
      id: "boom-right",
      kind: "fuselage",
      pose: { offset: vec3(engineX, 0.03, 0.35), rotation: body },
      dims: { length: 9.5, width: 0.55, height: 0.62 },
      massKg: 760,
    },
    {
      id: "main-wing",
      kind: "wing",
      pose: { offset: vec3(0, -0.04, 0.1), rotation: body },
      planform: { span: spanM, chord: chordM },
      massKg: 1120,
      control: { axis: "roll", area: wingAreaM2 * 0.12 },
    },
    {
      id: "tailplane",
      kind: "wing",
      pose: { offset: vec3(0, 0.36, lengthM * 0.42), rotation: body },
      planform: { span: engineX * 2.35, chord: 0.82 },
      massKg: 320,
      control: { axis: "pitch", area: 2.4 },
    },
    {
      id: "fin-left",
      kind: "wing",
      pose: { offset: vec3(-engineX, 0.68, lengthM * 0.4), rotation: body },
      planform: { span: 1.75, chord: 0.95 },
      massKg: 145,
      control: { axis: "yaw", area: 0.85 },
    },
    {
      id: "fin-right",
      kind: "wing",
      pose: { offset: vec3(engineX, 0.68, lengthM * 0.4), rotation: body },
      planform: { span: 1.75, chord: 0.95 },
      massKg: 145,
      control: { axis: "yaw", area: 0.85 },
    },
    ...twinEngines(engineX, -lengthM * 0.34, 1500, 950, 0.48, 1.9, 1.65, 3, 7_000),
    {
      id: "canopy",
      kind: "canopy",
      pose: { offset: vec3(0, 0.72, -1.0), rotation: body },
      dims: { length: 1.9, width: 0.72, height: 0.55 },
      massKg: 85,
      style: "bubble",
    },
    {
      id: "main-gear",
      kind: "gear",
      pose: { offset: vec3(0, -0.76, 0.2), rotation: body },
      trackM: engineX * 2,
      heightM: 0.78,
      wheelRadiusM: 0.25,
      massKg: 275,
      style: "tricycle",
    },
    {
      id: "nose-guns",
      kind: "weapon",
      pose: { offset: vec3(0, -0.05, -2.75), rotation: body },
      count: 5,
      caliberMm: 20,
      massKg: 230,
      dims: { length: 1.35, width: 0.07, height: 0.07 },
      role: "cannon",
    },
    {
      id: "fuel-cells",
      kind: "tank",
      pose: { offset: vec3(0, -0.12, 0.35), rotation: body },
      fuelKg: 880,
      dryMassKg: 95,
      dims: { radius: 0.45, length: 2.2 },
    },
    pilotStationAt(cockpitEye),
    cockpitAt(cockpitEye, Math.PI / 2.65),
    noseAt(vec3(0, 0.02, -3.8)),
  ];
  return { id: "twin-boom-pursuit", parts };
}

function twinNacelleArchetype(): Airframe {
  const body = quatIdentity();
  const lengthM = 12.3;
  const spanM = 16.5;
  const wingAreaM2 = 42.2;
  const chordM = wingAreaM2 / spanM;
  const engineX = 2.65;
  const cockpitEye = vec3(0, 0.93, -1.65);
  const parts: Part[] = [
    {
      id: "fuselage",
      kind: "fuselage",
      pose: { offset: vec3(0, 0, 0), rotation: body },
      dims: { length: lengthM, width: 1.15, height: 1.35 },
      massKg: 3000,
    },
    {
      id: "nacelle-left",
      kind: "fuselage",
      pose: { offset: vec3(-engineX, -0.02, -0.65), rotation: body },
      dims: { length: 4.9, width: 0.72, height: 0.82 },
      massKg: 470,
    },
    {
      id: "nacelle-right",
      kind: "fuselage",
      pose: { offset: vec3(engineX, -0.02, -0.65), rotation: body },
      dims: { length: 4.9, width: 0.72, height: 0.82 },
      massKg: 470,
    },
    {
      id: "main-wing",
      kind: "wing",
      pose: { offset: vec3(0, -0.02, 0.1), rotation: body },
      planform: { span: spanM, chord: chordM },
      massKg: 1520,
      control: { axis: "roll", area: wingAreaM2 * 0.1 },
    },
    {
      id: "tailplane",
      kind: "wing",
      pose: { offset: vec3(0, 0.32, lengthM * 0.42), rotation: body },
      planform: { span: 5.4, chord: 1.0 },
      massKg: 430,
      control: { axis: "pitch", area: 2.8 },
    },
    {
      id: "fin",
      kind: "wing",
      pose: { offset: vec3(0, 0.78, lengthM * 0.4), rotation: body },
      planform: { span: 2.05, chord: 1.1 },
      massKg: 225,
      control: { axis: "yaw", area: 1.25 },
    },
    ...twinEngines(engineX, -lengthM * 0.28, 1710, 870, 0.45, 2.1, 1.55, 3, 7_500),
    {
      id: "canopy",
      kind: "canopy",
      pose: { offset: vec3(0, 0.78, -1.8), rotation: body },
      dims: { length: 3.1, width: 0.82, height: 0.58 },
      massKg: 135,
      style: "greenhouse",
    },
    {
      id: "main-gear",
      kind: "gear",
      pose: { offset: vec3(0, -0.78, -0.15), rotation: body },
      trackM: engineX * 2,
      heightM: 0.85,
      wheelRadiusM: 0.27,
      massKg: 370,
      style: "taildragger",
    },
    {
      id: "nose-cannons",
      kind: "weapon",
      pose: { offset: vec3(0, -0.16, -3.6), rotation: body },
      count: 4,
      caliberMm: 20,
      massKg: 320,
      dims: { length: 1.35, width: 0.08, height: 0.08 },
      role: "cannon",
    },
    {
      id: "fuel-cells",
      kind: "tank",
      pose: { offset: vec3(0, -0.12, 0.2), rotation: body },
      fuelKg: 1280,
      dryMassKg: 155,
      dims: { radius: 0.52, length: 2.6 },
    },
    pilotStationAt(cockpitEye),
    cockpitAt(cockpitEye, Math.PI / 2.7),
    noseAt(vec3(0, 0.05, -5.5)),
  ];
  return { id: "fast-wooden-twin", parts };
}

function twinEngines(
  x: number,
  z: number,
  hpEach: number,
  massEach: number,
  radius: number,
  length: number,
  propRadius: number,
  bladeCount: number,
  criticalAltitudeM = 0,
  propPitchRatio = 0.74,
): Part[] {
  const body = quatIdentity();
  return [
    {
      id: "engine-left",
      kind: "engine",
      pose: { offset: vec3(-x, 0, z), rotation: body },
      thrustN: hpToThrustN(hpEach),
      maxPowerW: hpToPowerW(hpEach),
      criticalAltitudeM,
      idleRpm: 680,
      maxRpm: 3000,
      massKg: massEach,
      dims: { radius, length },
    },
    {
      id: "engine-right",
      kind: "engine",
      pose: { offset: vec3(x, 0, z), rotation: body },
      thrustN: hpToThrustN(hpEach),
      maxPowerW: hpToPowerW(hpEach),
      criticalAltitudeM,
      idleRpm: 680,
      maxRpm: 3000,
      massKg: massEach,
      dims: { radius, length },
    },
    {
      id: "prop-left",
      kind: "prop",
      pose: { offset: vec3(-x, 0, z - length * 0.62), rotation: body },
      radius: propRadius,
      pitchM: Math.max(1.9, propRadius * 2 * propPitchRatio),
      bladeCount,
      mode: "constant-speed",
      massKg: 105,
    },
    {
      id: "prop-right",
      kind: "prop",
      pose: { offset: vec3(x, 0, z - length * 0.62), rotation: body },
      radius: propRadius,
      pitchM: Math.max(1.9, propRadius * 2 * propPitchRatio),
      bladeCount,
      mode: "constant-speed",
      massKg: 105,
    },
  ];
}

function variableSweepTomcatArchetype(): Airframe {
  const body = quatIdentity();
  const lengthM = 19.1;
  const spanM = 19.55;
  const wingAreaM2 = 45.0;
  const chordM = wingAreaM2 / spanM;
  const engineX = 1.55;
  const cockpitEye = vec3(0, 1.34, -4.15);
  const dryThrustN = lbfToN(16_333);
  const afterburnerThrustN = lbfToN(27_600);
  const finCantRad = (10 * Math.PI) / 180;
  const wingSweep = {
    minSweepDeg: 20,
    maxSweepDeg: 68,
    machForward: 0.42,
    machSwept: 1.35,
  };
  const parts: Part[] = [
    {
      id: "nose-radome",
      kind: "fuselage",
      pose: { offset: vec3(0, 0.02, -7.6), rotation: body },
      dims: { length: 3.4, width: 0.88, height: 0.82 },
      massKg: 800,
    },
    {
      id: "forward-fuselage",
      kind: "fuselage",
      pose: { offset: vec3(0, 0.04, -4.7), rotation: body },
      dims: { length: 5.1, width: 1.55, height: 1.55 },
      massKg: 3_200,
    },
    {
      id: "wing-glove-body",
      kind: "fuselage",
      pose: { offset: vec3(0, -0.02, -0.9), rotation: body },
      dims: { length: 5.4, width: 3.15, height: 0.92 },
      massKg: 3_600,
    },
    {
      id: "aft-fuselage",
      kind: "fuselage",
      pose: { offset: vec3(0, -0.06, 3.2), rotation: body },
      dims: { length: 6.4, width: 3.1, height: 1.55 },
      massKg: 1_900,
    },
    {
      id: "beaver-tail",
      kind: "fuselage",
      pose: { offset: vec3(0, -0.1, 6.65), rotation: body },
      dims: { length: 2.4, width: 1.2, height: 0.65 },
      massKg: 350,
    },
    {
      id: "intake-left",
      kind: "fuselage",
      pose: { offset: vec3(-engineX, -0.12, 1.15), rotation: body },
      dims: { length: 6.8, width: 0.88, height: 1.18 },
      massKg: 1_250,
    },
    {
      id: "intake-right",
      kind: "fuselage",
      pose: { offset: vec3(engineX, -0.12, 1.15), rotation: body },
      dims: { length: 6.8, width: 0.88, height: 1.18 },
      massKg: 1_250,
    },
    {
      id: "variable-sweep-wing",
      kind: "wing",
      pose: { offset: vec3(0, -0.08, 0.15), rotation: body },
      planform: { span: spanM, chord: chordM },
      massKg: 2_400,
      control: { axis: "roll", area: wingAreaM2 * 0.08 },
      sweep: wingSweep,
    },
    {
      id: "tailerons",
      kind: "wing",
      pose: { offset: vec3(0, 0.18, lengthM * 0.43), rotation: body },
      planform: { span: 6.9, chord: 0.82 },
      massKg: 760,
      control: { axis: "pitch", area: 4.8 },
    },
    {
      id: "fin-left",
      kind: "wing",
      pose: { offset: vec3(-1.85, 0.92, lengthM * 0.36), rotation: quatFromAxisAngle(vec3(0, 0, 1), finCantRad) },
      planform: { span: 2.6, chord: 1.15 },
      massKg: 500,
      control: { axis: "yaw", area: 1.5 },
    },
    {
      id: "fin-right",
      kind: "wing",
      pose: { offset: vec3(1.85, 0.92, lengthM * 0.36), rotation: quatFromAxisAngle(vec3(0, 0, 1), -finCantRad) },
      planform: { span: 2.6, chord: 1.15 },
      massKg: 500,
      control: { axis: "yaw", area: 1.5 },
    },
    {
      id: "engine-left",
      kind: "engine",
      pose: { offset: vec3(-engineX, -0.12, lengthM * 0.28), rotation: body },
      thrustN: dryThrustN,
      afterburnerThrustN,
      idleThrustFraction: 0.055,
      afterburnerThrottle: 0.82,
      massKg: 1_770,
      dims: { radius: 0.62, length: 4.55 },
    },
    {
      id: "engine-right",
      kind: "engine",
      pose: { offset: vec3(engineX, -0.12, lengthM * 0.28), rotation: body },
      thrustN: dryThrustN,
      afterburnerThrustN,
      idleThrustFraction: 0.055,
      afterburnerThrottle: 0.82,
      massKg: 1_770,
      dims: { radius: 0.62, length: 4.55 },
    },
    {
      id: "canopy",
      kind: "canopy",
      pose: { offset: vec3(0, 1.12, -4.25), rotation: body },
      dims: { length: 3.9, width: 0.95, height: 0.62 },
      massKg: 420,
      style: "framed",
    },
    {
      id: "carrier-gear",
      kind: "gear",
      pose: { offset: vec3(0, -1.04, -0.2), rotation: body },
      trackM: 5.3,
      heightM: 1.15,
      wheelRadiusM: 0.34,
      massKg: 1_550,
      style: "tricycle",
    },
    {
      id: "m61-and-missiles",
      kind: "weapon",
      pose: { offset: vec3(0, -0.45, -0.7), rotation: body },
      count: 8,
      caliberMm: 20,
      massKg: 1_250,
      dims: { length: 3.95, width: 0.22, height: 0.22 },
      role: "rocket-rail",
      weaponType: "missile",
      guidance: "heat-seeking",
    },
    {
      id: "internal-fuel",
      kind: "tank",
      pose: { offset: vec3(0, -0.28, 0.35), rotation: body },
      fuelKg: 7_200,
      dryMassKg: 480,
      dims: { radius: 0.92, length: 6.4 },
    },
    pilotStationAt(cockpitEye),
    cockpitAt(cockpitEye, Math.PI / 2.55),
    noseAt(vec3(0, 0.15, -lengthM * 0.55)),
    radarAt(vec3(0, 0.15, -7.6)),
  ];
  return { id: "variable-sweep-tomcat", parts };
}

function cockpitAt(offset: ReturnType<typeof vec3>, hFovRad: number): Part {
  return {
    ...cockpitCamera(),
    pose: { offset, rotation: quatIdentity() },
    optics: { hFovRad, aspect: 1.6 },
  };
}

function pilotStationAt(eye: ReturnType<typeof vec3>, canopyId = "canopy"): Part {
  const hip = vec3(eye.x, eye.y - 0.456, eye.z - 0.15);
  return {
    id: "pilot-station",
    kind: "crew-station",
    role: "pilot",
    pose: { offset: vec3(0, 0, 0), rotation: quatIdentity() },
    canopyId,
    seat: {
      hip,
      back: vec3(hip.x, hip.y + 0.426, hip.z + 0.23),
      eye,
    },
    controls: {
      stick: vec3(hip.x + 0.12, hip.y - 0.224, hip.z - 0.6),
      throttle: vec3(hip.x - 0.24, hip.y - 0.224, hip.z - 0.45),
      leftPedal: vec3(hip.x - 0.22, hip.y - 0.104, hip.z - 0.99),
      rightPedal: vec3(hip.x + 0.22, hip.y - 0.104, hip.z - 0.99),
      panel: vec3(hip.x, hip.y + 0.106, hip.z - 0.7),
    },
  };
}

function noseAt(offset: ReturnType<typeof vec3>): Part {
  return {
    ...noseCamera(),
    pose: { offset, rotation: quatIdentity() },
  };
}

function radarAt(offset: ReturnType<typeof vec3>): Part {
  return {
    ...noseRadar(),
    pose: { offset, rotation: quatIdentity() },
  };
}

function hpToThrustN(powerHp: number): number {
  // The sim uses thrust points rather than propeller curves. This conversion keeps the stock plane's
  // thrust scale while letting historical horsepower shape relative archetype power.
  return Math.round(powerHp * 46);
}

function hpToPowerW(powerHp: number): number {
  return Math.round(powerHp * 745.7);
}

function lbfToN(lbf: number): number {
  return Math.round(lbf * 4.4482216153);
}
