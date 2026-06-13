import { clampControlInput, type ControlInput } from "../protocol/schema";
import { basisFromQuat, clamp, dot, length, normalize, sub } from "./math";
import type { AircraftState } from "./types";

export function choosePursuitControls(
  ownship: AircraftState,
  target: AircraftState,
  aggression: number,
): ControlInput {
  const basis = basisFromQuat(ownship.orientation);
  const relative = sub(target.position, ownship.position);
  const range = length(relative);
  const direction = normalize(relative);
  const targetRight = dot(direction, basis.right);
  const targetUp = dot(direction, basis.up);
  const targetForward = dot(direction, basis.forward);
  const closure = dot(sub(target.velocity, ownship.velocity), direction);
  const leadBias = clamp(closure / 180, -0.28, 0.28);
  const desiredThrottle = range > 850 ? 0.97 : range < 420 && closure < -25 ? 0.46 : 0.76;

  return clampControlInput({
    pitch: clamp(targetUp * 3.2 + leadBias * 0.25, -1, 1),
    roll: clamp(targetRight * (2.35 + aggression * 0.5), -1, 1),
    yaw: clamp(targetRight * 1.2, -1, 1),
    throttle: desiredThrottle,
    trigger: targetForward > 0.975 && Math.abs(targetRight) < 0.13 && Math.abs(targetUp) < 0.13 && range < 1_050,
  });
}

export function chooseDefensiveControls(
  ownship: AircraftState,
  target: AircraftState,
  phase: number,
): ControlInput {
  const attack = choosePursuitControls(ownship, target, 0.64);
  const weave = Math.sin(phase * 0.9) * 0.34;
  const vertical = Math.cos(phase * 0.7) * 0.22;

  return clampControlInput({
    ...attack,
    pitch: clamp(attack.pitch + vertical, -1, 1),
    roll: clamp(attack.roll + weave, -1, 1),
    throttle: Math.max(0.68, attack.throttle),
  });
}
