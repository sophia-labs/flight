import { useCallback, useEffect, useState } from "react";
import type { MatchReplay } from "../protocol/schema";

export function usePlayback(replay: MatchReplay) {
  const [frameIndex, setFrameIndexState] = useState(0);
  const [playing, setPlaying] = useState(true);
  const maxIndex = replay.frames.length - 1;

  const setFrameIndex = useCallback(
    (next: number) => {
      setFrameIndexState(Math.max(0, Math.min(maxIndex, next)));
    },
    [maxIndex],
  );

  const restart = useCallback(() => {
    setFrameIndex(0);
    setPlaying(true);
  }, [setFrameIndex]);

  const next = useCallback(() => {
    setFrameIndexState((current) => Math.min(maxIndex, current + 1));
  }, [maxIndex]);

  const previous = useCallback(() => {
    setFrameIndexState((current) => Math.max(0, current - 1));
  }, []);

  const toggle = useCallback(() => {
    setPlaying((current) => !current);
  }, []);

  useEffect(() => {
    if (!playing) {
      return undefined;
    }

    const interval = window.setInterval(() => {
      setFrameIndexState((current) => {
        if (current >= maxIndex) {
          return 0;
        }

        return current + 1;
      });
    }, 72);

    return () => window.clearInterval(interval);
  }, [maxIndex, playing]);

  return {
    frameIndex,
    playing,
    setFrameIndex,
    restart,
    next,
    previous,
    toggle,
  };
}
