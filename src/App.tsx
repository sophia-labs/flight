import { Canvas } from "@react-three/fiber";
import {
  Captions,
  Mic,
  Orbit,
  Pause,
  Plane,
  Play,
  RotateCcw,
  StepBack,
  StepForward,
  Volume2,
  Wrench,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { z } from "zod";
import {
  MatchReplaySchema,
  MatchSummarySchema,
  type MatchReplay,
  type MatchSummary,
} from "./protocol/schema";
import { generateDemoMatch } from "./runtime/scenario";
import { ControlsPanel } from "./viewer/ControlsPanel";
import { FlightScene, type CameraMode } from "./viewer/FlightScene";
import { HangarScreen } from "./viewer/HangarScreen";
import { MatchBrowser } from "./viewer/MatchBrowser";
import { MatchStats } from "./viewer/MatchStats";
import { StatusPanel } from "./viewer/StatusPanel";
import { Timeline } from "./viewer/Timeline";
import { usePlayback } from "./viewer/usePlayback";
import { useReplayAudio } from "./viewer/useReplayAudio";

export function App() {
  const [matches, setMatches] = useState<MatchSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [replay, setReplay] = useState<MatchReplay | null>(null);
  const [cameraMode, setCameraMode] = useState<CameraMode>("orbit");
  const [screen, setScreen] = useState<"flight" | "hangar">("flight");
  const [captionsOn, setCaptionsOn] = useState(true);
  const [soundOn, setSoundOn] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);
  const requestRef = useRef(0);

  // Source preference: sweep manifest (browser) → single recorded match.json → generated demo.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const indexRes = await fetch("/matches/index.json");
        if (indexRes.ok) {
          const list = z.array(MatchSummarySchema).parse(await indexRes.json());
          if (list.length > 0) {
            const first = list[0];
            const replayRes = await fetch(`/matches/${first.file}`);
            const parsed = MatchReplaySchema.parse(await replayRes.json());
            if (!cancelled) {
              setMatches(list);
              setSelectedId(first.id);
              setReplay(parsed);
            }
            return;
          }
        }
      } catch {
        // no sweep manifest — fall through
      }
      try {
        const single = await fetch("/match.json");
        if (single.ok) {
          const parsed = MatchReplaySchema.parse(await single.json());
          if (!cancelled) setReplay(parsed);
          return;
        }
      } catch {
        // no recorded match — fall through
      }
      const demo = await generateDemoMatch();
      if (!cancelled) setReplay(demo);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const selectMatch = useCallback((match: MatchSummary) => {
    setSelectedId(match.id);
    const req = (requestRef.current += 1);
    fetch(`/matches/${match.file}`)
      .then((res) => res.json())
      .then((json) => {
        if (requestRef.current === req) setReplay(MatchReplaySchema.parse(json));
      })
      .catch(() => {});
  }, []);

  // A freshly-built airframe was flown in the hangar: show its replay (a one-off, not from the browser).
  const onFlyBuild = useCallback((built: MatchReplay) => {
    setSelectedId(null);
    setReplay(built);
    setScreen("flight");
  }, []);

  const playback = usePlayback(replay);
  const frame = replay
    ? replay.frames[Math.min(playback.frameIndex, replay.frames.length - 1)]
    : undefined;

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

  const hasBrowser = matches.length > 0;

  if (!replay || !frame) {
    return (
      <main className="app-shell">
        <section className="simulation" />
        <aside className="control-rail" aria-label="Match controls">
          <header className="rail-header">
            <div>
              <p className="eyebrow">Flight Duel</p>
              <h1>Physics Turn Lab</h1>
            </div>
          </header>
          <p className="event-line">Loading matches…</p>
        </aside>
      </main>
    );
  }

  return (
    <>
    {screen === "hangar" ? (
      <HangarScreen onExit={() => setScreen("flight")} onFly={onFlyBuild} />
    ) : null}
    <main className={`app-shell${hasBrowser ? " with-browser" : ""}`}>
      {hasBrowser ? (
        <MatchBrowser matches={matches} selectedId={selectedId} onSelect={selectMatch} />
      ) : null}

      <section className="simulation">
        <Canvas
          camera={{ position: [0, 5.5, 13], fov: 54, near: 0.1, far: 1200 }}
          shadows
          gl={{ antialias: true, preserveDrawingBuffer: true }}
          data-testid="flight-canvas"
        >
          <FlightScene
            frame={frame}
            replay={replay}
            cameraMode={cameraMode}
            pilotId={pilotId}
            clock={playback.clock}
            onIndex={playback.reportIndex}
          />
        </Canvas>

        {captionsOn && caption ? (
          <div className="subtitle" key={caption}>
            <span className="subtitle-speaker">Claude</span>
            {caption}
          </div>
        ) : null}
      </section>

      <aside className="control-rail" aria-label="Match controls">
        <header className="rail-header">
          <div>
            <p className="eyebrow">Flight Duel</p>
            <h1>Physics Turn Lab</h1>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <button
              type="button"
              className="hangar-open"
              onClick={() => setScreen("hangar")}
              title="Build your own aircraft"
            >
              <Wrench size={15} /> Hangar
            </button>
            <div className="turn-pill">Turn {frame.turn}</div>
          </div>
        </header>

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

        <div className="view-toggle" role="group" aria-label="Camera view">
          <button
            type="button"
            className={cameraMode === "orbit" ? "active" : ""}
            aria-pressed={cameraMode === "orbit"}
            onClick={() => setCameraMode("orbit")}
          >
            <Orbit size={16} /> Orbit
          </button>
          <button
            type="button"
            className={cameraMode === "cabin" ? "active" : ""}
            aria-pressed={cameraMode === "cabin"}
            onClick={() => setCameraMode("cabin")}
            title="Claude's cabin — pilot's-seat view of the blue aircraft"
          >
            <Plane size={16} /> Cabin
          </button>
        </div>

        <div className="av-toggle" role="group" aria-label="Captions and audio">
          <button
            type="button"
            className={captionsOn ? "active" : ""}
            aria-pressed={captionsOn}
            onClick={() => setCaptionsOn((on) => !on)}
            title="Subtitles: the pilot's per-turn reasoning"
          >
            <Captions size={16} /> CC
          </button>
          <button
            type="button"
            className={soundOn ? "active" : ""}
            aria-pressed={soundOn}
            onClick={() => setSoundOn((on) => !on)}
            title="Synthesized engine + weapon sound"
          >
            <Volume2 size={16} /> Sound
          </button>
          <button
            type="button"
            className={voiceOn ? "active" : ""}
            aria-pressed={voiceOn}
            onClick={() => setVoiceOn((on) => !on)}
            title="Speak the pilot's reasoning aloud"
          >
            <Mic size={16} /> Voice
          </button>
        </div>

        <Timeline
          frameIndex={playback.frameIndex}
          frameCount={replay.frames.length}
          onChange={playback.setFrameIndex}
        />

        {hasBrowser ? <MatchStats replay={replay} pilotId={pilotId} /> : null}
        <StatusPanel frame={frame} />
        <ControlsPanel frame={frame} />
      </aside>
    </main>
    </>
  );
}
