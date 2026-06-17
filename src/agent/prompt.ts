import type { ActionSpec } from "./actionSpec";
import type { AgentMessage, AgentNavigationFix } from "../protocol/schema";

export const OBSERVATION_FIELD_GUIDE = `Observation fields:
- self: airspeed (m/s), altitude (m), aoaDeg (angle of attack; the wing stalls past ~24 deg), gLoad, health (0-100), weaponCooldown (seconds; 0 means you can fire), stalled (bool).
- self.missileLoaded means a heat-seeking FOX-2 is loaded. self.radarMissileLoaded means an active-radar BVR missile is loaded.
- contacts are sensor-visible enemies, ego-relative: range (m); bearingForward (1 = dead ahead, 0 = abeam, negative = behind); bearingRight (+ = to your right); bearingUp (+ = above you); closureRate (+ = opening, - = closing); health. contact.missileLock means a FOX-2 fired now has IR lock; contact.radarLock means an active-radar missile fired now has a radar weapon solution.
- messages is the prompt-readable comms stream. comms, when present, is the typed version with sender, channel, priority, and optional navigation.
- comms.navigation is a local-world navigation fix. headingDeg and bearingDeg are true bearings clockwise from north; compass is the nearest 16-point compass label. GPS coordinates appear as decimal latitude/longitude. Use navigation.waypoints as offboard tasking such as a GCI target datum; it is not a sensor contact until contacts includes it.
- text, when present, is a cockpit camera-ascii@2 view. The + at grid center is the gun boresight/pipper; use the grid and legend as visual input for line-up and aiming geometry.`;

export const SIGN_DISCIPLINE_GUIDE = `Sign discipline:
- bearingRight > 0 means target right; bearingRight < 0 means target left.
- bearingUp > 0 means target above the nose/pipper; bearingUp < 0 means target below the nose/pipper.
- In the ASCII legend, "high" means above the pipper and "low" means below it. Keep the target near 12 o'clock level for guns; do not overfly it vertically.`;

export function buildPilotSystemPrompt(input: {
  roleRules: string;
  actionSpec: ActionSpec;
  extraRules?: string;
}): string {
  return [
    input.roleRules.trim(),
    OBSERVATION_FIELD_GUIDE,
    SIGN_DISCIPLINE_GUIDE,
    input.extraRules?.trim(),
    input.actionSpec.rules.trim(),
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function promptTextForAgentMessage(message: AgentMessage): string {
  const prefix = [
    message.channel.toUpperCase(),
    message.priority ? message.priority.toUpperCase() : undefined,
    message.from ? `from ${message.from}` : undefined,
  ]
    .filter(Boolean)
    .join(" ");
  const nav = message.navigation ? ` ${navigationPromptSuffix(message.navigation)}` : "";
  return `${prefix}: ${message.content}${nav}`.trim();
}

function navigationPromptSuffix(navigation: AgentNavigationFix): string {
  const heading =
    navigation.self.headingDeg !== undefined
      ? `own heading ${Math.round(navigation.self.headingDeg).toString().padStart(3, "0")} ${
          navigation.self.compass ?? ""
        }`
      : undefined;
  const contact = navigation.contacts[0];
  const target =
    contact && contact.bearingDeg !== undefined
      ? `${contact.id} bearing ${Math.round(contact.bearingDeg).toString().padStart(3, "0")} ${
          contact.compass ?? ""
        }, range ${Math.round(contact.rangeM / 1000)} km`
      : undefined;
  const parts = [heading, target].filter(Boolean);
  for (const waypoint of navigation.waypoints ?? []) {
    parts.push(
      `${waypoint.label ?? waypoint.id} GPS ${waypoint.gps.lat.toFixed(5)}, ${waypoint.gps.lon.toFixed(5)}${
        waypoint.bearingDeg !== undefined
          ? ` bearing ${Math.round(waypoint.bearingDeg).toString().padStart(3, "0")} ${waypoint.compass ?? ""}`
          : ""
      }${waypoint.rangeM !== undefined ? ` range ${Math.round(waypoint.rangeM / 1000)} km` : ""}`,
    );
  }
  return parts.length > 0 ? `[nav: ${parts.join("; ")}]` : "";
}
