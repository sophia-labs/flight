import {
  clampControlInput,
  type Action,
  type ControlInput,
  type FlightDirectorAction,
  type RawStickAction,
  type SetpointAction,
} from "../protocol/schema";
import { basisFromQuat, clamp, cross, dot, length, normalize, scale, sub, vec3 } from "../sim/math";
import type { AircraftState } from "../sim/types";

// Converts an expressed intent into a clamped ControlInput. Called once PER FRAME (15×/turn), so
// a closed-loop adapter can track a setpoint and protect the flight envelope as state evolves.
// raw-stick ignores state and returns the same stick every frame (behaviour identical to v0.2).
export interface ActionAdapter {
  readonly vocabulary: Action["kind"];
  controlFor(action: Action, self: AircraftState): ControlInput;
}

export const rawStickAdapter: ActionAdapter = {
  vocabulary: "raw-stick",
  controlFor(action) {
    const a = action as RawStickAction;
    return clampControlInput({
      pitch: a.pitch,
      roll: a.roll,
      yaw: a.yaw,
      throttle: a.throttle,
      trigger: a.trigger,
    });
  },
};

const DEG = Math.PI / 180;
// PD attitude hold. On the v0.7.0 surface-force plant (stick -> surface force -> torque -> omega ->
// attitude is 2nd-order), a pure-P loop would PIO, so each axis subtracts a rate-damping term that
// reads the true body angular velocity.
const KP_BANK = 1.2;
const KD_BANK = 0.45;
const KP_PITCH = 1.4;
const KD_PITCH = 0.7;
const KP_LOAD = 0.34;
const KD_LOAD = 0.28;

function attitude(self: AircraftState) {
  const basis = basisFromQuat(self.orientation);
  const worldUp = vec3(0, 1, 0);

  // Bank: signed angle (about the nose) from the level reference-up to the body up.
  const refUp = normalize(sub(worldUp, scale(basis.forward, dot(worldUp, basis.forward))), basis.up);
  const bankRad = Math.atan2(dot(cross(refUp, basis.up), basis.forward), dot(refUp, basis.up));
  // Pitch attitude relative to the horizon.
  const pitchRad = Math.asin(clamp(basis.forward.y, -1, 1));
  return { basis, bankRad, pitchRad };
}

function protectPitchCommand(pitchCmd: number, throttle: number, self: AircraftState) {
  const { basis } = attitude(self);
  const speed = length(self.velocity);
  const forwardSpeed = dot(self.velocity, basis.forward);
  const bodyVertical = dot(self.velocity, basis.up);
  const aoa = Math.atan2(-bodyVertical, Math.max(Math.abs(forwardSpeed), 1));
  const stall = self.model.stallAoARad;
  const margin = stall * 0.82;
  let protectedPitch = pitchCmd;
  let protectedThrottle = throttle;

  if (protectedPitch > 0 && aoa > margin) {
    protectedPitch *= clamp(1 - (aoa - margin) / Math.max(stall - margin, 1e-3), 0, 1);
  }
  if (aoa > stall * 1.05 || self.metrics.stalled) {
    protectedPitch = Math.min(protectedPitch, -0.38);
    protectedThrottle = Math.max(protectedThrottle, 0.95);
  }
  // Low-energy recovery: if slow, stop pulling and add power to rebuild speed.
  if (speed < 68) {
    protectedPitch = Math.min(protectedPitch, 0.08);
    protectedThrottle = Math.max(protectedThrottle, 0.92);
  } else if (speed < 112) {
    protectedPitch = Math.min(protectedPitch, 0.18);
    protectedThrottle = Math.max(protectedThrottle, 0.9);
  }

  return { pitch: protectedPitch, throttle: protectedThrottle };
}

// Setpoint adapter: the agent commands a target bank + pitch attitude (and throttle/trigger), and
// this attitude-hold loop produces the stick each frame — feathering toward the setpoint and
// refusing to drive past the stall (the thing the raw-stick LLM pilot couldn't do for itself).
export const setpointAdapter: ActionAdapter = {
  vocabulary: "setpoint",
  controlFor(action, self) {
    const a = action as SetpointAction;
    const { bankRad, pitchRad } = attitude(self);

    // Rate-damping (D) term: angularVelocity.x = body roll rate, .y = body pitch rate.
    const rollRate = self.angularVelocity.x;
    const pitchRate = self.angularVelocity.y;
    let rollCmd = clamp((a.targetBankDeg * DEG - bankRad) * KP_BANK - rollRate * KD_BANK, -1, 1);
    let pitchCmd = clamp((a.targetPitchDeg * DEG - pitchRad) * KP_PITCH - pitchRate * KD_PITCH, -1, 1);
    let throttle = a.throttle;

    ({ pitch: pitchCmd, throttle } = protectPitchCommand(pitchCmd, throttle, self));

    return clampControlInput({ pitch: pitchCmd, roll: rollCmd, yaw: 0, throttle, trigger: a.trigger });
  },
};

export const flightDirectorAdapter: ActionAdapter = {
  vocabulary: "flight-director",
  controlFor(action, self) {
    const a = action as FlightDirectorAction;
    const { bankRad } = attitude(self);
    const rollRate = self.angularVelocity.x;
    const pitchRate = self.angularVelocity.y;
    const rollCmd = clamp((a.targetBankDeg * DEG - bankRad) * KP_BANK - rollRate * KD_BANK, -1, 1);
    const loadError = clamp(a.targetLoadG, -0.5, 7.5) - self.metrics.gLoad;
    let pitchCmd = clamp(loadError * KP_LOAD - pitchRate * KD_LOAD, -1, 1);
    let throttle =
      a.speedPriority === "gain"
        ? Math.max(a.throttle, 0.92)
        : a.speedPriority === "bleed"
          ? Math.min(a.throttle, 0.48)
          : a.throttle;

    ({ pitch: pitchCmd, throttle } = protectPitchCommand(pitchCmd, throttle, self));

    return clampControlInput({ pitch: pitchCmd, roll: rollCmd, yaw: 0, throttle, trigger: a.trigger });
  },
};

const ADAPTERS: Record<Action["kind"], ActionAdapter> = {
  "raw-stick": rawStickAdapter,
  setpoint: setpointAdapter,
  "flight-director": flightDirectorAdapter,
};

export function adapterFor(kind: Action["kind"]): ActionAdapter {
  return ADAPTERS[kind];
}
