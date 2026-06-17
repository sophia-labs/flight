import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Airframe, type ContactPercept, type MatchReplay } from "./protocol/schema";
import { generateScenarioMatch } from "./runtime/scenario";
import { aircraftArchetypes } from "./sim/aircraftCatalog";
import {
  addReplayAsset,
  createReplayAsset,
  getActiveAircraft,
  getActivePilot,
  getActiveReplay,
  getActiveSession,
  selectAircraftBuild,
  selectStudioMode,
  updateScenarioConfig,
  updatePilotProfile,
} from "./studio/project";
import {
  DEFAULT_STUDIO_SCENARIO_CONFIG,
  type PilotProfile,
  type StudioMode,
  type StudioProject,
  type StudioScenarioConfig,
} from "./studio/schema";
import { loadStudioProject, saveStudioProject } from "./studio/store";
import type { CameraMode } from "./viewer/FlightScene";
import { HangarScreen } from "./viewer/HangarScreen";
import { MissionControl, type MissionRadarTrack, type MissionState } from "./viewer/MissionControl";
import { sampleReplayFrame } from "./viewer/replaySample";
import { StudioScreen } from "./viewer/StudioScreen";
import { usePlayback } from "./viewer/usePlayback";
import { useReplayAudio } from "./viewer/useReplayAudio";

function queryValue(name: string): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get(name);
}

function queryFlag(name: string, fallback: boolean): boolean {
  const value = queryValue(name);
  if (value === null) return fallback;
  return !["0", "false", "off", "no"].includes(value.toLowerCase());
}

function queryCameraMode(): CameraMode {
  const value = queryValue("camera");
  if (value === "cabin") return "cabin";
  if (value === "pilot-cinema" || value === "pilot" || value === "girl") return "pilot-cinema";
  return "orbit";
}

declare global {
  interface Window {
    __flightSetReplayPosition?: (position: number) => void;
  }
}

export interface ScenarioLaunchProgress {
  label: string;
  percent: number;
  turn?: number;
  maxTurns?: number;
  actionKind?: string;
  agentLabel?: string;
  rationale?: string;
}

function missionRadarTracks(contacts: ContactPercept[] | undefined): MissionRadarTrack[] {
  return (contacts ?? []).map((contact) => ({
    id: contact.id,
    team: contact.team,
    range: contact.range,
    bearingForward: contact.bearingForward,
    bearingRight: contact.bearingRight,
    bearingUp: contact.bearingUp,
    missileLock: contact.missileLock,
    radarLock: contact.radarLock,
    health: contact.health,
  }));
}

