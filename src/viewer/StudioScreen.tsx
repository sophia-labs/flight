import { OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import {
  BadgeCheck,
  Bot,
  Camera,
  Captions,
  Clock3,
  Film,
  Gauge,
  MessageCircle,
  Orbit,
  Pause,
  Plane,
  Play,
  RotateCcw,
  SendHorizontal,
  SlidersHorizontal,
  StepBack,
  StepForward,
  UserRound,
  Volume2,
  Wrench,
  Zap,
} from "lucide-react";
import { useMemo, useState, type ComponentType } from "react";
import type { AgentPhaseTrace, AircraftSnapshot, MatchReplay, ReplayFrame } from "../protocol/schema";
import { activeAgentPhase, countAgentPhases } from "../replay/agentPhases";
import { airframeReport, compileAirframe } from "../sim/airframe";
import { aircraftArchetypes, type AircraftArchetype } from "../sim/aircraftCatalog";
import { buildPerformanceEnvelope } from "../sim/performanceEnvelope";
import {
  performancePresentation,
  type PerformancePresentation,
} from "../studio/performancePresentation";
import {
  DIRECT_DEEPSEEK_PLANNER_MODEL,
  DIRECT_DEEPSEEK_TWITCH_MODEL,
} from "../studio/schema";
import type {
  AircraftBuild,
  PilotProfile,
  StudioMode,
  StudioProject,
  StudioScenarioConfig,
  StudioSession,
} from "../studio/schema";
import { normalizeVrmWearableIds, VRM_WEARABLE_CATALOG, type VrmWearableId } from "../studio/vrmWearables";
import { BodyPanel } from "./BodyPanel";
import { ControlsPanel } from "./ControlsPanel";
import { FlightScene, type CameraMode } from "./FlightScene";
import { PartMeshes } from "./airframeMesh";
import { MatchStats } from "./MatchStats";
import { LoadoutPilotAvatar, PilotAvatar } from "./PilotAvatar";
import { PilotStationDebug } from "./PilotStationDebug";
import {
  computeCockpitFitDiagnostics,
  computeCockpitRig,
  neutralControls,
  type CanopyEnvelope,
} from "./pilotRig";
import { StatusPanel } from "./StatusPanel";
import { SurfaceHud } from "./SurfaceHud";
import { Timeline } from "./Timeline";
import { TranscriptPanel } from "./TranscriptPanel";
import type { PlaybackClock } from "./usePlayback";

interface PlaybackControls {
  clock: PlaybackClock;
  frameCount: number;
  frameIndex: number;
  next: () => void;
  playing: boolean;
  previous: () => void;
  reportIndex: (index: number) => void;
  reportSample: (position: number) => void;
  restart: () => void;
  setFrameIndex: (index: number) => void;
  setPosition: (position: number, playing?: boolean) => void;
  toggle: () => void;
}

interface ScenarioProgress {
  label: string;
  percent: number;
  turn?: number;
  maxTurns?: number;
  actionKind?: string;
  agentLabel?: string;
  rationale?: string;
}

export function StudioScreen({
  activeAircraft,
  activeArchetype,
  activePilot,
  activeScenario,
  activeSession,
  cameraMode,
  caption,
  captionsOn,
  frame,
  hudOn,
  launching,
  mode,
  onCameraModeChange,
  onCaptionsChange,
  onHudChange,
  onLaunch,
  onModeChange,
  onOpenBuilder,
  onSelectAircraft,
  onSoundChange,
  onUpdateScenario,
  onUpdatePilot,
  onVoiceChange,
  pilotId,
  playback,
  project,
  replay,
  scenarioError,
  scenarioProgress,
  soundOn,
  voiceOn,
}: {
  activeAircraft: AircraftBuild;
  activeArchetype?: AircraftArchetype;
  activePilot: PilotProfile;
  activeScenario: StudioScenarioConfig;
  activeSession: StudioSession;
  cameraMode: CameraMode;
  caption?: string;
  captionsOn: boolean;
  frame?: ReplayFrame;
  hudOn: boolean;
  launching: boolean;
  mode: StudioMode;
  onCameraModeChange: (mode: CameraMode) => void;
  onCaptionsChange: (enabled: boolean) => void;
  onHudChange: (enabled: boolean) => void;
  onLaunch: () => void;
  onModeChange: (mode: StudioMode) => void;
  onOpenBuilder: () => void;
  onSelectAircraft: (aircraftBuildId: string) => void;
  onSoundChange: (enabled: boolean) => void;
  onUpdateScenario: (update: (scenario: StudioScenarioConfig) => StudioScenarioConfig) => void;
  onUpdatePilot: (pilotProfileId: string, update: (pilot: PilotProfile) => PilotProfile) => void;
  onVoiceChange: (enabled: boolean) => void;
  pilotId: string;
  playback: PlaybackControls;
  project: StudioProject;
  replay: MatchReplay | null;
  scenarioError: string | null;
  scenarioProgress: ScenarioProgress | null;
  soundOn: boolean;
  voiceOn: boolean;
}) {
  const compiled = useMemo(() => compileAirframe(activeAircraft.airframe), [activeAircraft.airframe]);
  const report = useMemo(() => airframeReport(compiled.model), [compiled.model]);
  const envelope = useMemo(
    () =>
      buildPerformanceEnvelope(compiled.model, {
        aircraftId: activeAircraft.sourceArchetypeId ?? activeAircraft.id,
        aircraftName: activeAircraft.name,
        role: activeArchetype?.role,
      }),
    [activeAircraft.id, activeAircraft.name, activeAircraft.sourceArchetypeId, activeArchetype?.role, compiled.model],
  );
  const performance = useMemo(() => performancePresentation(envelope), [envelope]);
  const fit = useMemo(
    () => summarizeFit(activeAircraft, activePilot.id),
    [activeAircraft, activePilot.id],
  );
  const showFlight = Boolean((mode === "flight" || mode === "replay") && replay && frame);
  const activePhase = useMemo(
    () => (replay && frame ? activeAgentPhase(replay, pilotId, frame.time) : undefined),
    [frame, pilotId, replay],
  );
  const palette = activeArchetype?.palette ?? { base: "#4da3ff", trim: "#f2c94c" };
  const activeLoadout = defaultLoadout(activePilot);
  const stageTitle = mode === "crew" ? activeLoadout.callsign : activeAircraft.name;

  return (
    <main className="studio-shell">
      <nav className="studio-mode-rail" aria-label="Studio modes">
        <div className="studio-mark">
          <Plane size={23} />
        </div>
        {MODE_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.mode}
              type="button"
              className={`studio-mode-button${mode === item.mode ? " active" : ""}`}
              aria-pressed={mode === item.mode}
              onClick={() => onModeChange(item.mode)}
              title={item.label}
            >
              <Icon size={20} />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      <section className="studio-stage" aria-label="Studio stage">
        <Canvas
          camera={{
            position: mode === "crew" ? [0, 1.18, 3.05] : [2.45, 1.45, 3.15],
            fov: showFlight ? 54 : mode === "crew" ? 34 : 38,
            near: 0.01,
            far: 1200,
          }}
          shadows
          gl={{ antialias: true, preserveDrawingBuffer: true }}
          data-testid="flight-canvas"
        >
          {showFlight && replay && frame ? (
            <FlightScene
              frame={frame}
              replay={replay}
              cameraMode={cameraMode}
              pilotId={pilotId}
              clock={playback.clock}
              onIndex={playback.reportIndex}
              onSample={playback.reportSample}
              pilotProfile={activePilot}
            />
          ) : mode === "crew" ? (
            <PilotLoadoutScene pilot={activePilot} />
          ) : (
            <StudioHangarScene
              aircraft={activeAircraft}
              color={palette.base}
              accentColor={palette.trim}
              pilot={activePilot}
              showCrew={mode === "debug"}
            />
          )}
        </Canvas>

        <div className="studio-stage-label">
          <span>{mode}</span>
          <strong>{stageTitle}</strong>
          <span>{fit.stationLabel}</span>
        </div>

        {showFlight && captionsOn && caption ? (
          <div className="subtitle" key={caption}>
            <span className="subtitle-speaker">Pilot</span>
            {caption}
          </div>
        ) : null}

        {showFlight && replay && frame ? (
          <SurfaceHud frame={frame} replay={replay} pilotId={pilotId} visible={cameraMode === "cabin" && hudOn} />
        ) : null}

        {showFlight && frame ? <AgentPhaseBadge phase={activePhase} time={frame.time} /> : null}
      </section>

      <aside className="studio-panel" aria-label="VTuber Flight Studio">
        <header className="studio-panel-header">
          <div>
            <p className="eyebrow">VTuber Flight Studio</p>
            <h1>{activeAircraft.name}</h1>
          </div>
          <button
            type="button"
            className="studio-primary-button"
            onClick={onLaunch}
            disabled={launching}
          >
            <Play size={16} />
            {launching ? "Running" : mode === "scenario" ? "Run" : "Launch"}
          </button>
        </header>

        {mode === "crew" ? (
          <CrewLoadoutPanel
            activeAircraft={activeAircraft}
            activePilot={activePilot}
            fit={fit}
            onUpdatePilot={onUpdatePilot}
          />
        ) : mode === "scenario" ? (
          <ScenarioPanel
            activeAircraft={activeAircraft}
            activeScenario={activeScenario}
            launching={launching}
            onLaunch={onLaunch}
            onOpenBuilder={onOpenBuilder}
            onSelectAircraft={onSelectAircraft}
            onUpdateScenario={onUpdateScenario}
            palette={palette}
            project={project}
            error={scenarioError}
            progress={scenarioProgress}
          />
        ) : (
          <>
            <AircraftSelectorPanel
              activeAircraft={activeAircraft}
              onOpenBuilder={onOpenBuilder}
              onSelectAircraft={onSelectAircraft}
              palette={palette}
              project={project}
            />

            <section className="studio-section studio-stat-strip" aria-label="Aircraft stats">
              <StudioStat label="mass" value={`${Math.round(compiled.model.massKg)} kg`} />
              <StudioStat label="thrust" value={`${(compiled.model.maxThrustN / 1000).toFixed(0)} kN`} />
              <StudioStat label="wing" value={`${compiled.model.wingAreaM2.toFixed(1)} m2`} />
              <StudioStat label="T:W" value={report.thrustToWeight.toFixed(2)} />
            </section>

            <PerformanceEnvelopePanel performance={performance} />
            <PilotFitPanel activePilot={activePilot} fit={fit} />
          </>
        )}

        {mode === "flight" || mode === "replay" ? (
          <ReplayPanel
            cameraMode={cameraMode}
            frame={frame}
            hudOn={hudOn}
            captionsOn={captionsOn}
            onCameraModeChange={onCameraModeChange}
            onCaptionsChange={onCaptionsChange}
            onHudChange={onHudChange}
            onSoundChange={onSoundChange}
            onVoiceChange={onVoiceChange}
            playback={playback}
            pilotId={pilotId}
            replay={replay}
            activePhase={activePhase}
            soundOn={soundOn}
            voiceOn={voiceOn}
          />
        ) : null}

        {mode === "debug" ? (
          <section className="studio-section studio-debug">
            <div className="studio-section-title">
              <span>Debug</span>
            </div>
            <code>project={project.id}</code>
            <code>session={activeSession.id}</code>
            <code>aircraft={activeAircraft.id}</code>
            <code>station={fit.stationLabel}</code>
          </section>
        ) : null}
      </aside>
    </main>
  );
}

function StudioHangarScene({
  accentColor,
  aircraft,
  color,
  pilot,
  showCrew,
}: {
  accentColor: string;
  aircraft: AircraftBuild;
  color: string;
  pilot: PilotProfile;
  showCrew: boolean;
}) {
  const cockpit = computeCockpitRig(neutralControls(), aircraft.airframe.parts);
  const previewShip = useMemo(() => previewPilotShip(aircraft, color), [aircraft, color]);
  return (
    <>
      <color attach="background" args={["#0a1012"]} />
      <hemisphereLight args={["#d7f3ff", "#29311e", 1.15]} />
      <ambientLight intensity={0.34} />
      <directionalLight position={[4, 6, 3]} intensity={2.5} castShadow />
      <directionalLight position={[-3, 2, -4]} intensity={0.72} />
      <StudioFloor />
      <group scale={2.22} position={[0, -0.08, 0]} rotation={[0.02, -0.38, 0]}>
        <PartMeshes
          parts={aircraft.airframe.parts}
          color={color}
          accentColor={accentColor}
          stalled={false}
          propSpin={0.2}
        />
        {showCrew ? <PilotStationDebug parts={aircraft.airframe.parts} pointScale={1.7} /> : null}
        {showCrew ? <PilotAvatar parts={aircraft.airframe.parts} profile={pilot} ship={previewShip} /> : null}
        <StationHotspot position={cockpit.station.seatHip} active={showCrew} />
      </group>
      <OrbitControls enableDamping dampingFactor={0.1} target={showCrew ? [0, 0.18, -0.72] : [0, 0, 0]} />
    </>
  );
}

function PilotLoadoutScene({ pilot }: { pilot: PilotProfile }) {
  const appearance = defaultAppearance(pilot);
  return (
    <>
      <color attach="background" args={["#0b1012"]} />
      <fog attach="fog" args={["#0b1012", 4.4, 9.5]} />
      <hemisphereLight args={["#d9f4ff", "#171b14", 1.05]} />
      <ambientLight intensity={0.28} />
      <directionalLight position={[2.8, 4.6, 2.4]} intensity={2.6} castShadow />
      <directionalLight position={[-2.4, 2.2, -2.8]} intensity={0.85} color={appearance.accentTint} />
      <spotLight position={[0, 2.8, 2.2]} angle={0.45} penumbra={0.6} intensity={3.2} color="#eef8ff" castShadow />
      <LoadoutDeck accent={appearance.accentTint} outfit={appearance.outfitTint} />
      <group position={[0, 0.02, 0]}>
        <LoadoutPilotAvatar profile={pilot} />
      </group>
      <OrbitControls enableDamping dampingFactor={0.1} target={[0, 0.86, 0]} />
    </>
  );
}

function LoadoutDeck({ accent, outfit }: { accent: string; outfit: string }) {
  return (
    <group>
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.015, 0]}>
        <circleGeometry args={[1.18, 72]} />
        <meshStandardMaterial color="#111a1d" roughness={0.72} metalness={0.18} />
      </mesh>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.004, 0]}>
        <torusGeometry args={[1.18, 0.012, 10, 96]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.35} roughness={0.35} />
      </mesh>
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.025, 0]}>
        <planeGeometry args={[5.8, 4.4]} />
        <meshStandardMaterial color="#0f1719" roughness={0.78} metalness={0.04} />
      </mesh>
      <gridHelper args={[5, 14, "#33484d", "#1b292c"]} position={[0, -0.012, 0]} />
      <mesh position={[-1.45, 0.22, -0.46]} castShadow>
        <boxGeometry args={[0.44, 0.44, 0.36]} />
        <meshStandardMaterial color="#1c2b31" roughness={0.58} metalness={0.16} />
      </mesh>
      <mesh position={[-1.45, 0.48, -0.46]} castShadow>
        <boxGeometry args={[0.5, 0.08, 0.4]} />
        <meshStandardMaterial color={accent} roughness={0.46} metalness={0.2} />
      </mesh>
      <mesh position={[1.48, 0.18, -0.42]} castShadow>
        <boxGeometry args={[0.5, 0.36, 0.28]} />
        <meshStandardMaterial color="#1a2428" roughness={0.58} metalness={0.16} />
      </mesh>
      <mesh position={[1.48, 0.42, -0.42]} castShadow>
        <boxGeometry args={[0.54, 0.08, 0.32]} />
        <meshStandardMaterial color={outfit} roughness={0.46} metalness={0.12} />
      </mesh>
      <mesh position={[0, 0.018, -1.18]}>
        <boxGeometry args={[1.75, 0.02, 0.035]} />
        <meshStandardMaterial color={accent} emissive={accent} emissiveIntensity={0.18} roughness={0.5} />
      </mesh>
    </group>
  );
}

