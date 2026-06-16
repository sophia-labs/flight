import { OrbitControls } from "@react-three/drei";
import { Canvas } from "@react-three/fiber";
import {
  BadgeCheck,
  Camera,
  Captions,
  Film,
  Gauge,
  Orbit,
  Pause,
  Plane,
  Play,
  RotateCcw,
  SlidersHorizontal,
  StepBack,
  StepForward,
  UserRound,
  Volume2,
  Wrench,
} from "lucide-react";
import { useMemo, type ComponentType } from "react";
import type { MatchReplay, ReplayFrame } from "../protocol/schema";
import { airframeReport, compileAirframe } from "../sim/airframe";
import { aircraftArchetypes, type AircraftArchetype } from "../sim/aircraftCatalog";
import type { AircraftBuild, PilotProfile, StudioMode, StudioProject, StudioSession } from "../studio/schema";
import { BodyPanel } from "./BodyPanel";
import { ControlsPanel } from "./ControlsPanel";
import { FlightScene, type CameraMode } from "./FlightScene";
import { PartMeshes } from "./airframeMesh";
import { MatchStats } from "./MatchStats";
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

export function StudioScreen({
  activeAircraft,
  activeArchetype,
  activePilot,
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
  onVoiceChange,
  pilotId,
  playback,
  project,
  replay,
  soundOn,
  voiceOn,
}: {
  activeAircraft: AircraftBuild;
  activeArchetype?: AircraftArchetype;
  activePilot: PilotProfile;
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
  onVoiceChange: (enabled: boolean) => void;
  pilotId: string;
  playback: PlaybackControls;
  project: StudioProject;
  replay: MatchReplay | null;
  soundOn: boolean;
  voiceOn: boolean;
}) {
  const compiled = useMemo(() => compileAirframe(activeAircraft.airframe), [activeAircraft.airframe]);
  const report = useMemo(() => airframeReport(compiled.model), [compiled.model]);
  const fit = useMemo(
    () => summarizeFit(activeAircraft, activePilot.id),
    [activeAircraft, activePilot.id],
  );
  const showFlight = Boolean((mode === "flight" || mode === "replay") && replay && frame);
  const palette = activeArchetype?.palette ?? { base: "#4da3ff", trim: "#f2c94c" };

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
          camera={{ position: [2.45, 1.45, 3.15], fov: showFlight ? 54 : 38, near: 0.01, far: 1200 }}
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
            />
          ) : (
            <StudioHangarScene
              aircraft={activeAircraft}
              color={palette.base}
              accentColor={palette.trim}
              showCrew={mode === "crew" || mode === "debug"}
            />
          )}
        </Canvas>

        <div className="studio-stage-label">
          <span>{mode}</span>
          <strong>{activeAircraft.name}</strong>
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
            {launching ? "Launching" : "Launch"}
          </button>
        </header>

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

        <section className="studio-section studio-stat-strip" aria-label="Aircraft stats">
          <StudioStat label="mass" value={`${Math.round(compiled.model.massKg)} kg`} />
          <StudioStat label="thrust" value={`${(compiled.model.maxThrustN / 1000).toFixed(0)} kN`} />
          <StudioStat label="wing" value={`${compiled.model.wingAreaM2.toFixed(1)} m2`} />
          <StudioStat label="T:W" value={report.thrustToWeight.toFixed(2)} />
        </section>

        <section className="studio-section">
          <div className="studio-section-title">
            <span>Pilot</span>
            <FitBadge status={fit.status} />
          </div>
          <div className="studio-pilot-card">
            <div className="studio-pilot-avatar">
              <UserRound size={23} />
            </div>
            <div>
              <strong>{activePilot.name}</strong>
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
  showCrew,
}: {
  accentColor: string;
  aircraft: AircraftBuild;
  color: string;
  showCrew: boolean;
}) {
  const cockpit = computeCockpitRig(neutralControls(), aircraft.airframe.parts);
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
        <StationHotspot position={cockpit.station.seatHip} active={showCrew} />
      </group>
      <OrbitControls enableDamping dampingFactor={0.1} />
    </>
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

function ReplayPanel({
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

      <MatchStats replay={replay} pilotId={pilotId} />
      <BodyPanel replay={replay} frame={frame} pilotId={pilotId} />
      <TranscriptPanel
        replay={replay}
        frame={frame}
        pilotId={pilotId}
        onSeek={(position) => playback.setPosition(position, false)}
      />
      <StatusPanel frame={frame} />
      <ControlsPanel frame={frame} />
    </>
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

function projectAircraftArchetype(aircraft: AircraftBuild) {
  return aircraftArchetypes.find((archetype) => archetype.id === aircraft.sourceArchetypeId);
}

const MODE_ITEMS: Array<{ icon: ComponentType<{ size?: number }>; label: string; mode: StudioMode }> = [
  { icon: Plane, label: "Hangar", mode: "hangar" },
  { icon: UserRound, label: "Crew", mode: "crew" },
  { icon: BadgeCheck, label: "Flight", mode: "flight" },
  { icon: Film, label: "Replay", mode: "replay" },
  { icon: SlidersHorizontal, label: "Debug", mode: "debug" },
];