export function App() {
  const [project, setProject] = useState<StudioProject>(() => loadStudioProject());
  const [cameraMode, setCameraMode] = useState<CameraMode>(() => queryCameraMode());
  const [hudOn, setHudOn] = useState(() => queryFlag("hud", true));
  const [captionsOn, setCaptionsOn] = useState(() => queryFlag("captions", true));
  const [soundOn, setSoundOn] = useState(() => queryFlag("sound", false));
  const [voiceOn, setVoiceOn] = useState(() => queryFlag("voice", false));
  const [builderOpen, setBuilderOpen] = useState(false);
  const [launching, setLaunching] = useState(false);
  const [scenarioProgress, setScenarioProgress] = useState<ScenarioLaunchProgress | null>(null);
  const [missionState, setMissionState] = useState<MissionState | null>(null);
  const missionIdRef = useRef(0);
  const tickIdRef = useRef(0);
  const [scenarioError, setScenarioError] = useState<string | null>(null);

  const activeSession = useMemo(() => getActiveSession(project), [project]);
  const activeAircraft = useMemo(() => getActiveAircraft(project, activeSession), [project, activeSession]);
  const activePilot = useMemo(() => getActivePilot(project, activeSession), [project, activeSession]);
  const activeReplay = useMemo(() => getActiveReplay(project, activeSession), [project, activeSession]);
  const activeScenario = useMemo<StudioScenarioConfig>(
    () => ({
      ...DEFAULT_STUDIO_SCENARIO_CONFIG,
      ...activeSession.scenario,
    }),
    [activeSession.scenario],
  );
  const activeArchetype = useMemo(
    () => aircraftArchetypes.find((archetype) => archetype.id === activeAircraft.sourceArchetypeId),
    [activeAircraft.sourceArchetypeId],
  );
  const replay = activeReplay?.matchReplay ?? null;

  useEffect(() => {
    saveStudioProject(project);
  }, [project]);

  const updateProject = useCallback((update: (current: StudioProject) => StudioProject) => {
    setProject((current) => update(current));
  }, []);

  const playback = usePlayback(replay);
  const frame = replay ? sampleReplayFrame(replay.frames, playback.samplePosition) : undefined;

  useEffect(() => {
    window.__flightSetReplayPosition = (position: number) => {
      playback.setPosition(position, false);
    };
    return () => {
      delete window.__flightSetReplayPosition;
    };
  }, [playback.setPosition]);

  const pilotId = useMemo(
    () => replay?.agents?.find((agent) => agent.kind === "llm")?.id ?? "blue-1",
    [replay],
  );
  const rationaleByTurn = useMemo(() => {
    const byTurn = new Map<number, string>();
    for (const decision of replay?.decisions ?? []) {
      if (decision.agentId === pilotId && decision.rationale) {
        byTurn.set(decision.turn, decision.rationale);
      }
    }
    return byTurn;
  }, [replay, pilotId]);
  const caption = frame ? rationaleByTurn.get(frame.turn) : undefined;

  useReplayAudio(frame, pilotId, soundOn);

  useEffect(() => {
    if (!voiceOn || !caption || typeof window === "undefined" || !window.speechSynthesis) return;
    const utterance = new SpeechSynthesisUtterance(caption);
    utterance.rate = 1.1;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  }, [caption, voiceOn]);

  useEffect(() => {
    if (!voiceOn && typeof window !== "undefined" && window.speechSynthesis) {
      window.speechSynthesis.cancel();
    }
  }, [voiceOn]);

  const handleModeChange = useCallback(
    (mode: StudioMode) => updateProject((current) => selectStudioMode(current, mode)),
    [updateProject],
  );

  const handleSelectAircraft = useCallback(
    (aircraftBuildId: string) => updateProject((current) => selectAircraftBuild(current, aircraftBuildId)),
    [updateProject],
  );

  const handleUpdatePilot = useCallback(
    (pilotProfileId: string, update: (pilot: PilotProfile) => PilotProfile) =>
      updateProject((current) => updatePilotProfile(current, pilotProfileId, update)),
    [updateProject],
  );

  const handleUpdateScenario = useCallback(
    (update: (scenario: StudioScenarioConfig) => StudioScenarioConfig) =>
      updateProject((current) => updateScenarioConfig(current, update)),
    [updateProject],
  );

  const addReplayToProject = useCallback(
    (matchReplay: MatchReplay, title: string, aircraftBuildId = activeAircraft.id, sessionId = activeSession.id) => {
      const now = new Date();
      const asset = createReplayAsset({
        aircraftBuildId,
        matchReplay,
        now,
        sessionId,
        title,
      });
      updateProject((current) => addReplayAsset(current, asset, now));
    },
    [activeAircraft.id, activeSession.id, updateProject],
  );

  const launchFlight = useCallback(async () => {
    if (launching) return;
    const aircraft = activeAircraft;
    const session = activeSession;
    const scenario = activeScenario;
    setLaunching(true);
    setScenarioError(null);
    setScenarioProgress(null);
    const onServer = scenarioRunsOnServer(scenario);
    const maxTurns = scenario.turnCount;
    const controlLabel = scenario.controlMode === "motor-program" ? "motor-program" : "body-pilot";
    const kindLabel = SCENARIO_TITLE_BY_KIND[scenario.kind];

    // Initialize mission state
    missionIdRef.current = 0;
    tickIdRef.current = 0;
    setMissionState({
      scenarioLabel: kindLabel,
      aircraftName: aircraft.name,
      controlMode: controlLabel,
      turn: 0,
      maxTurns,
      percent: 0,
      decisions: [],
      bodyTicks: [],
      radarTracks: [],
      complete: false,
    });
    // Yield so React paints the initial MissionControl frame before the match runs
    await nextPaint();
    const pushDecision = (
      turn: number,
      agentId: string,
      agentLabel: string,
      actionKind: string,
      rationale?: string,
      contacts?: ContactPercept[],
    ) => {
      const id = missionIdRef.current++;
      setMissionState((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          decisions: [...prev.decisions, { id, turn, agentId, agentLabel, actionKind, rationale }],
          ...(agentId === "blue-1" ? { radarTracks: missionRadarTracks(contacts) } : {}),
        };
      });
    };

    // Helper: push a body tick to mission state
    const pushBodyTick = (agentId: string, status: string, tick: number, time: number, feel?: string) => {
      const id = tickIdRef.current++;
      setMissionState((prev) => {
        if (!prev) return prev;
        const ticks = [...prev.bodyTicks, { id, time, agentId, status, tick, feel }];
        // Keep only the last 40 ticks
        if (ticks.length > 40) ticks.splice(0, ticks.length - 40);
        return { ...prev, bodyTicks: ticks };
      });
    };

    // Helper: update turn/percent
    const updateProgress = (turn: number, pct: number) => {
      setMissionState((prev) => {
        if (!prev) return prev;
        return { ...prev, turn, percent: pct, maxTurns };
      });
    };

    try {
      if (onServer) {
        // SSE streaming path
        const response = await fetch("/api/scenario/run", {
          method: "POST",
          headers: { "content-type": "application/json", accept: "text/event-stream" },
          body: JSON.stringify({ airframe: aircraft.airframe, scenario }),
        });
        if (!response.ok) {
          const payload = await response.json().catch(() => undefined);
          const message =
            payload && typeof payload.error === "string"
              ? payload.error
              : `scenario request failed (${response.status})`;
          throw new Error(message);
        }
        const body = response.body;
        if (!body) throw new Error("No response body for streaming scenario");
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let built: MatchReplay | undefined;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const event = JSON.parse(line.slice(6));
              if (event.phase === "error") throw new Error(event.error ?? "Unknown streaming error");
              if (event.phase === "complete") {
                built = event.replay;
                if (!built) throw new Error("Streaming complete without replay");
                updateProgress(event.turn ?? maxTurns, 1);
                setMissionState((prev) => prev ? { ...prev, complete: true } : prev);
              } else {
                const turn = event.turn ?? 0;
                const pct = 0.05 + Math.min(0.9, (turn / Math.max(1, maxTurns)) * 0.9);
                updateProgress(turn, pct);
                if (event.phase === "decision" && event.agentId && event.agentLabel && event.actionKind) {
                  pushDecision(turn, event.agentId, event.agentLabel, event.actionKind, event.rationale, event.contacts);
                }
                if (event.phase === "body_tick" && event.bodyTick) {
                  pushBodyTick(
                    event.bodyTick.agentId,
                    event.bodyTick.status,
                    event.bodyTick.tick,
                    event.time,
                    event.bodyTick.feel,
                  );
                }
              }
            } catch {
              // Skip unparseable lines
            }
          }
        }
        if (!built) throw new Error("Stream ended without complete event");

        // Brief pause to show the COMPLETE flash
        await new Promise((r) => setTimeout(r, 1200));
        addReplayToProject(built, scenarioTitle(aircraft.name, scenario), aircraft.id, session.id);
        setCameraMode(scenario.cameraMode);
      } else {
        // Client-side — pass onProgress for local streaming
        const built = await generateScenarioMatch(aircraft.airframe, scenario, (progress) => {
          const turn = progress.turn ?? 0;
          const pct = 0.05 + Math.min(0.9, (turn / Math.max(1, maxTurns)) * 0.9);
          updateProgress(turn, pct);
          if (progress.phase === "decision" && progress.agentId && progress.agentLabel && progress.actionKind) {
            pushDecision(
              turn,
              progress.agentId,
              progress.agentLabel,
              progress.actionKind,
              progress.rationale,
              progress.contacts,
            );
          }
          if (progress.phase === "body_tick" && progress.bodyTick) {
            pushBodyTick(
              progress.bodyTick.agentId,
              progress.bodyTick.status,
              progress.bodyTick.tick,
              progress.time,
              progress.bodyTick.feel,
            );
          }
        });
        updateProgress(maxTurns, 1);
        setMissionState((prev) => prev ? { ...prev, complete: true } : prev);
        await new Promise((r) => setTimeout(r, 1200));
        addReplayToProject(built, scenarioTitle(aircraft.name, scenario), aircraft.id, session.id);
        setCameraMode(scenario.cameraMode);
      }
    } catch (error) {
      setScenarioError(error instanceof Error ? error.message : String(error));
    } finally {
      setLaunching(false);
      setMissionState(null);
    }
  }, [activeAircraft, activeScenario, activeSession, addReplayToProject, launching]);

  const onFlyBuild = useCallback(
    (built: MatchReplay) => {
      setBuilderOpen(false);
      addReplayToProject(built, "Builder sortie");
      setCameraMode("pilot-cinema");
    },
    [addReplayToProject],
  );

  return (
    <>
      {builderOpen ? (
        <HangarScreen onExit={() => setBuilderOpen(false)} onFly={onFlyBuild} />
      ) : null}
      {missionState ? (
        <MissionControl state={missionState} />
      ) : (
        <StudioScreen
          activeAircraft={activeAircraft}
          activeArchetype={activeArchetype}
          activePilot={activePilot}
          activeScenario={activeScenario}
          activeSession={activeSession}
          cameraMode={cameraMode}
          caption={caption}
          captionsOn={captionsOn}
          frame={frame}
          hudOn={hudOn}
          launching={launching}
          mode={activeSession.ui.mode}
          onCameraModeChange={setCameraMode}
          onCaptionsChange={setCaptionsOn}
          onHudChange={setHudOn}
          onLaunch={launchFlight}
          onModeChange={handleModeChange}
          onOpenBuilder={() => setBuilderOpen(true)}
          onSelectAircraft={handleSelectAircraft}
          onSoundChange={setSoundOn}
          onUpdateScenario={handleUpdateScenario}
          onUpdatePilot={handleUpdatePilot}
          onVoiceChange={setVoiceOn}
          pilotId={pilotId}
          playback={{
            clock: playback.clock,
            frameCount: replay?.frames.length ?? 0,
            frameIndex: playback.frameIndex,
            next: playback.next,
            playing: playback.playing,
            previous: playback.previous,
            reportIndex: playback.reportIndex,
            reportSample: playback.reportSample,
            restart: playback.restart,
            setFrameIndex: playback.setFrameIndex,
            setPosition: playback.setPosition,
            toggle: playback.toggle,
          }}
          project={project}
          replay={replay}
          scenarioError={scenarioError}
          scenarioProgress={scenarioProgress}
          soundOn={soundOn}
          voiceOn={voiceOn}
        />
      )}
    </>
  );
}

function scenarioTitle(aircraftName: string, scenario: StudioScenarioConfig): string {
  const engine = scenarioRunsOnServer(scenario) ? "live" : "scripted";
  return `${aircraftName} ${engine} ${SCENARIO_TITLE_BY_KIND[scenario.kind]}`;
}

function nextPaint(): Promise<void> {
  if (typeof window === "undefined") return Promise.resolve();
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

const SCENARIO_TITLE_BY_KIND: Record<StudioScenarioConfig["kind"], string> = {
  balloon: "balloon hunt",
  "balloon-hard": "hard balloon intercept",
  "bvr-intercept": "BVR intercept",
  duel: "merge duel",
  "stern-gun": "stern gun start",
};

function scenarioRunsOnServer(scenario: StudioScenarioConfig): boolean {
  return (
    scenario.controlMode === "motor-program" ||
    scenario.kind === "bvr-intercept" ||
    scenario.kind === "balloon-hard" ||
    scenario.pilotModel !== "scripted-body-pilot" ||
    scenario.bodyModel !== "scripted-fixed-wing-body"
  );
}
