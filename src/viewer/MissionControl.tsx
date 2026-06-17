import { useEffect, useRef, type ComponentType } from "react";
import {
  Activity,
  Bot,
  Crosshair,
  Gauge,
  Plane,
  Radio,
  Zap,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────

export interface MissionDecision {
  id: number;
  turn: number;
  agentId: string;
  agentLabel: string;
  actionKind: string;
  rationale?: string;
}

export interface MissionBodyTick {
  id: number;
  time: number;
  agentId: string;
  status: string;
  tick: number;
  feel?: string;
}

export interface MissionState {
  scenarioLabel: string;
  aircraftName: string;
  controlMode: string;
  turn: number;
  maxTurns: number;
  percent: number;
  decisions: MissionDecision[];
  bodyTicks: MissionBodyTick[];
  complete: boolean;
}

// ── Helpers ────────────────────────────────────────────────────────

const ACTION_ICONS: Record<string, ComponentType<{ size?: number }>> = {
  "pilot-intent": Crosshair,
  "motor-program": Radio,
  "raw-stick": Gauge,
  setpoint: Activity,
  "flight-director": Plane,
};

function actionIcon(kind: string): ComponentType<{ size?: number }> {
  return ACTION_ICONS[kind] ?? Zap;
}

function actionLabel(kind: string): string {
  // Keep: compact display names
  if (kind === "pilot-intent") return "pilot intent";
  if (kind === "motor-program") return "motor tape";
  if (kind === "raw-stick") return "raw stick";
  if (kind === "setpoint") return "setpoint";
  if (kind === "flight-director") return "fdir";
  return kind;
}

const BODY_STATUS_COLORS: Record<string, string> = {
  OK: "#59d894",
  "LOW-CONFIDENCE": "#f2c94c",
  "REFLEX-STALE": "#f2c94c",
  PANIC: "#ff6b61",
  ERROR: "#ff6b61",
};

function bodyStatusColor(status: string): string {
  return BODY_STATUS_COLORS[status] ?? "#83d4ff";
}

// ── RadarScope ─────────────────────────────────────────────────────

function RadarScope({ turn, maxTurns, active }: { turn: number; maxTurns: number; active: boolean }) {
  const sweepRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = sweepRef.current;
    if (!el) return;
    if (active) {
      el.style.animationPlayState = "running";
    } else {
      el.style.animationPlayState = "paused";
    }
  }, [active]);

  return (
    <div className={`radar-scope${active ? " sweeping" : ""}`} aria-label="Tactical radar scope">
      {/* Grid rings */}
      <div className="radar-ring ring-1" />
      <div className="radar-ring ring-2" />
      <div className="radar-ring ring-3" />
      <div className="radar-crosshair" />

      {/* Aircraft dots */}
      <div
        className="radar-dot blue-dot"
        aria-label="Blue aircraft position"
        style={{
          left: "42%",
          top: "44%",
        }}
      >
        <span className="dot-pulse" />
      </div>
      <div
        className="radar-dot red-dot"
        aria-label="Red aircraft position"
        style={{
          left: "58%",
          top: "52%",
        }}
      >
        <span className="dot-pulse" />
      </div>

      {/* Sweep line */}
      <div ref={sweepRef} className="radar-sweep" />

      {/* Turn counter */}
      <div className="radar-turn-counter">
        <span className="turn-label">TURN</span>
        <span className="turn-value">
          {turn}
          <small>/{maxTurns}</small>
        </span>
      </div>
    </div>
  );
}

// ── DecisionLog ────────────────────────────────────────────────────

