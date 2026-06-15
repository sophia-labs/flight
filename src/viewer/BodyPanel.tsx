import { useMemo } from "react";
import type { BodyTickTrace, MatchReplay, ReplayFrame } from "../protocol/schema";
import {
  activeFlightTranscriptMomentIndex,
  buildFlightTranscriptMoments,
  type FlightTranscriptMoment,
} from "../transcript/flightTranscript";
import { formatTime } from "./format";

function muscleText(tick: BodyTickTrace) {
  const muscle = tick.parsed.muscle;
  if (!muscle) return "invalid";
  return `R${muscle.roll} P${muscle.pitch} Y${muscle.yaw} U${muscle.push}`;
}

function mismatchText(moment: FlightTranscriptMoment) {
  return moment.mismatch.length > 0 ? moment.mismatch.join(", ") : "matched";
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
  const moments = useMemo(
    () => buildFlightTranscriptMoments(replay, { pilotId }),
    [pilotId, replay],
  );
  const activeIndex = activeFlightTranscriptMomentIndex(moments, frame.time);
  const moment = activeIndex >= 0 ? moments[activeIndex] : undefined;
  if (!moment) return null;
  const tick = moment.tick;

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
          <div className="metric-value">{mismatchText(moment)}</div>
        </div>
        <div>
          <p className="metric-label">Motion</p>
          <div className="metric-value">{moment.controlMotionText}</div>
        </div>
        {tick.latencyMs !== undefined ? (
          <div>
            <p className="metric-label">Latency</p>
            <div className="metric-value">{Math.round(tick.latencyMs)} ms</div>
          </div>
        ) : null}
        {tick.usage ? (
          <div>
            <p className="metric-label">Call cost</p>
            <div className="metric-value">${tick.usage.costUsd.toFixed(5)}</div>
          </div>
        ) : null}
      </div>

      <p className="body-feel">{tick.modelError ?? tick.parsed.feel ?? "body did not report feeling"}</p>
      <div className="body-sense">
        <p>
          <span>Sense</span> {tick.proprioception.energy} · {tick.proprioception.stallMargin} ·{" "}
          {tick.proprioception.terrain}
        </p>
        <p>
          <span>Expect</span> {tick.parsed.expect?.roll ?? "-"} / {tick.parsed.expect?.pitch ?? "-"} /{" "}
          {tick.parsed.expect?.speed ?? "-"} / {tick.parsed.expect?.margin ?? "-"}
        </p>
        <p>
          <span>Actual</span> {tick.actual.roll} / {tick.actual.pitch} / {tick.actual.speed} /{" "}
          {tick.actual.margin}
        </p>
        <p>
          <span>Read</span> {moment.read}
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
