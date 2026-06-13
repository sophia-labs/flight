import { Canvas } from "@react-three/fiber";
import { Pause, Play, RotateCcw, StepBack, StepForward } from "lucide-react";
import { useMemo } from "react";
import { generateDemoMatch } from "./sim/scenario";
import { FlightScene } from "./viewer/FlightScene";
import { ControlsPanel } from "./viewer/ControlsPanel";
import { StatusPanel } from "./viewer/StatusPanel";
import { Timeline } from "./viewer/Timeline";
import { usePlayback } from "./viewer/usePlayback";

export function App() {
  const replay = useMemo(() => generateDemoMatch(), []);
  const playback = usePlayback(replay);
  const frame = replay.frames[playback.frameIndex];

  return (
    <main className="app-shell">
      <section className="simulation">
        <Canvas
          camera={{ position: [0, 5.5, 13], fov: 54, near: 0.1, far: 1200 }}
          shadows
          gl={{ antialias: true, preserveDrawingBuffer: true }}
          data-testid="flight-canvas"
        >
          <FlightScene frame={frame} replay={replay} />
        </Canvas>
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
          <button type="button" className="primary-action" aria-label={playback.playing ? "Pause replay" : "Play replay"} onClick={playback.toggle}>
            {playback.playing ? <Pause size={20} /> : <Play size={20} />}
          </button>
          <button type="button" aria-label="Next frame" onClick={playback.next}>
            <StepForward size={18} />
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
