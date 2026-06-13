import { clampControlInput, type Action, type ControlInput } from "../protocol/schema";
import type { AircraftState } from "../sim/types";

// Converts an expressed intent into a clamped ControlInput — the only thing the physics
// substrate accepts. This boundary exists on day one (even as a near-passthrough) because it
// is the one place a maneuver-vocabulary adapter can later attach without touching controllers.
export interface ActionAdapter {
  readonly vocabulary: Action["kind"];
  toControlInput(action: Action, self: AircraftState): ControlInput;
}

export const rawStickAdapter: ActionAdapter = {
  vocabulary: "raw-stick",
  toControlInput(action) {
    // clampControlInput (protocol/schema.ts) stays the single control-authority enforcement point.
    return clampControlInput({
      pitch: action.pitch,
      roll: action.roll,
      yaw: action.yaw,
      throttle: action.throttle,
      trigger: action.trigger,
    });
  },
};
