import type { ControlInput, Part, SurfaceControlSnapshot } from "../protocol/schema";

const MAX_DEFLECTION_DEG = 0.24 * (180 / Math.PI);

function controlEffectiveness(area: number | undefined, totalArea: number): number {
  if (!area || totalArea <= 0) return 0;
  const fraction = Math.min(1.4, Math.max(0, area / totalArea));
  return Math.min(0.34, Math.max(0.06, 0.06 + fraction * 0.24));
}

function snapshot(
  id: string,
  axis: SurfaceControlSnapshot["axis"],
  sign: number,
  controls: ControlInput,
  effectiveness: number,
): SurfaceControlSnapshot {
  const input = controls[axis];
  const deflectionDeg = input * sign * MAX_DEFLECTION_DEG;
  return {
    id,
    axis,
    input,
    deflectionDeg,
    effectiveAoADeg: deflectionDeg * effectiveness,
  };
}

export function deriveSurfaceControls(
  parts: Part[],
  controls: ControlInput,
): SurfaceControlSnapshot[] {
  const surfaces: SurfaceControlSnapshot[] = [];

  for (const part of parts) {
    if (part.kind !== "wing" || !part.control) continue;

    const area = part.planform.span * part.planform.chord;
    const effectiveness = controlEffectiveness(part.control.area, area);

    if (part.control.axis === "roll") {
      surfaces.push(snapshot(`${part.id}-left`, "roll", 1, controls, effectiveness));
      surfaces.push(snapshot(`${part.id}-right`, "roll", -1, controls, effectiveness));
      continue;
    }

    surfaces.push(snapshot(part.id, part.control.axis, -1, controls, effectiveness));
  }

  return surfaces;
}
