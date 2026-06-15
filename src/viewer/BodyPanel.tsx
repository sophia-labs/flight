import type { BodyTickTrace, MatchReplay, ReplayFrame } from "../protocol/schema";
import { formatTime } from "./format";

function muscleText(tick: BodyTickTrace) {
  const muscle = tick.parsed.muscle;
  if (!muscle) return "invalid";
  return `R${muscle.roll} P${muscle.pitch} Y${muscle.yaw} U${muscle.push}`;
}

function mismatchText(tick: BodyTickTrace) {
  return tick.mismatch.length > 0 ? tick.mismatch.join(", ") : "matched";
}

export function BodyPanel({
  replay,
  frame,
  pilotId,
}: {
  replay: MatchReplay;
  frame: ReplayFrame;
  pilotId: string;
}) {
  const ticks = (replay.bodyTicks ?? []).filter((tick) => tick.agentId === pilotId);
  let tick: BodyTickTrace | undefined;
  for (const candidate of ticks) {
    if (candidate.time <= frame.time) tick = candidate;
    else break;
  }
  if (!tick) return null;

  return (
    <section className="panel body-panel" aria-label="Body audit">
      <div className="body-panel-head">
        <h2>Body Loop</h2>
        <span className={`body-status status-${tick.parsed.status}`}>{tick.parsed.status}</span>
      </div>

      <div className="body-grid">
        <div>
          <p className="metric-label">Tick</p>
          <div className="metric-value">{formatTime(tick.time)}</div>
        </div>
        <div>
          <p className="metric-label">Muscle</p>
          <div className="metric-value">{muscleText(tick)}</div>
        </div>
        <div>
          <p className="metric-label">Pain</p>
          <div className="metric-value">
            W{tick.proprioception.pain.wingBuffet} P{tick.proprioception.pain.pitchMush} G
            {tick.proprioception.pain.groundRush}
          </div>
        </div>
        <div>
          <p className="metric-label">Mismatch</p>
          <div className="metric-value">{mismatchText(tick)}</div>
        </div>
      </div>

      <p className="body-feel">{tick.parsed.feel ?? "body did not report feeling"}</p>
      <div className="body-sense">
        <p>
          <span>Sense</span> {tick.proprioception.energy} · {tick.proprioception.stallMargin} ·{" "}
          {tick.proprioception.target}
        </p>
        <p>
          <span>Expect</span> {tick.parsed.expect?.roll ?? "-"} / {tick.parsed.expect?.pitch ?? "-"} /{" "}
          {tick.parsed.expect?.speed ?? "-"} / {tick.parsed.expect?.margin ?? "-"}
        </p>
        <p>
          <span>Actual</span> {tick.actual.roll} / {tick.actual.pitch} / {tick.actual.speed} /{" "}
          {tick.actual.margin}
        </p>
        {tick.parsed.memory ? (
          <p>
            <span>Mem</span> {tick.parsed.memory}
          </p>
        ) : null}
      </div>
    </section>
  );
}