function StudioFloor() {
  return (
    <group position={[0, -0.72, 0]}>
      <mesh receiveShadow rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.012, 0]}>
        <planeGeometry args={[8.8, 6.2]} />
        <meshStandardMaterial color="#10181a" roughness={0.74} metalness={0.08} />
      </mesh>
      <gridHelper args={[8, 20, "#3d5154", "#1d2a2d"]} position={[0, 0, 0]} />
      <mesh position={[0, 0.008, -1.58]}>
        <boxGeometry args={[4.2, 0.014, 0.035]} />
        <meshStandardMaterial color="#d2a13a" roughness={0.5} metalness={0.12} />
      </mesh>
      <mesh position={[-2.8, 0.16, -1.28]} castShadow>
        <boxGeometry args={[0.48, 0.32, 0.2]} />
        <meshStandardMaterial color="#223239" roughness={0.6} metalness={0.18} />
      </mesh>
      <mesh position={[2.64, 0.15, 1.18]} castShadow>
        <boxGeometry args={[0.42, 0.3, 0.18]} />
        <meshStandardMaterial color="#243037" roughness={0.6} metalness={0.2} />
      </mesh>
    </group>
  );
}

function StationHotspot({ active, position }: { active: boolean; position: { x: number; y: number; z: number } }) {
  return (
    <group position={[position.x, position.y, position.z]}>
      <mesh>
        <sphereGeometry args={[active ? 0.045 : 0.034, 18, 18]} />
        <meshStandardMaterial
          color={active ? "#58d38c" : "#f2c94c"}
          emissive={active ? "#173d27" : "#3d2d0a"}
          roughness={0.3}
          metalness={0.12}
        />
      </mesh>
      <mesh position={[0, -0.08, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <torusGeometry args={[0.075, 0.004, 8, 36]} />
        <meshStandardMaterial color={active ? "#58d38c" : "#f2c94c"} emissive="#14170a" />
      </mesh>
    </group>
  );
}

function AircraftSelectorPanel({
  activeAircraft,
  onOpenBuilder,
  onSelectAircraft,
  palette,
  project,
}: {
  activeAircraft: AircraftBuild;
  onOpenBuilder: () => void;
  onSelectAircraft: (aircraftBuildId: string) => void;
  palette: { base: string; trim: string };
  project: StudioProject;
}) {
  return (
    <section className="studio-section">
      <div className="studio-section-title">
        <span>Aircraft</span>
        <button type="button" className="studio-quiet-button" onClick={onOpenBuilder}>
          <Wrench size={15} />
          Edit build
        </button>
      </div>
      <div className="studio-aircraft-list">
        {project.library.aircraft.map((aircraft) => {
          const archetype = projectAircraftArchetype(aircraft);
          const selected = aircraft.id === activeAircraft.id;
          return (
            <button
              key={aircraft.id}
              type="button"
              className={`studio-aircraft-button${selected ? " active" : ""}`}
              onClick={() => onSelectAircraft(aircraft.id)}
            >
              <span
                className="studio-aircraft-swatch"
                style={{
                  background: selected ? palette.base : (archetype?.palette.base ?? "#4da3ff"),
                  borderColor: selected ? palette.trim : (archetype?.palette.trim ?? "rgba(255,255,255,0.34)"),
                }}
              />
              <span>
                <strong>{aircraft.name}</strong>
                <small>{archetype?.role ?? aircraft.source}</small>
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function ScenarioPanel({
  activeAircraft,
  activeScenario,
  launching,
  onLaunch,
  onOpenBuilder,
  onSelectAircraft,
  onUpdateScenario,
  palette,
  project,
  error,
  progress,
}: {
  activeAircraft: AircraftBuild;
  activeScenario: StudioScenarioConfig;
  launching: boolean;
  onLaunch: () => void;
  onOpenBuilder: () => void;
  onSelectAircraft: (aircraftBuildId: string) => void;
  onUpdateScenario: (update: (scenario: StudioScenarioConfig) => StudioScenarioConfig) => void;
  palette: { base: string; trim: string };
  project: StudioProject;
  error: string | null;
  progress: ScenarioProgress | null;
}) {
  const patchScenario = <K extends keyof StudioScenarioConfig>(key: K, value: StudioScenarioConfig[K]) =>
    onUpdateScenario((scenario) => ({ ...scenario, [key]: value }));
  const motorProgram = activeScenario.controlMode === "motor-program";
  const setControlMode = (value: StudioScenarioConfig["controlMode"]) =>
    onUpdateScenario((scenario) => ({
      ...scenario,
      controlMode: value,
      ...(value === "motor-program"
        ? {
            kind: scenario.kind === "duel" ? "balloon-hard" : scenario.kind,
            pilotModel:
              scenario.pilotModel === "scripted-body-pilot"
                ? DIRECT_DEEPSEEK_PLANNER_MODEL
                : scenario.pilotModel,
            twitchBodyModel:
              scenario.twitchBodyModel === "scripted-fixed-wing-body"
                ? DIRECT_DEEPSEEK_TWITCH_MODEL
                : scenario.twitchBodyModel,
            turnCount: Math.max(4, scenario.turnCount),
            cameraMode: "pilot-cinema",
          }
        : {}),
    }));

  return (
    <>
      <AircraftSelectorPanel
        activeAircraft={activeAircraft}
        onOpenBuilder={onOpenBuilder}
        onSelectAircraft={onSelectAircraft}
        palette={palette}
        project={project}
      />

      <section className="studio-section scenario-sheet">
        <div className="studio-section-title">
          <span>Scenario</span>
          <span>{labelFor(activeScenario.kind)}</span>
        </div>
        <div className="scenario-summary-grid">
          <ScenarioMetric label="Aircraft" value={activeAircraft.name} />
          <ScenarioMetric label="Loop" value={labelFor(activeScenario.controlMode)} />
          <ScenarioMetric label={motorProgram ? "Planner" : "Pilot"} value={labelFor(activeScenario.pilotModel)} />
          <ScenarioMetric
            label={motorProgram ? "Twitch" : "Body"}
            value={labelFor(motorProgram ? activeScenario.twitchBodyModel : activeScenario.bodyModel)}
          />
          <ScenarioMetric label="Turns" value={String(activeScenario.turnCount)} />
          {motorProgram ? (
            <ScenarioMetric
              label="Tape"
              value={`${(activeScenario.motorProgramTurnMs / 1000).toFixed(1)}s / ${activeScenario.motorProgramSampleMs}ms`}
            />
          ) : null}
          {motorProgram ? (
            <ScenarioMetric label="Slow" value={`${activeScenario.twitchTimeScale.toFixed(2)}x`} />
          ) : null}
        </div>
      </section>

      <section className="studio-section">
        <div className="studio-section-title">
          <span>Setup</span>
        </div>
        <OptionRow
          label="Loop"
          selected={activeScenario.controlMode}
          options={SCENARIO_CONTROL_OPTIONS}
          onSelect={setControlMode}
        />
        <OptionRow
          label="Start"
          selected={activeScenario.kind}
          options={SCENARIO_KIND_OPTIONS}
          onSelect={(value) => patchScenario("kind", value)}
        />
        <OptionRow
          label={motorProgram ? "Planner" : "Pilot"}
          selected={activeScenario.pilotModel}
          options={SCENARIO_PILOT_OPTIONS}
          onSelect={(value) => patchScenario("pilotModel", value)}
        />
        {motorProgram ? (
          <OptionRow
            label="Twitch"
            selected={activeScenario.twitchBodyModel}
            options={SCENARIO_TWITCH_BODY_OPTIONS}
            onSelect={(value) => patchScenario("twitchBodyModel", value)}
          />
        ) : (
          <OptionRow
            label="Body"
            selected={activeScenario.bodyModel}
            options={SCENARIO_BODY_OPTIONS}
            onSelect={(value) => patchScenario("bodyModel", value)}
          />
        )}
        <OptionRow
          label="Turns"
          selected={String(activeScenario.turnCount)}
          options={SCENARIO_TURN_OPTIONS}
          onSelect={(value) => patchScenario("turnCount", Number(value))}
        />
        {motorProgram ? (
          <OptionRow
            label="Tape"
            selected={String(activeScenario.motorProgramTurnMs)}
            options={SCENARIO_MOTOR_TURN_OPTIONS}
            onSelect={(value) => patchScenario("motorProgramTurnMs", Number(value))}
          />
        ) : null}
        {motorProgram ? (
          <OptionRow
            label="Step"
            selected={String(activeScenario.motorProgramSampleMs)}
            options={SCENARIO_SAMPLE_OPTIONS}
            onSelect={(value) => patchScenario("motorProgramSampleMs", Number(value))}
          />
        ) : null}
        {motorProgram ? (
          <OptionRow
            label="Slow"
            selected={String(activeScenario.twitchTimeScale)}
            options={SCENARIO_SLOWMO_OPTIONS}
            onSelect={(value) => patchScenario("twitchTimeScale", Number(value))}
          />
        ) : null}
        <OptionRow
          label="Camera"
          selected={activeScenario.cameraMode}
          options={SCENARIO_CAMERA_OPTIONS}
          onSelect={(value) => patchScenario("cameraMode", value)}
        />
      </section>

      <section className="studio-section">
        <button type="button" className="scenario-run-button" onClick={onLaunch} disabled={launching}>
          <Play size={17} />
          {launching ? "Running" : "Run Scenario"}
        </button>
        {progress ? (
          <div className="scenario-progress" aria-label="Scenario progress">
            <div>
              <span>{progress.label}</span>
              <strong>{Math.round(progress.percent * 100)}%</strong>
            </div>
            <i>
              <span style={{ width: `${Math.round(progress.percent * 100)}%` }} />
            </i>
            {progress.turn !== undefined ? (
              <div className="scenario-progress-detail">
                {progress.actionKind ? (
                  <span>{progress.agentLabel ?? "agent"} → {progress.actionKind}</span>
                ) : null}
                {progress.rationale ? (
                  <small>{progress.rationale.slice(0, 120)}{progress.rationale.length > 120 ? "…" : ""}</small>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
        {error ? <p className="scenario-error">{error}</p> : null}
      </section>
    </>
  );
}

function ScenarioMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function AgentPhaseBadge({ phase, time }: { phase?: AgentPhaseTrace; time: number }) {
  const mode = phase?.mode;
  const Icon = mode === "twitch" ? Zap : mode === "body" ? Bot : mode === "planner" ? Clock3 : Gauge;
  return (
    <div className={`agent-phase-badge${mode ? ` phase-${mode}` : ""}`}>
      <Icon size={16} />
      <span>{mode ? labelFor(mode) : "Replay"}</span>
      <strong>{phase?.timeScale ? `${phase.timeScale.toFixed(2)}x` : `${time.toFixed(1)}s`}</strong>
    </div>
  );
}

function CrewLoadoutPanel({
  activeAircraft,
  activePilot,
  fit,
  onUpdatePilot,
}: {
  activeAircraft: AircraftBuild;
  activePilot: PilotProfile;
  fit: FitSummary;
  onUpdatePilot: (pilotProfileId: string, update: (pilot: PilotProfile) => PilotProfile) => void;
}) {
  const appearance = defaultAppearance(activePilot);
  const loadout = defaultLoadout(activePilot);
  const wearableIds = normalizeVrmWearableIds(activePilot.vrmWearables);

  const patchPilot = (update: (pilot: PilotProfile) => PilotProfile) => onUpdatePilot(activePilot.id, update);
  const setAppearance = (key: keyof PilotAppearance, value: string | number) =>
    patchPilot((pilot) => ({
      ...pilot,
      appearance: {
        ...defaultAppearance(pilot),
        [key]: value,
      },
    }));
  const setLoadout = (key: keyof PilotLoadout, value: string) =>
    patchPilot((pilot) => ({
      ...pilot,
      loadout: {
        ...defaultLoadout(pilot),
        [key]: value,
      },
    }));
  const toggleWearable = (id: VrmWearableId) =>
    patchPilot((pilot) => {
      const current = normalizeVrmWearableIds(pilot.vrmWearables);
      const item = VRM_WEARABLE_CATALOG.find((candidate) => candidate.id === id);
      const next = current.includes(id)
        ? current.filter((wearableId) => wearableId !== id)
        : [
            ...current.filter(
              (wearableId) =>
                !(item && "excludes" in item && (item.excludes as readonly string[]).includes(wearableId)),
            ),
            id,
          ];
      return { ...pilot, vrmWearables: next };
    });

  return (
    <>
      <section className="studio-section crew-sheet">
        <div className="studio-section-title">
          <span>Pilot Loadout</span>
          <FitBadge status={fit.status} />
        </div>
        <div className="crew-identity-card">
          <div className="studio-pilot-avatar">
            <UserRound size={24} />
          </div>
          <div>
            <span>{loadout.role}</span>
            <strong>{loadout.callsign}</strong>
            <small>{activeAircraft.name} / {fit.stationLabel}</small>
          </div>
        </div>
        <div className="crew-loadout-grid">
          <LoadoutStat label="Suit" value={labelFor(loadout.flightSuit)} />
          <LoadoutStat label="Comms" value={labelFor(loadout.comms)} />
          <LoadoutStat label="Gloves" value={labelFor(loadout.gloves)} />
          <LoadoutStat label="VRM Gear" value={`${wearableIds.length} equipped`} />
        </div>
      </section>

      <section className="studio-section">
        <div className="studio-section-title">
          <span>Appearance</span>
          <span>{activePilot.materialPreset}</span>
        </div>
        <SwatchRow
          label="Hair"
          selected={appearance.hairTint}
          options={HAIR_SWATCHES}
          onSelect={(value) => setAppearance("hairTint", value)}
        />
        <SwatchRow
          label="Eyes"
          selected={appearance.eyeTint}
          options={EYE_SWATCHES}
          onSelect={(value) => setAppearance("eyeTint", value)}
        />
        <SwatchRow
          label="Suit"
          selected={appearance.outfitTint}
          options={OUTFIT_SWATCHES}
          onSelect={(value) => setAppearance("outfitTint", value)}
        />
        <SwatchRow
          label="Accent"
          selected={appearance.accentTint}
          options={ACCENT_SWATCHES}
          onSelect={(value) => setAppearance("accentTint", value)}
        />
      </section>

      <section className="studio-section">
        <div className="studio-section-title">
          <span>Profile</span>
        </div>
        <OptionRow
          label="Role"
          selected={loadout.role}
          options={ROLE_OPTIONS}
          onSelect={(value) => setLoadout("role", value)}
        />
        <OptionRow
          label="Suit"
          selected={loadout.flightSuit}
          options={SUIT_OPTIONS}
          onSelect={(value) => setLoadout("flightSuit", value)}
        />
        <OptionRow
          label="Comms"
          selected={loadout.comms}
          options={COMMS_OPTIONS}
          onSelect={(value) => setLoadout("comms", value)}
        />
        <OptionRow
          label="Gloves"
          selected={loadout.gloves}
          options={GLOVE_OPTIONS}
          onSelect={(value) => setLoadout("gloves", value)}
        />
      </section>

      <section className="studio-section">
        <div className="studio-section-title">
          <span>Model Core</span>
        </div>
        <OptionRow
          label="Material"
          selected={activePilot.materialPreset}
          options={MATERIAL_OPTIONS}
          onSelect={(value) =>
            patchPilot((pilot) => ({
              ...pilot,
              materialPreset: value as PilotProfile["materialPreset"],
            }))
          }
        />
        <OptionRow
          label="Expression"
          selected={activePilot.expressionPreset ?? "focused"}
          options={EXPRESSION_OPTIONS}
          onSelect={(value) =>
            patchPilot((pilot) => ({
              ...pilot,
              expressionPreset: value as PilotProfile["expressionPreset"],
            }))
          }
        />
        <div className="model-source">
          <span>{activePilot.modelUrl}</span>
        </div>
      </section>

      <section className="studio-section">
        <div className="studio-section-title">
          <span>VRM Gear</span>
          <span>{wearableIds.length} active</span>
        </div>
        <div className="wearable-list">
          {VRM_WEARABLE_CATALOG.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`wearable-card${wearableIds.includes(item.id) ? " active" : ""}`}
              aria-pressed={wearableIds.includes(item.id)}
              onClick={() => toggleWearable(item.id)}
            >
              <span>{item.slot}</span>
              <strong>{item.label}</strong>
              <small>{labelFor(item.source)} / {labelFor(item.bone)}</small>
            </button>
          ))}
        </div>
      </section>

      <PilotFitPanel activePilot={activePilot} fit={fit} />
    </>
  );
}

function PilotFitPanel({ activePilot, fit }: { activePilot: PilotProfile; fit: FitSummary }) {
  return (
    <section className="studio-section">
      <div className="studio-section-title">
        <span>Seat Fit</span>
        <FitBadge status={fit.status} />
      </div>
      <div className="studio-pilot-card">
        <div className="studio-pilot-avatar">
          <UserRound size={23} />
        </div>
        <div>
          <strong>{defaultLoadout(activePilot).callsign}</strong>
          <span>{activePilot.materialPreset}</span>
        </div>
      </div>
      <div className="studio-fit-list">
        {fit.checks.map((check) => (
          <div key={check.id} className="studio-fit-row">
            <FitDot status={check.status} />
            <span>{check.label}</span>
            <strong>{check.value}</strong>
          </div>
        ))}
      </div>
    </section>
  );
}

function LoadoutStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SwatchRow({
  label,
  onSelect,
  options,
  selected,
}: {
  label: string;
  onSelect: (value: string) => void;
  options: readonly string[];
  selected: string;
}) {
  return (
    <div className="crew-custom-row">
      <span>{label}</span>
      <div className="crew-swatch-list">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            className={selected.toLowerCase() === option.toLowerCase() ? "active" : ""}
            aria-label={`${label} ${option}`}
            onClick={() => onSelect(option)}
            style={{ background: option }}
          />
        ))}
      </div>
    </div>
  );
}

function OptionRow<T extends string>({
  label,
  onSelect,
  options,
  selected,
}: {
  label: string;
  onSelect: (value: T) => void;
  options: readonly T[];
  selected: T;
}) {
  return (
    <div className="crew-custom-row">
      <span>{label}</span>
      <div className="crew-option-list">
        {options.map((option) => (
          <button
            key={option}
            type="button"
            className={selected === option ? "active" : ""}
            onClick={() => onSelect(option)}
          >
            {labelFor(option)}
          </button>
        ))}
      </div>
    </div>
  );
}

function ReplayPanel({
  activePhase,
  cameraMode,
  captionsOn,
  frame,
  hudOn,
  onCameraModeChange,
  onCaptionsChange,
  onHudChange,
  onSoundChange,
  onVoiceChange,
  playback,
  pilotId,
  replay,
  soundOn,
  voiceOn,
}: {
  activePhase?: AgentPhaseTrace;
  cameraMode: CameraMode;
  captionsOn: boolean;
  frame?: ReplayFrame;
  hudOn: boolean;
  onCameraModeChange: (mode: CameraMode) => void;
  onCaptionsChange: (enabled: boolean) => void;
  onHudChange: (enabled: boolean) => void;
  onSoundChange: (enabled: boolean) => void;
  onVoiceChange: (enabled: boolean) => void;
  playback: PlaybackControls;
  pilotId: string;
  replay: MatchReplay | null;
  soundOn: boolean;
  voiceOn: boolean;
}) {
  if (!replay || !frame) {
    return (
      <section className="studio-section">
        <div className="studio-section-title">
          <span>Replay</span>
        </div>
        <p className="studio-muted">No replay captured.</p>
      </section>
    );
  }

  return (
    <>
      <section className="studio-section">
        <div className="studio-section-title">
          <span>Replay</span>
          <span>Turn {frame.turn}</span>
        </div>
        <div className="transport" aria-label="Replay transport controls">
          <button type="button" aria-label="Restart replay" onClick={playback.restart}>
            <RotateCcw size={18} />
          </button>
          <button type="button" aria-label="Previous frame" onClick={playback.previous}>
            <StepBack size={18} />
          </button>
          <button
            type="button"
            className="primary-action"
            aria-label={playback.playing ? "Pause replay" : "Play replay"}
            onClick={playback.toggle}
          >
            {playback.playing ? <Pause size={20} /> : <Play size={20} />}
          </button>
          <button type="button" aria-label="Next frame" onClick={playback.next}>
            <StepForward size={18} />
          </button>
        </div>
        <Timeline
          frameIndex={playback.frameIndex}
          frameCount={playback.frameCount}
          onChange={playback.setFrameIndex}
        />
      </section>

      <section className="studio-section">
        <div className="studio-section-title">
          <span>Camera</span>
        </div>
        <div className="view-toggle" role="group" aria-label="Camera view">
          <button
            type="button"
            className={cameraMode === "orbit" ? "active" : ""}
            aria-pressed={cameraMode === "orbit"}
            onClick={() => onCameraModeChange("orbit")}
          >
            <Orbit size={16} /> Orbit
          </button>
          <button
            type="button"
            className={cameraMode === "cabin" ? "active" : ""}
            aria-pressed={cameraMode === "cabin"}
            onClick={() => onCameraModeChange("cabin")}
          >
            <Plane size={16} /> Cabin
          </button>
          <button
            type="button"
            className={cameraMode === "pilot-cinema" ? "active" : ""}
            aria-pressed={cameraMode === "pilot-cinema"}
            onClick={() => onCameraModeChange("pilot-cinema")}
          >
            <Camera size={16} /> Pilot
          </button>
        </div>
        <div className="av-toggle" role="group" aria-label="Captions and audio">
          <button
            type="button"
            className={hudOn ? "active" : ""}
            aria-pressed={hudOn}
            onClick={() => onHudChange(!hudOn)}
          >
            <Gauge size={16} /> HUD
          </button>
          <button
            type="button"
            className={captionsOn ? "active" : ""}
            aria-pressed={captionsOn}
            onClick={() => onCaptionsChange(!captionsOn)}
          >
            <Captions size={16} /> CC
          </button>
          <button
            type="button"
            className={soundOn ? "active" : ""}
            aria-pressed={soundOn}
            onClick={() => onSoundChange(!soundOn)}
          >
            <Volume2 size={16} /> Sound
          </button>
          <button
            type="button"
            className={voiceOn ? "active" : ""}
            aria-pressed={voiceOn}
            onClick={() => onVoiceChange(!voiceOn)}
          >
            <Captions size={16} /> Voice
          </button>
        </div>
      </section>

      <AgentModePanel replay={replay} pilotId={pilotId} activePhase={activePhase} />
      <MatchStats replay={replay} pilotId={pilotId} />
      <BodyPanel replay={replay} frame={frame} pilotId={pilotId} />
      <TranscriptPanel
        replay={replay}
        frame={frame}
        pilotId={pilotId}
        onSeek={(position) => playback.setPosition(position, false)}
      />
      <TalkToPilotPanel replay={replay} pilotId={pilotId} focusTime={frame.time} />
      <StatusPanel frame={frame} />
      <ControlsPanel frame={frame} />
    </>
  );
}

interface DebriefTurn {
  role: "user" | "assistant";
  content: string;
}

interface DebriefResponsePayload {
  reply: string;
  pilotLabel: string;
  scripted: boolean;
  time: number;
  grounding?: { turns?: number; overshootTurn?: number };
}

// "Talk to pilot" — a toggle-gated, grounded debrief chat over the active replay. It calls
// POST /api/scenario/debrief with the running conversation; the pilot answers from replay evidence
// only. Self-contained state (no App-level wiring) so it's additive and reversible. Mirrors the
// fetch convention used by /api/scenario/run in App.tsx.
function TalkToPilotPanel({
  focusTime,
  pilotId,
  replay,
}: {
  focusTime: number;
  pilotId: string;
  replay: MatchReplay;
}) {
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<DebriefTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pilotLabel, setPilotLabel] = useState<string | null>(null);

  const pilotName = pilotLabel ?? replay.agents?.find((a) => a.id === pilotId)?.label ?? pilotId;

  async function send(message: string) {
    const text = message.trim();
    if (!text || busy) return;
    const history: DebriefTurn[] = [...turns, { role: "user", content: text }];
    setTurns(history);
    setDraft("");
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/scenario/debrief", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ replay, pilotId, time: focusTime, messages: history }),
      });
      const payload = (await response.json().catch(() => undefined)) as
        | (DebriefResponsePayload & { error?: string })
        | undefined;
      if (!response.ok || !payload || typeof payload.reply !== "string") {
        const reason =
          payload && typeof payload.error === "string"
            ? payload.error
            : `debrief request failed (${response.status})`;
        throw new Error(reason);
      }
      if (payload.pilotLabel) setPilotLabel(payload.pilotLabel);
      setTurns((prev) => [...prev, { role: "assistant", content: payload.reply }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // Drop the optimistic user turn back into the draft so the question isn't lost.
      setTurns((prev) => prev.slice(0, -1));
      setDraft(text);
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <section className="studio-section">
        <div className="studio-section-title">
          <span>Talk to pilot</span>
        </div>
        <button type="button" className="studio-quiet-button" onClick={() => setOpen(true)}>
          <MessageCircle size={15} /> Debrief {pilotName}
        </button>
        <p className="studio-muted">Ask the pilot about this flight. Grounded in the replay at t={focusTime.toFixed(1)}s.</p>
      </section>
    );
  }

  return (
    <section className="panel talk-panel" aria-label="Talk to pilot">
      <div className="talk-head">
        <h2>Talk to pilot</h2>
        <button type="button" className="studio-quiet-button" onClick={() => setOpen(false)}>
          Close
        </button>
      </div>
      <p className="talk-grounding">
        {pilotName} · grounded on replay {replay.id} @ t={focusTime.toFixed(1)}s
      </p>
      <div className="talk-log">
        {turns.length === 0 ? (
          <p className="studio-muted">No questions yet. Ask how the flight went, or about a specific turn.</p>
        ) : (
          turns.map((turn, index) => (
            <div key={index} className={`talk-turn talk-${turn.role}`}>
              <span className="talk-speaker">{turn.role === "user" ? "You" : pilotName}</span>
              <p>{turn.content}</p>
            </div>
          ))
        )}
        {busy ? <p className="studio-muted talk-pending">Pilot is reviewing the tape…</p> : null}
      </div>
      {error ? <p className="scenario-error">{error}</p> : null}
      <form
        className="talk-compose"
        onSubmit={(event) => {
          event.preventDefault();
          void send(draft);
        }}
      >
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder={turns.length === 0 ? "How did that flight go?" : "Ask a follow-up…"}
          aria-label="Message to pilot"
          disabled={busy}
        />
        <button type="submit" className="studio-primary-button" disabled={busy || !draft.trim()}>
          <SendHorizontal size={15} /> {busy ? "…" : "Ask"}
        </button>
      </form>
    </section>
  );
}

function AgentModePanel({
  activePhase,
  pilotId,
  replay,
}: {
  activePhase?: AgentPhaseTrace;
  pilotId: string;
  replay: MatchReplay;
}) {
  const plannerCount = countAgentPhases(replay, pilotId, "planner");
  const twitchCount = countAgentPhases(replay, pilotId, "twitch");
  const bodyCount =
    countAgentPhases(replay, pilotId, "body") ||
    (replay.bodyTicks ?? []).filter((tick) => tick.agentId === pilotId).length;
  const activeLabel = activePhase ? labelFor(activePhase.mode) : "Unmarked";
  const model = activePhase?.model ?? replay.agents?.find((agent) => agent.id === pilotId)?.label ?? pilotId;

  return (
    <section className="panel agent-mode-panel" aria-label="Agent mode">
      <div className="agent-mode-head">
        <h2>Agent Mode</h2>
        <span className={`agent-mode-pill mode-${activePhase?.mode ?? "planner"}`}>{activeLabel}</span>
      </div>
      <div className="metrics">
        <ModeMetric icon={Clock3} label="Planner" value={String(plannerCount)} />
        <ModeMetric icon={Zap} label="Twitch" value={String(twitchCount)} />
        <ModeMetric icon={Bot} label="Body" value={String(bodyCount)} />
        <ModeMetric
          icon={Gauge}
          label="Scale"
          value={activePhase?.timeScale ? `${activePhase.timeScale.toFixed(2)}x` : "1x"}
        />
      </div>
      <p className="agent-mode-model">{model}</p>
    </section>
  );
}

function ModeMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: ComponentType<{ size?: number }>;
  label: string;
  value: string;
}) {
  return (
    <div className="metric mode-metric">
      <Icon size={15} />
      <p className="metric-label">{label}</p>
      <div className="metric-value">{value}</div>
    </div>
  );
}

function StudioStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PerformanceEnvelopePanel({ performance }: { performance: PerformancePresentation }) {
  return (
    <section className="studio-section performance-envelope" aria-label="Flight envelope">
      <div className="studio-section-title">
        <span>Flight Envelope</span>
        <span>{performance.headline}</span>
      </div>

      <div className="performance-card-grid">
        {performance.cards.map((card) => (
          <div key={card.label} className="performance-card">
            <span>{card.label}</span>
            <strong>{card.value}</strong>
            <small>{card.detail}</small>
          </div>
        ))}
      </div>

      <div className="performance-traits">
        {performance.traits.map((trait) => (
          <div key={trait.label} className={`performance-trait ${trait.tone}`}>
            <div>
              <span>{trait.label}</span>
              <strong>{trait.value}</strong>
            </div>
            <div className="performance-meter" aria-hidden="true">
              <i style={{ width: `${Math.round(trait.rating * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>

      <p className="performance-note">{performance.operatingNote}</p>
      <p className="performance-note muted">{performance.accelerationNote}</p>
    </section>
  );
}

function FitBadge({ status }: { status: FitStatusValue }) {
  return <span className={`studio-fit-badge ${status}`}>{status}</span>;
}

function FitDot({ status }: { status: FitStatusValue }) {
  return <span className={`studio-fit-dot ${status}`} />;
}

type FitStatusValue = "ok" | "warning" | "blocked";

interface FitSummary {
  checks: Array<{ id: string; label: string; status: FitStatusValue; value: string }>;
  stationLabel: string;
  status: FitStatusValue;
}

function summarizeFit(aircraft: AircraftBuild, pilotProfileId: string): FitSummary {
  const diagnostics = computeCockpitFitDiagnostics(neutralControls(), aircraft.airframe.parts);
  const stationLabel = diagnostics.station.stationId ?? diagnostics.station.source;
  const checks = [
    {
      id: "head",
      label: "Head clearance",
      status: canopyContains(diagnostics.station.canopy, diagnostics.station.faceTarget) ? "ok" : "warning",
      value: diagnostics.station.canopy ? "inside" : "open",
    },
    {
      id: "eye",
      label: "Eye line",
      status: threshold(diagnostics.headToCamera, 0.08, 0.16),
      value: `${diagnostics.headToCamera.toFixed(2)} m`,
    },
    {
      id: "canopy",
      label: "Canopy containment",
      status:
        canopyContains(diagnostics.station.canopy, diagnostics.station.eye) &&
        canopyContains(diagnostics.station.canopy, diagnostics.station.seatHip)
          ? "ok"
          : "warning",
      value: diagnostics.station.canopy?.id ?? "none",
    },
    reachCheck("right-hand", "Right hand", diagnostics.rightArm.ratio),
    reachCheck("left-hand", "Left hand", diagnostics.leftArm.ratio),
    reachCheck("right-foot", "Right foot", diagnostics.rightLeg.ratio),
    reachCheck("left-foot", "Left foot", diagnostics.leftLeg.ratio),
  ] satisfies FitSummary["checks"];
  return {
    checks,
    stationLabel: `${stationLabel} / ${pilotProfileId}`,
    status: worstStatus(checks.map((check) => check.status)),
  };
}

function reachCheck(id: string, label: string, ratio: number) {
  return {
    id,
    label,
    status: threshold(ratio, 1.05, 1.22),
    value: `${ratio.toFixed(2)}x`,
  };
}

function threshold(value: number, warning: number, blocked: number): FitStatusValue {
  if (value >= blocked) return "blocked";
  if (value >= warning) return "warning";
  return "ok";
}

function worstStatus(statuses: FitStatusValue[]): FitStatusValue {
  if (statuses.includes("blocked")) return "blocked";
  if (statuses.includes("warning")) return "warning";
  return "ok";
}

function canopyContains(canopy: CanopyEnvelope | null, point: { x: number; y: number; z: number }): boolean {
  if (!canopy) return false;
  return (
    Math.abs(point.x - canopy.center.x) <= canopy.size.x / 2 &&
    Math.abs(point.y - canopy.center.y) <= canopy.size.y / 2 &&
    Math.abs(point.z - canopy.center.z) <= canopy.size.z / 2
  );
}

function previewPilotShip(aircraft: AircraftBuild, color: string): AircraftSnapshot {
  return {
    id: "studio-preview",
    callsign: aircraft.name,
    team: "blue",
    color,
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    orientation: { x: 0, y: 0, z: 0, w: 1 },
    controls: neutralControls(),
    airspeed: 0,
    altitude: 0,
    aoaDeg: 0,
    gLoad: 1,
    health: 100,
    weaponCooldown: 0,
    stalled: false,
  };
}

function projectAircraftArchetype(aircraft: AircraftBuild) {
  return aircraftArchetypes.find((archetype) => archetype.id === aircraft.sourceArchetypeId);
}

type PilotAppearance = NonNullable<PilotProfile["appearance"]>;
type PilotLoadout = NonNullable<PilotProfile["loadout"]>;

function defaultAppearance(pilot: PilotProfile): Required<PilotAppearance> {
  return {
    accentTint: pilot.appearance?.accentTint ?? "#f2c94c",
    eyeTint: pilot.appearance?.eyeTint ?? "#67a7ff",
    hairTint: pilot.appearance?.hairTint ?? "#d68a48",
    outfitTint: pilot.appearance?.outfitTint ?? "#c9d4ef",
    skinWarmth: pilot.appearance?.skinWarmth ?? 0.15,
  };
}

function defaultLoadout(pilot: PilotProfile): PilotLoadout {
  return {
    callsign: pilot.loadout?.callsign ?? "Echo",
    comms: pilot.loadout?.comms ?? "broadcast-rig",
    flightSuit: pilot.loadout?.flightSuit ?? "ace",
    gloves: pilot.loadout?.gloves ?? "flight",
    role: pilot.loadout?.role ?? "duelist",
  };
}

function labelFor(value: string): string {
  const override = LABEL_OVERRIDES[value];
  if (override) return override;
  return value
    .split("-")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

const MODE_ITEMS: Array<{ icon: ComponentType<{ size?: number }>; label: string; mode: StudioMode }> = [
  { icon: Plane, label: "Hangar", mode: "hangar" },
  { icon: UserRound, label: "Crew", mode: "crew" },
  { icon: SlidersHorizontal, label: "Scene", mode: "scenario" },
  { icon: BadgeCheck, label: "Flight", mode: "flight" },
  { icon: Film, label: "Replay", mode: "replay" },
  { icon: Gauge, label: "Debug", mode: "debug" },
];

const HAIR_SWATCHES = ["#2f2530", "#d68a48", "#f2c94c", "#e77aa6", "#83d4ff"] as const;
const EYE_SWATCHES = ["#67a7ff", "#59d894", "#d5a64f", "#c07cff", "#f8f4df"] as const;
const OUTFIT_SWATCHES = ["#c9d4ef", "#1d2a3a", "#793d76", "#d64e43", "#f0efe5"] as const;
const ACCENT_SWATCHES = ["#f2c94c", "#4da3ff", "#58d38c", "#ff8d83", "#f0efe5"] as const;

const ROLE_OPTIONS = ["rookie", "duelist", "instructor"] as const;
const SUIT_OPTIONS = ["cadet", "ace", "test-pilot"] as const;
const COMMS_OPTIONS = ["open-cockpit", "throat-mic", "broadcast-rig"] as const;
const GLOVE_OPTIONS = ["none", "fingerless", "flight"] as const;
const MATERIAL_OPTIONS = ["studio-safe", "vrm", "diagnostic"] as const;
const EXPRESSION_OPTIONS = ["neutral", "focused", "excited", "strained"] as const;
const SCENARIO_CONTROL_OPTIONS = ["body-pilot", "motor-program"] as const satisfies readonly StudioScenarioConfig["controlMode"][];
const SCENARIO_KIND_OPTIONS = ["duel", "stern-gun", "balloon", "balloon-hard"] as const satisfies readonly StudioScenarioConfig["kind"][];
const SCENARIO_PILOT_OPTIONS = [
  "scripted-body-pilot",
  DIRECT_DEEPSEEK_PLANNER_MODEL,
  DIRECT_DEEPSEEK_TWITCH_MODEL,
  "deepseek/deepseek-v4-flash",
] as const satisfies readonly StudioScenarioConfig["pilotModel"][];
const SCENARIO_BODY_OPTIONS = [
  "scripted-fixed-wing-body",
  DIRECT_DEEPSEEK_TWITCH_MODEL,
  "deepseek/deepseek-v4-flash",
] as const satisfies readonly StudioScenarioConfig["bodyModel"][];
const SCENARIO_TWITCH_BODY_OPTIONS = [
  DIRECT_DEEPSEEK_TWITCH_MODEL,
  "deepseek/deepseek-v4-flash",
  "scripted-fixed-wing-body",
] as const satisfies readonly StudioScenarioConfig["twitchBodyModel"][];
const SCENARIO_TURN_OPTIONS: readonly string[] = ["1", "2", "4", "8", "12"];
const SCENARIO_MOTOR_TURN_OPTIONS: readonly string[] = ["1500", "2500", "3500"];
const SCENARIO_SAMPLE_OPTIONS: readonly string[] = ["50", "75", "100"];
const SCENARIO_SLOWMO_OPTIONS: readonly string[] = ["0.25", "0.35", "0.5", "1"];
const SCENARIO_CAMERA_OPTIONS = ["orbit", "cabin", "pilot-cinema"] as const satisfies readonly StudioScenarioConfig["cameraMode"][];

const LABEL_OVERRIDES: Record<string, string> = {
  "body-pilot": "Body Pilot",
  "motor-program": "Motor Tape",
  planner: "Planner",
  body: "Body",
  twitch: "Twitch",
  "balloon-hard": "Hard Balloon",
  "scripted-body-pilot": "Scripted Pilot",
  "scripted-fixed-wing-body": "Scripted Body",
  "deepseek-v4-pro": "DeepSeek V4 Pro",
  "deepseek-v4-flash": "DeepSeek V4 Flash",
  "deepseek/deepseek-v4-flash": "DeepSeek V4 Flash",
  "1500": "1.5s",
  "2500": "2.5s",
  "3500": "3.5s",
  "50": "50ms",
  "75": "75ms",
  "100": "100ms",
  "0.25": "0.25x",
  "0.35": "0.35x",
  "0.5": "0.5x",
};
