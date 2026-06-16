import { useEffect, useMemo, useRef } from "react";
import type { MatchReplay, ReplayFrame } from "../protocol/schema";
import { activeFlightTranscriptMomentIndex, buildFlightTranscriptMoments } from "../transcript/flightTranscript";

function seekPosition(replay: MatchReplay, time: number): number {
  if (replay.frameDt <= 0) return 0;
  return Math.max(0, Math.min(replay.frames.length - 1, time / replay.frameDt));
}

export function TranscriptPanel({
  replay,
  frame,
  pilotId,
  onSeek,
}: {
  replay: MatchReplay;
  frame: ReplayFrame;
  pilotId: string;
  onSeek: (position: number) => void;
}) {
  const moments = useMemo(
    () => buildFlightTranscriptMoments(replay, { pilotId }),
    [pilotId, replay],
  );
  const activeIndex = activeFlightTranscriptMomentIndex(moments, frame.time);
  const listRef = useRef<HTMLDivElement | null>(null);
  const entryRefs = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (activeIndex < 0) return;
    const list = listRef.current;
    const entry = entryRefs.current[activeIndex];
    if (!list || !entry) return;
    const top = entry.offsetTop - list.offsetTop;
    const bottom = top + entry.offsetHeight;
    if (top < list.scrollTop) {
      list.scrollTop = top;
    } else if (bottom > list.scrollTop + list.clientHeight) {
      list.scrollTop = bottom - list.clientHeight;
    }
  }, [activeIndex]);

  if (moments.length === 0) return null;

  return (
    <section className="panel transcript-panel" aria-label="Flight transcript">
      <div className="transcript-head">
        <h2>Flight Transcript</h2>
        <span>{moments.length} ticks</span>
      </div>
      <div className="transcript-list" ref={listRef}>
        {moments.map((moment, index) => {
          const active = index === activeIndex;
          return (
            <button
              key={`${moment.tick.turn}:${moment.tick.tick}:${moment.tick.time}`}
              ref={(node) => {
                entryRefs.current[index] = node;
              }}
              type="button"
              className={`transcript-entry${active ? " active" : ""}${moment.mismatch.length > 0 ? " has-mismatch" : ""}`}
              aria-current={active ? "step" : undefined}
              onClick={() => onSeek(seekPosition(replay, moment.tick.time))}
            >
              <span className="transcript-entry-top">
                <span>
                  t={moment.tick.time.toFixed(2)}s · Body {moment.tick.tick}
                </span>
                <span className={`body-status status-${moment.tick.parsed.status}`}>
                  {moment.tick.parsed.status}
                </span>
              </span>
              <span className="transcript-read">{moment.read}</span>
              <span className="transcript-detail">
                {moment.geometryText} · {moment.controlMotionText}
              </span>
              <span className="transcript-detail">
                expect {moment.expectText} · actual {moment.actualText}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
