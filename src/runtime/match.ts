import { adapterFor } from "../agent/action";
import { toObservation } from "../agent/observation";
import { cameraSensor, senseAndEncode } from "../agent/perception";
import { cameraAsciiEncoderV2 } from "../agent/encoders/cameraAscii";
import type { ControllerContext } from "../agent/controller";
import {
  MatchReplaySchema,
  type Action,
  type AgentMeta,
  type AgentPhaseTrace,
  type Airframe,
  type BodyTickTrace,
  type ControlInput,
  type MatchReplay,
  type MotorProgramAction,
  type MotorProgramHeldAction,
  type Observation,
  type PilotIntentAction,
  type ReplayEvent,
  type ReplayFrame,
  type TurnDecision,
} from "../protocol/schema";
import {
  createBodyRuntimeState,
  finishBodyTick,
  runBodyTick,
  type BodyRuntimeState,
  type PendingBodyTick,
} from "../body/runtime";
import { selectCameraDevice } from "../sim/mountedSensor";
import { hasLoadedHeatSeeker, irLockAvailable, stepSimulation } from "../sim/flight";
import { basisFromQuat, dot, length, normalize, sub } from "../sim/math";
import { toSnapshot, type AircraftState, type Projectile } from "../sim/types";
import type { AgentEntry, MatchConfig, MatchProgress } from "./config";

function projectileSnapshot(round: Projectile) {
  return {
    id: round.id,
    kind: round.kind,
    ...(round.guidance ? { guidance: round.guidance } : {}),
    ...(round.missileModel ? { missileModel: round.missileModel } : {}),
    ...(round.lockState ? { lockState: round.lockState } : {}),
    position: round.position,
    velocity: round.velocity,
    team: round.team,
    ...(round.targetId ? { targetId: round.targetId } : {}),
    ...(round.seekerAngleRad !== undefined ? { seekerAngleDeg: (round.seekerAngleRad * 180) / Math.PI } : {}),
    ...(round.targetHeat !== undefined ? { targetHeat: round.targetHeat } : {}),
    ...(round.lockSignal !== undefined ? { lockSignal: round.lockSignal } : {}),
  };
}

function snapshot(
  index: number,
  time: number,
  turn: number,
  aircraft: AircraftState[],
  events: ReplayEvent[],
  projectiles: Projectile[] = [],
): ReplayFrame {
  return {
    index,
    time,
    turn,
    aircraft: aircraft.map(toSnapshot),
    events,
    // Optional + only when rounds are airborne, so frames with no bullets stay byte-identical.
    ...(projectiles.length > 0 ? { projectiles: projectiles.map(projectileSnapshot) } : {}),
  };
}

interface DecisionOutcome {
  action: TurnDecision["action"];
  rationale?: string;
  usage?: TurnDecision["usage"];
  source: TurnDecision["source"];
}

function replaySchemaVersion(input: { bodyTicks: BodyTickTrace[]; agentPhases: AgentPhaseTrace[] }) {
  if (input.agentPhases.length > 0) return 5;
  if (input.bodyTicks.length > 0) return 4;
  return 3;
}

function isPilotIntentAction(action: Action | undefined): action is PilotIntentAction {
  return action?.kind === "pilot-intent";
}

function isMotorProgramAction(action: Action | undefined): action is MotorProgramAction {
  return action?.kind === "motor-program";
}

function weaponsFreeGuard(action: MotorProgramAction): MotorProgramHeldAction | undefined {
  return action.heldActions.find((held) => held.kind === "weapons_free");
}

function targetInForwardCone(input: {
  self: AircraftState;
  aircraft: AircraftState[];
  coneDeg: number;
  rangeM: number;
}): boolean {
  const { self, aircraft, coneDeg, rangeM } = input;
  const forward = basisFromQuat(self.orientation).forward;
  const minDot = Math.cos((Math.max(0.5, coneDeg) * Math.PI) / 180);
  for (const target of aircraft) {
    if (target.id === self.id || target.team === self.team || target.health <= 0) continue;
    const toTarget = sub(target.position, self.position);
    const range = length(toTarget);
    if (range < 1 || range > rangeM) continue;
    if (dot(forward, normalize(toTarget)) >= minDot) return true;
  }
  return false;
}

