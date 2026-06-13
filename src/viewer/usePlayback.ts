import { useCallback, useEffect, useRef, useState } from "react";
import type { MatchReplay } from "../protocol/schema";

// A continuous playback clock. `position` is a fractional frame index advanced at 60fps by the
// scene's render loop (see SceneDriver), so the 3D view interpolates between the ~6 discrete
// recorded states per second instead of snapping to them.
export interface PlaybackClock {
  position: number;
  playing: boolean;
  framesPerSecond: number;
  maxIndex: number;
}

export function usePlayback(replay: MatchReplay | null) {
  const [frameIndex, setFrameIndexState] = useState(0);
  const [playing, setPlayingState] = useState(true);

  const maxIndex = replay ? replay.frames.length - 1 : 0;
  const framesPerSecond = replay ? 1 / replay.frameDt : 6.25;

  const clockRef = useRef<PlaybackClock>({
    position: 0,
    playing: true,
    framesPerSecond: 6.25,
    maxIndex: 0,
  });
  const clock = clockRef.current;

  useEffect(() => {
    clock.framesPerSecond = framesPerSecond;
    clock.maxIndex = maxIndex;
    if (clock.position > maxIndex) clock.position = maxIndex;
  }, [clock, framesPerSecond, maxIndex]);

  // Move the clock to a discrete frame (scrub / step).
  const seek = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(clock.maxIndex, Math.round(next)));
      clock.position = clamped;
      setFrameIndexState(clamped);
    },
    [clock],
  );

  // The render loop reports the integer frame for the React UI (panels, timeline) at tick rate.
  const reportIndex = useCallback((index: number) => {
    setFrameIndexState((current) => (current === index ? current : index));
  }, []);

  const restart = useCallback(() => {
    clock.position = 0;
    clock.playing = true;
    setFrameIndexState(0);
    setPlayingState(true);
  }, [clock]);

  const next = useCallback(() => seek(Math.floor(clock.position) + 1), [seek, clock]);
  const previous = useCallback(() => seek(Math.ceil(clock.position) - 1), [seek, clock]);

  const toggle = useCallback(() => {
    setPlayingState((current) => {
      const nextPlaying = !current;
      clock.playing = nextPlaying;
      return nextPlaying;
    });
  }, [clock]);

  return {
    frameIndex,
    playing,
    clock,
    reportIndex,
    setFrameIndex: seek,
    restart,
    next,
    previous,
    toggle,
  };
}
