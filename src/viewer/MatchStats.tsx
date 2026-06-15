import type { MatchReplay } from "../protocol/schema";

const pct = (x: number) => `${Math.round(x * 100)}%`;

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <p className="metric-label">{label}</p>
      <div className="metric-value">{value}</div>
    </div>
  );
}

export function MatchStats({ replay, pilotId }: { replay: MatchReplay; pilotId: string }) {
  const outcome = replay.outcome;
  const competence = outcome?.competence?.[pilotId];
  const pilotDecisions = (replay.decisions ?? []).filter((d) => d.agentId === pilotId);
  const pilotCost = pilotDecisions.reduce((sum, d) => sum + (d.usage?.costUsd ?? 0), 0);
  const fallbackRate = pilotDecisions.length
    ? pilotDecisions.filter((d) => d.source === "fallback").length / pilotDecisions.length
    : 0;
  const pilot = replay.agents?.find((a) => a.id === pilotId);
  const bodyTicks = (replay.bodyTicks ?? []).filter((tick) => tick.agentId === pilotId);
  const bodyCost = bodyTicks.reduce((sum, tick) => sum + (tick.usage?.costUsd ?? 0), 0);
  const cost = pilotCost + bodyCost;
  const bodyOkRate = bodyTicks.length
    ? bodyTicks.filter((tick) => tick.parsed.status !== "failed").length / bodyTicks.length
    : 0;

  return (
    <section className="panel" aria-label="Match stats">
      <h2>Match — {pilot?.label ?? pilotId}</h2>
      <div className="metrics">
        <Metric
          label="Outcome"
          value={outcome ? `${outcome.winnerTeam ?? "draw"} · ${outcome.reason}` : "—"}
        />
        <Metric label="Turns" value={outcome ? String(outcome.turnsRun) : "—"} />
        <Metric label="Cost" value={cost > 0 ? `$${cost.toFixed(4)}` : "—"} />
        <Metric label="Fallback" value={pct(fallbackRate)} />
        {bodyTicks.length > 0 ? <Metric label="Body ticks" value={String(bodyTicks.length)} /> : null}
        {bodyTicks.length > 0 ? <Metric label="Body parse" value={pct(bodyOkRate)} /> : null}
        {bodyCost > 0 ? <Metric label="Body cost" value={`$${bodyCost.toFixed(4)}`} /> : null}
      </div>
      {competence ? (
        <div className="metrics">
          <Metric label="Hits / shots" value={`${competence.hits} / ${competence.shots}`} />
          <Metric label="Stalled" value={pct(competence.fracStalled)} />
          <Metric label="On deck" value={pct(competence.fracOnDeck)} />
          <Metric label="Energy kept" value={competence.energyRetainedRatio.toFixed(2)} />
          <Metric label="Smoothness" value={competence.controlSmoothness.toFixed(2)} />
          <Metric label="Min alt" value={`${Math.round(competence.minAltitude)} m`} />
        </div>
      ) : null}
      {fallbackRate >= 1 ? (
        <p className="event-line warn">
          All turns fell back to the safety controller — this model wasn't flying.
        </p>
      ) : null}
    </section>
  );
}
