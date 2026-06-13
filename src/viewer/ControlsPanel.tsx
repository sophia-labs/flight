import type { AircraftSnapshot, ReplayFrame } from "../protocol/schema";

interface ControlsPanelProps {
  frame: ReplayFrame;
}

export function ControlsPanel({ frame }: ControlsPanelProps) {
  return (
    <section className="panel control-list" aria-label="Agent controls">
      <h2>Control Inputs</h2>
      {frame.aircraft.map((ship) => (
        <ControlCard key={ship.id} ship={ship} />
      ))}
    </section>
  );
}

function ControlCard({ ship }: { ship: AircraftSnapshot }) {
  const dotLeft = ((ship.controls.roll + 1) / 2) * 100;
  const dotTop = (1 - (ship.controls.pitch + 1) / 2) * 100;
  const rudder = ((ship.controls.yaw + 1) / 2) * 100;

  return (
    <article className="stick-card">
      <div className="stick-pad" aria-label={`${ship.callsign} virtual joystick`}>
        <span
          className="stick-dot"
          style={{
            left: `${dotLeft}%`,
            top: `${dotTop}%`,
            backgroundColor: ship.color,
            color: ship.color,
          }}
        />
      </div>
      <div>
        <div className="aircraft-row" style={{ gridTemplateColumns: "12px 1fr auto" }}>
          <span className="swatch" style={{ backgroundColor: ship.color }} />
          <div>
            <h3>{ship.callsign}</h3>
            <p>
              Stick {ship.controls.roll.toFixed(2)}, {ship.controls.pitch.toFixed(2)}
            </p>
          </div>
          <div className="health">{ship.controls.trigger ? "FIRE" : "SAFE"}</div>
        </div>
        <div className="metric" style={{ marginTop: 8 }}>
          <p className="metric-label">Throttle</p>
          <div className="bar" aria-hidden="true">
            <span
              style={{
                width: `${ship.controls.throttle * 100}%`,
                backgroundColor: ship.color,
              }}
            />
          </div>
        </div>
        <div className="metric" style={{ marginTop: 8 }}>
          <p className="metric-label">Rudder</p>
          <div className="bar" aria-hidden="true">
            <span
              style={{
                width: `${rudder}%`,
                backgroundColor: ship.color,
              }}
            />
          </div>
        </div>
      </div>
    </article>
  );
}