function DecisionLog({ decisions }: { decisions: MissionDecision[] }) {
  const listRef = useRef<HTMLDivElement | null>(null);
  const prevLenRef = useRef(0);

  useEffect(() => {
    if (decisions.length > prevLenRef.current && listRef.current) {
      listRef.current.scrollTop = 0; // newest at top
    }
    prevLenRef.current = decisions.length;
  }, [decisions.length]);

  if (decisions.length === 0) {
    return (
      <div className="decision-log" ref={listRef}>
        <div className="decision-empty">
          <Radio size={24} />
          <span>Awaiting decisions…</span>
        </div>
      </div>
    );
  }

  return (
    <div className="decision-log" ref={listRef}>
      {decisions.map((d) => {
        const Icon = actionIcon(d.actionKind);
        return (
          <div key={d.id} className="decision-card" style={{ animationDelay: "0s" }}>
            <div className="decision-card-head">
              <span className={`decision-team ${d.agentId.startsWith("blue") ? "team-blue" : "team-red"}`}>
                {d.agentLabel}
              </span>
              <span className="decision-turn">T{d.turn}</span>
            </div>
            <div className="decision-card-action">
              <Icon size={14} />
              <span>{actionLabel(d.actionKind)}</span>
            </div>
            {d.rationale ? (
              <p className="decision-card-rationale">{d.rationale.slice(0, 140)}{d.rationale.length > 140 ? "…" : ""}</p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

// ── BodyTickFeed ───────────────────────────────────────────────────

function BodyTickFeed({ ticks }: { ticks: MissionBodyTick[] }) {
  const feedRef = useRef<HTMLDivElement | null>(null);
  const prevLenRef = useRef(0);

  useEffect(() => {
    if (ticks.length > prevLenRef.current && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
    prevLenRef.current = ticks.length;
  }, [ticks.length]);

  if (ticks.length === 0) return null;

  return (
    <div className="body-tick-feed" ref={feedRef} aria-label="Body tick feed">
      {ticks.map((tick) => (
        <div key={tick.id} className="body-tick-line">
          <span className="body-tick-time">t={tick.time.toFixed(2)}s</span>
          <span
            className="body-tick-status"
            style={{ color: bodyStatusColor(tick.status) }}
          >
            {tick.status}
          </span>
          {tick.feel ? <span className="body-tick-feel">{tick.feel}</span> : null}
        </div>
      ))}
    </div>
  );
}

// ── TimelineBar ────────────────────────────────────────────────────

function TimelineBar({ turn, maxTurns, percent }: { turn: number; maxTurns: number; percent: number }) {
  const segments: boolean[] = [];
  for (let t = 0; t < maxTurns; t++) {
    segments.push(t < turn);
  }

  return (
    <div className="mission-timeline" aria-label="Match progress">
      <div className="timeline-bar">
        {segments.map((done, i) => (
          <div
            key={i}
            className={`timeline-segment${done ? " done" : ""}${i === turn - 1 ? " current" : ""}`}
          />
        ))}
        <div className="timeline-fill" style={{ width: `${Math.round(percent * 100)}%` }} />
      </div>
      <span className="timeline-pct">{Math.round(percent * 100)}%</span>
    </div>
  );
}

// ── CompleteFlash ──────────────────────────────────────────────────

function CompleteFlash({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div className="mission-complete-flash" aria-label="Scenario complete">
      <span>SCENARIO COMPLETE</span>
    </div>
  );
}

// ── Shell ──────────────────────────────────────────────────────────

export function MissionControl({ state }: { state: MissionState }) {
  return (
    <main className="mission-control" aria-label="Mission control — scenario in progress">
      {/* Header */}
      <header className="mission-header">
        <div className="mission-header-left">
          <Crosshair size={18} />
          <span>{state.scenarioLabel}</span>
        </div>
        <div className="mission-header-center">
          <Plane size={16} />
          <span>{state.aircraftName}</span>
        </div>
        <div className="mission-header-right">
          <Bot size={16} />
          <span>{state.controlMode}</span>
        </div>
      </header>

      {/* Core layout */}
      <div className="mission-core">
        {/* Radar scope — center-left */}
        <div className="mission-radar-area">
          <RadarScope turn={state.turn} maxTurns={state.maxTurns} active={!state.complete} />
        </div>

        {/* Decision log — right column */}
        <div className="mission-log-area">
          <DecisionLog decisions={state.decisions} />
        </div>
      </div>

      {/* Timeline — spans full width */}
      <TimelineBar turn={state.turn} maxTurns={state.maxTurns} percent={state.percent} />

      {/* Body tick feed — bottom strip */}
      <BodyTickFeed ticks={state.bodyTicks} />

      {/* Complete flash overlay */}
      <CompleteFlash visible={state.complete} />
    </main>
  );
}
