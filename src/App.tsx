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
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { MatchReplaySchema, type MatchReplay } from "./protocol/schema";
import { generateDemoMatch } from "./runtime/scenario";
import { FlightScene, type CameraMode } from "./viewer/FlightScene";
import { ControlsPanel } from "./viewer/ControlsPanel";
import { StatusPanel } from "./viewer/StatusPanel";
import { Timeline } from "./viewer/Timeline";
import { useReplayAudio } from "./viewer/useReplayAudio";
import { usePlayback } from "./viewer/usePlayback";

export function App() {
  const [replay, setReplay] = useState<MatchReplay | null>(null);
  const [cameraMode, setCameraMode] = useState<CameraMode>("orbit");
  const [captionsOn, setCaptionsOn] = useState(true);
  const [soundOn, setSoundOn] = useState(false);
  const [voiceOn, setVoiceOn] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Prefer a recorded match dropped into public/ (e.g. the LLM pilot's flight); otherwise
      // generate a fresh scripted demo in-browser.
      try {
        const response = await fetch("/match.json");
        if (response.ok) {
          const parsed = MatchReplaySchema.parse(await response.json());
          if (!cancelled) {
            setReplay(parsed);
            return;
          }
        }
      } catch {
        // no recorded match available — fall through to the generated demo
      }
      const demo = await generateDemoMatch();
      if (!cancelled) setReplay(demo);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const playback = usePlayback(replay);
  const frame = replay?.frames[playback.frameIndex];

  // The pilot is whichever seat an LLM flew (falls back to blue). Its per-turn rationale is the
  // subtitle / narration track.
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

  // Speak the pilot's current thought when the line changes.
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
          <p className="event-line">Generating match…</p>
        </aside>
      </main>
    );
  }

  return (
    <main className="app-shell">
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
          <div className="turn-pill">Turn {frame.turn}</div>
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

        <StatusPanel frame={frame} />
        <ControlsPanel frame={frame} />
      </aside>
    </main>
  );
}