// IR missile sear: a no-twitch motor-program planner that armed weapons_free fires its loaded heat-seeker
// the instant a live IR lock exists on an enemy. The planner armed and flew the lock; the sear only pulls
// the trigger when the seeker solution is real (assisted-sear; deterministic, no scripted flying).
function missileSearReady(self: AircraftState, aircraft: AircraftState[]): boolean {
  if (!hasLoadedHeatSeeker(self)) return false;
  return aircraft.some((target) => target.id !== self.id && irLockAvailable(self, target));
}

function reflexIntentFor(action: MotorProgramAction, guard: MotorProgramHeldAction): PilotIntentAction {
  return {
    kind: "pilot-intent",
    goal:
      guard.note ??
      `quick-time guns: target entered ${Math.round(guard.coneDeg ?? 12)} degree cone; refine nose and call the shot`,
    urgency: 1,
    riskTolerance: 0.72,
    style: "twitch_guns",
    constraints: ["do_not_crash", "avoid_stall", "preserve_solution"],
    attention: [
      "boresight_crosshair",
      "target_glyph",
      `planner_dt_${Math.round(action.sampleDtMs)}ms`,
      `guard_${guard.condition ?? "weapons_free"}`,
    ],
    trigger: true,
    armedFire: true,
  };
}

function cockpitObservationText(self: AircraftState, aircraft: AircraftState[]): string {
  const device = selectCameraDevice(self.devices);
  const field = cameraAsciiEncoderV2.encode(cameraSensor.sense(device, aircraft, self)).text ?? "";
  return [
    "VISUAL camera-ascii@2 cockpit field.",
    "This is the same cockpit projection the Body uses; the + at grid center is the gun boresight/pipper.",
    "Use the grid and legend for line-up, target position, and weapons-free timing.",
    field,
  ].join("\n");
}

function withCockpitObservationText(observation: Observation, self: AircraftState, aircraft: AircraftState[]): Observation {
  return {
    ...observation,
    text: cockpitObservationText(self, aircraft),
  };
}

