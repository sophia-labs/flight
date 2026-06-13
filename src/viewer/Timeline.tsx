import { formatTime } from "./format";

interface TimelineProps {
  frameIndex: number;
  frameCount: number;
  onChange: (frameIndex: number) => void;
}

export function Timeline({ frameIndex, frameCount, onChange }: TimelineProps) {
  return (
    <section className="panel timeline" aria-label="Replay timeline">
      <div className="timeline-labels">
        <span>{formatTime(frameIndex * 0.16)}</span>
        <span>
          Frame {frameIndex + 1} / {frameCount}
        </span>
      </div>
      <input
        aria-label="Replay frame"
        min={0}
        max={frameCount - 1}
        value={frameIndex}
        type="range"
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </section>
  );
}
