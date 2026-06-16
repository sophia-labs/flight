import { useCallback, useEffect, useMemo, useState } from "react";
import type { MatchReplay } from "./protocol/schema";
import { generateAirframeMatch } from "./runtime/scenario";
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
  updatePilotProfile,
} from "./studio/project";
import type { PilotProfile, StudioMode, StudioProject } from "./studio/schema";
import { loadStudioProject, saveStudioProject } from "./studio/store";
import type { CameraMode } from "./viewer/FlightScene";
import { HangarScreen } from "./viewer/HangarScreen";
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

export function App() {
  const [project, setProject] = useState<StudioProject>(() => loadStudioProject());
  const [cameraMode, setCameraMode] = useState<CameraMode>(() => queryCameraMode());
  const [hudOn, setHudOn] = useState(() => queryFlag("hud", true));
  const [captionsOn, setCaptionsOn] = useState(() => queryFlag("captions", true));
  const [soundOn, setSoundOn] = useState(() => queryFlag("sound", false));
  const [voiceOn, setVoiceOn] = useState(() => queryFlag("voice", false));
  const [builderOpen, setBuilderOpen] = useState(false);
  const [launching, setLaunching] = useState(false);

  const activeSession = useMemo(() => getActiveSession(project), [project]);
  const activeAircraft = useMemo(() => getActiveAircraft(project, activeSession), [project, activeSession]);
  const activePilot = useMemo(() => getActivePilot(project, activeSession), [project, activeSession]);
  const activeReplay = useMemo(() => getActiveReplay(project, activeSession), [project, activeSession]);
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
    setLaunching(true);
    try {
      const built = await generateAirframeMatch(aircraft.airframe);
      addReplayToProject(built, `${aircraft.name} sortie`, aircraft.id, session.id);
      setCameraMode("pilot-cinema");
    } finally {
      setLaunching(false);
    }
  }, [activeAircraft, activeSession, addReplayToProject, launching]);

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
      <StudioScreen
        activeAircraft={activeAircraft}
        activeArchetype={activeArchetype}
        activePilot={activePilot}
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
        soundOn={soundOn}
        voiceOn={voiceOn}
      />
    </>
  );
}