// Race the controller against its latency budget; abort + fall back on timeout or throw.
// No wall-clock is read here, so a match with deterministic controllers is itself deterministic.
async function decide(
  entry: AgentEntry,
  observation: Observation,
  context: ControllerContext,
  fallback: MatchConfig["fallback"],
): Promise<DecisionOutcome> {
  const aborter = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      aborter.abort();
      reject(new Error("controller timeout"));
    }, context.deadlineMs);
  });

  try {
    const pending = entry.controller(observation, { ...context, signal: aborter.signal });
    pending.catch(() => {}); // swallow a late rejection if the deadline wins the race
    const decision = await Promise.race([pending, timeout]);
    return {
      action: decision.action,
      rationale: decision.rationale,
      usage: decision.usage,
      source: "controller",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { action: fallback(observation), source: "fallback", rationale: message.slice(0, 160) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// The generalized match runner: config is reusable data, so the mutable physics state is cloned before
// the first frame. This matters for sweeps/evals that may intentionally replay the same config.
export async function runMatch(config: MatchConfig): Promise<MatchReplay> {
  const aircraft = structuredClone(config.initialAircraft) as AircraftState[];
  const stepsPerTurn = Math.round(config.turnDuration / config.frameDt);
  const frames: ReplayFrame[] = [];
  const decisions: TurnDecision[] = [];
  const bodyTicks: BodyTickTrace[] = [];
  const agentPhases: AgentPhaseTrace[] = [];
  const activeTwitchPhases: Record<string, AgentPhaseTrace | undefined> = {};
  const bodyStates: Record<string, BodyRuntimeState> = {};
  const reflexStates: Record<string, BodyRuntimeState> = {};
  let time = 0;
  let frameIndex = 0;
  let turnsRun = 0;
  let projectiles: Projectile[] = []; // live rounds, carried across steps by the physics loop

  frames.push(snapshot(frameIndex, time, 0, aircraft, []));
  frameIndex += 1;

  for (let turn = 1; turn <= config.maxTurns; turn += 1) {
    turnsRun = turn;
    config.onProgress?.({
      phase: "turn_start",
      turn,
      maxTurns: config.maxTurns,
      time,
    });
    const actionsById: Record<string, Action> = {};

    // Decide once per turn, per living agent.
    for (const ship of aircraft) {
      if (ship.health <= 0) continue;
      const entry = config.agents[ship.id];
      if (!entry) continue;

      const baseObservation = toObservation(ship, aircraft, turn, time, config.sensor);
      const observation =
        entry.body || entry.reflexBody || entry.feedField
          ? withCockpitObservationText(baseObservation, ship, aircraft)
          : baseObservation;
      const context: ControllerContext = {
        turn,
        agentId: ship.id,
        deadlineMs: config.decisionTimeoutMs,
        signal: new AbortController().signal,
      };
      const outcome = await decide(entry, observation, context, config.fallback);
      actionsById[ship.id] = outcome.action;

      const decision: TurnDecision = {
        turn,
        agentId: ship.id,
        observation,
        action: outcome.action,
        controlInput: adapterFor(outcome.action.kind).controlFor(outcome.action, ship),
        source: outcome.source,
      };
      if (outcome.rationale !== undefined) decision.rationale = outcome.rationale;
      if (outcome.usage !== undefined) decision.usage = outcome.usage;

      // Record each mounted sensor's percept (pre-step world, same state the observation saw). This
      // is recorded for the viewer / as a capability proof — it does NOT feed the controller.
      const percepts = (ship.devices ?? []).map((device) => senseAndEncode(device, aircraft, ship));
      if (percepts.length > 0) decision.percepts = percepts;

      decisions.push(decision);
      config.onProgress?.({
        phase: "decision",
        turn,
        maxTurns: config.maxTurns,
        time,
        agentId: ship.id,
        agentLabel: entry.meta.label,
        actionKind: outcome.action.kind,
        ...(outcome.rationale !== undefined ? { rationale: outcome.rationale } : {}),
      });

      if (entry.reflexBody && isMotorProgramAction(outcome.action)) {
        agentPhases.push({
          agentId: ship.id,
          turn,
          mode: "planner",
          startTime: time,
          endTime: time + Math.min(config.turnDuration, outcome.action.durationMs / 1000),
          model: entry.meta.label,
          reason: "motor-program tape",
        });
      }
    }

    // Re-derive each held action into a control EVERY frame, so a setpoint adapter can track
    // the evolving state (raw-stick returns a constant, identical to holding the stick).
    for (let s = 0; s < stepsPerTurn; s += 1) {
      const controlsById: Record<string, ControlInput> = {};
      const pendingBodyTicks: Record<string, PendingBodyTick> = {};
      const elapsedMs = s * config.frameDt * 1000;
      for (const ship of aircraft) {
        const action = actionsById[ship.id];
        const entry = config.agents[ship.id];
        if (entry?.body && isPilotIntentAction(action)) {
          bodyStates[ship.id] ??= createBodyRuntimeState(ship.controls);
          // FIELD-FEED: the Body sees the cockpit-cam glyph-field, recomputed inside runBodyTick from
          // the live `aircraft` world + `ship` each frame, so the field tracks the plane as it moves.
          const pending = await runBodyTick({
            config: entry.body,
            state: bodyStates[ship.id],
            turn,
            agentId: ship.id,
            time,
            dt: config.frameDt,
            self: ship,
            aircraft,
            pilotIntent: action,
            device: selectCameraDevice(ship.devices),
          });
          controlsById[ship.id] = pending.controlInput;
          pendingBodyTicks[ship.id] = pending;
        } else if (entry?.reflexBody && isMotorProgramAction(action)) {
          const baseControl = adapterFor(action.kind).controlFor(action, ship, { elapsedMs });
          const guard = weaponsFreeGuard(action);
          const reflexActive =
            guard !== undefined &&
            targetInForwardCone({
              self: ship,
              aircraft,
              coneDeg: guard.coneDeg ?? 12,
              rangeM: guard.rangeM ?? 2_900,
            });

          if (reflexActive) {
            let phase = activeTwitchPhases[ship.id];
            if (!phase) {
              phase = {
                agentId: ship.id,
                turn,
                mode: "twitch",
                startTime: time,
                endTime: time + config.frameDt,
                timeScale: clampPlaybackTimeScale(entry.reflexPlaybackTimeScale ?? 0.35),
                model:
                  typeof entry.meta.config?.twitchBodyModel === "string"
                    ? entry.meta.config.twitchBodyModel
                    : entry.meta.label,
                reason: guard.condition ?? "weapons_free",
              };
              activeTwitchPhases[ship.id] = phase;
              agentPhases.push(phase);
            } else {
              phase.endTime = time + config.frameDt;
            }
            reflexStates[ship.id] ??= createBodyRuntimeState(baseControl);
            const pending = await runBodyTick({
              config: entry.reflexBody,
              state: reflexStates[ship.id],
              turn,
              agentId: ship.id,
              time,
              dt: config.frameDt,
              self: ship,
              aircraft,
              pilotIntent: reflexIntentFor(action, guard),
              device: selectCameraDevice(ship.devices),
            });
            controlsById[ship.id] = pending.controlInput;
            pendingBodyTicks[ship.id] = pending;
          } else {
            const phase = activeTwitchPhases[ship.id];
            if (phase) {
              phase.endTime = time;
              activeTwitchPhases[ship.id] = undefined;
            }
            controlsById[ship.id] = baseControl;
          }
        } else if (action) {
          const control = adapterFor(action.kind).controlFor(action, ship, { elapsedMs });
          // Release the FOX-2 if this motor-program armed weapons_free and a loaded heat-seeker now has a
          // live IR lock — the only path by which a no-twitch planner (no reflex Body) takes the shot.
          controlsById[ship.id] =
            isMotorProgramAction(action) && weaponsFreeGuard(action) && missileSearReady(ship, aircraft)
              ? { ...control, trigger: true }
              : control;
        }
      }
      const result = stepSimulation(aircraft, controlsById, config.frameDt, projectiles, time);
      projectiles = result.projectiles;
      time += config.frameDt;
      for (const [agentId, pending] of Object.entries(pendingBodyTicks)) {
        const ship = result.aircraft.find((candidate) => candidate.id === agentId);
        const state = bodyStates[agentId] ?? reflexStates[agentId];
        if (ship && state) {
          const tick = finishBodyTick(pending, state, ship);
          bodyTicks.push(tick);
          config.onProgress?.({
            phase: "body_tick",
            turn,
            maxTurns: config.maxTurns,
            time,
            agentId,
            bodyTick: {
              agentId,
              status: tick.parsed.status,
              tick: tick.tick,
              feel: tick.parsed.feel,
            },
          });
        }
      }
      frames.push(snapshot(frameIndex, time, turn, result.aircraft, result.events, projectiles));
      frameIndex += 1;
      // Emit frame progress every Nth frame (every 5th by default) so we don't spam.
      if (frameIndex % 5 === 0) {
        config.onProgress?.({
          phase: "frame",
          turn,
          maxTurns: config.maxTurns,
          time,
          frameIndex,
        });
      }
    }

    if (aircraft.some((ship) => ship.health <= 0)) break;
  }

  for (const phase of Object.values(activeTwitchPhases)) {
    if (phase) phase.endTime = Math.max(phase.endTime, time);
  }

  const outcome = config.evaluator.evaluate(aircraft, frames, decisions, turnsRun);
  const agents: AgentMeta[] = Object.values(config.agents).map((entry) => entry.meta);

  // Record the airframe each aircraft flew (config metadata, not per-frame state) so the viewer can
  // render the plane that was built. Omitted entirely when no aircraft carries one (keeps legacy-shaped
  // replays clean and the field optional).
  const airframes: Record<string, Airframe> = {};
  for (const ship of aircraft) {
    if (ship.airframe) airframes[ship.id] = ship.airframe;
  }

  const replay = MatchReplaySchema.parse({
    id: config.id,
    schemaVersion: replaySchemaVersion({ bodyTicks, agentPhases }),
    turnDuration: config.turnDuration,
    frameDt: config.frameDt,
    frames,
    agents,
    decisions,
    ...(bodyTicks.length > 0 ? { bodyTicks } : {}),
    ...(agentPhases.length > 0 ? { agentPhases } : {}),
    outcome,
    ...(Object.keys(airframes).length > 0 ? { airframes } : {}),
  });
  config.onProgress?.({
    phase: "complete",
    turn: turnsRun,
    maxTurns: config.maxTurns,
    time,
    replay,
  });
  return replay;
}

function clampPlaybackTimeScale(value: number): number {
  if (!Number.isFinite(value)) return 0.35;
  return Math.max(0.05, Math.min(1, value));
}
