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
  const [samplePosition, setSamplePositionState] = useState(0);
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
  const lastReplay = useRef<MatchReplay | null>(null);

  useEffect(() => {
    clock.framesPerSecond = framesPerSecond;
    clock.maxIndex = maxIndex;
    if (lastReplay.current !== replay) {
      // New match selected — rewind to the start and keep playing.
      lastReplay.current = replay;
      clock.position = 0;
      setFrameIndexState(0);
      setSamplePositionState(0);
    } else if (clock.position > maxIndex) {
      clock.position = maxIndex;
    }
  }, [clock, framesPerSecond, maxIndex, replay]);

  // Move the clock to a discrete frame (scrub / step).
  const seek = useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(clock.maxIndex, Math.round(next)));
      clock.position = clamped;
      setFrameIndexState(clamped);
      setSamplePositionState(clamped);
    },
    [clock],
  );

  // The render loop reports the integer frame for the React UI (panels, timeline) at tick rate.
  const reportIndex = useCallback((index: number) => {
    setFrameIndexState((current) => (current === index ? current : index));
  }, []);

  // The render loop also reports the fractional position for smooth cockpit instruments and HUD.
  const reportSample = useCallback((position: number) => {
    setSamplePositionState((current) => (Math.abs(current - position) < 0.01 ? current : position));
  }, []);

  const setPosition = useCallback(
    (next: number, nextPlaying = clock.playing) => {
      const clamped = Math.max(0, Math.min(clock.maxIndex, next));
      clock.position = clamped;
      clock.playing = nextPlaying;
      setPlayingState(nextPlaying);
      setFrameIndexState(Math.floor(clamped));
      setSamplePositionState(clamped);
    },
    [clock],
  );

  const restart = useCallback(() => {
    clock.position = 0;
    clock.playing = true;
    setFrameIndexState(0);
    setSamplePositionState(0);
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
    samplePosition,
    playing,
    clock,
    reportIndex,
    reportSample,
    setPosition,
    setFrameIndex: seek,
    restart,
    next,
    previous,
    toggle,
  };
}
