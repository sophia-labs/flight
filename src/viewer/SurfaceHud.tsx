import type { MatchReplay, ReplayFrame, SurfaceControlSnapshot } from "../protocol/schema";
import { defaultAirframe } from "../sim/airframe";
import { deriveSurfaceControls } from "./surfaceTelemetry";

interface SurfaceHudProps {
  frame: ReplayFrame;
  replay: MatchReplay;
  pilotId: string;
  visible: boolean;
}

const AXIS_ORDER: Record<SurfaceControlSnapshot["axis"], number> = {
  roll: 0,
  pitch: 1,
  yaw: 2,
};

export function SurfaceHud({ frame, replay, pilotId, visible }: SurfaceHudProps) {
  if (!visible) return null;

  const ship = frame.aircraft.find((candidate) => candidate.id === pilotId) ?? frame.aircraft[0];
  if (!ship) return null;

  const parts = replay.airframes?.[ship.id]?.parts ?? defaultAirframe().parts;
  const surfaces = [...(ship.surfaceControls ?? deriveSurfaceControls(parts, ship.controls))].sort((a, b) => {
    const byAxis = AXIS_ORDER[a.axis] - AXIS_ORDER[b.axis];
    return byAxis !== 0 ? byAxis : a.id.localeCompare(b.id);
  });

  return (
    <aside className="surface-hud" aria-label="Control surface HUD">
      <div className="surface-hud-topline">
        <span>{ship.callsign}</span>
        <span>{ship.stalled ? "BUFFET" : `${ship.gLoad.toFixed(1)} g`}</span>
      </div>

      <div className="surface-hud-inputs" aria-label="Cockpit controls">
        <ControlReadout label="STK" value={`${ship.controls.roll.toFixed(2)}, ${ship.controls.pitch.toFixed(2)}`} />
        <ControlReadout label="PED" value={signed(ship.controls.yaw, 2)} />
        <ControlReadout label="THR" value={`${Math.round(ship.controls.throttle * 100)}%`} />
      </div>

      <div className="surface-hud-surfaces">
        {surfaces.length === 0 ? (
          <p className="surface-hud-empty">No surface telemetry</p>
        ) : (
          surfaces.map((surface) => <SurfaceRow key={surface.id} surface={surface} />)
        )}
      </div>
    </aside>
  );
}

function ControlReadout({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SurfaceRow({ surface }: { surface: SurfaceControlSnapshot }) {
  const magnitude = Math.min(Math.abs(surface.deflectionDeg) / 14, 1) * 50;
  const flowAoA = surface.totalAoADeg ?? surface.localAoADeg;
  const hot = (surface.stallSeverity ?? 0) > 0.2;
  const fillStyle =
    surface.deflectionDeg >= 0
      ? { left: "50%", width: `${magnitude}%` }
      : { left: `${50 - magnitude}%`, width: `${magnitude}%` };

  return (
    <div className={`surface-row${hot ? " surface-row-hot" : ""}`}>
      <span className="surface-label">{surfaceLabel(surface)}</span>
      <div className="surface-bar" aria-hidden="true">
        <span style={fillStyle} />
      </div>
      <span className="surface-values">
        <span>hinge {signed(surface.deflectionDeg, 1)} deg</span>
        <span>ctrl {signed(surface.effectiveAoADeg, 1)} deg</span>
        <span>{flowAoA === undefined ? "flow --" : `flow ${signed(flowAoA, 1)} deg`}</span>
        <span>{surface.loadN === undefined ? "load --" : formatLoad(surface.loadN)}</span>
      </span>
    </div>
  );
}

function surfaceLabel(surface: SurfaceControlSnapshot): string {
  if (surface.axis === "roll") {
    if (surface.id.endsWith("-left")) return "AIL L";
    if (surface.id.endsWith("-right")) return "AIL R";
    return "AIL";
  }
  if (surface.axis === "pitch") return "ELEV";
  if (surface.axis === "yaw") return "RUD";
  return surface.id.slice(0, 6).toUpperCase();
}

function signed(value: number, digits: number): string {
  const fixed = value.toFixed(digits);
  return value > 0 ? `+${fixed}` : fixed;
}

function formatLoad(valueN: number): string {
  if (Math.abs(valueN) >= 1_000) return `load ${(valueN / 1_000).toFixed(1)} kN`;
  return `load ${Math.round(valueN)} N`;
}
