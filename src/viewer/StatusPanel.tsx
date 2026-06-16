import type { ReplayFrame } from "../protocol/schema";
import {
  formatAltitude,
  formatAngle,
  formatPercent,
  formatSpeed,
  formatTime,
} from "./format";

interface StatusPanelProps {
  frame: ReplayFrame;
}

export function StatusPanel({ frame }: StatusPanelProps) {
  const [blue, red] = frame.aircraft;
  const separation =
    blue && red
      ? Math.hypot(
          blue.position.x - red.position.x,
          blue.position.y - red.position.y,
          blue.position.z - red.position.z,
        )
      : 0;

  return (
    <section className="panel status-grid" aria-label="Aircraft state">
      <h2>Telemetry</h2>
      {frame.aircraft.map((ship) => (
        <article className="aircraft-row" key={ship.id}>
          <span className="swatch" style={{ backgroundColor: ship.color }} />
          <div>
            <h3>{ship.callsign}</h3>
            <p>
              {formatSpeed(ship.airspeed)} · {formatAltitude(ship.altitude)} ·{" "}
              {ship.stalled ? "stall buffet" : `${ship.gLoad.toFixed(1)} g`}
              {ship.mach !== undefined ? ` · M ${ship.mach.toFixed(2)}` : ""}
              {ship.sweepDeg !== undefined ? ` · sweep ${Math.round(ship.sweepDeg)} deg` : ""}
              {ship.engineSpool !== undefined ? ` · spool ${Math.round(ship.engineSpool * 100)}%` : ""}
              {ship.afterburner ? " · AB" : ""}
            </p>
          </div>
          <div className="health">{formatPercent(ship.health)}</div>
        </article>
      ))}

      <div className="metrics">
        <Metric label="Elapsed" value={formatTime(frame.time)} />
        <Metric label="Separation" value={`${Math.round(separation)} m`} />
        <Metric label="Blue AoA" value={blue ? formatAngle(blue.aoaDeg) : "-"} />
        <Metric label="Red AoA" value={red ? formatAngle(red.aoaDeg) : "-"} />
      </div>

      <div className="event-list" aria-label="Frame events">
        {frame.events.length === 0 ? (
          <p className="event-line">No weapons or terrain events this frame.</p>
        ) : (
          frame.events.map((event, index) => (
            <p className="event-line" key={`${event.type}-${index}`}>
              {event.message}
            </p>
          ))
        )}
      </div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <p className="metric-label">{label}</p>
      <div className="metric-value">{value}</div>
    </div>
  );
}
