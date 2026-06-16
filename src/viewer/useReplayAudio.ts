import { useEffect, useRef } from "react";
import type { ReplayFrame } from "../protocol/schema";

// Rudimentary, asset-free sound design via the Web Audio API: a continuous engine drone whose
// pitch tracks the pilot's airspeed, plus short synthesized bursts on weapon/terrain events.
interface Engine {
  ctx: AudioContext;
  osc: OscillatorNode;
  gain: GainNode;
}

function noiseBurst(ctx: AudioContext, durationS: number, freq: number, q: number, peak: number) {
  const now = ctx.currentTime;
  const length = Math.max(1, Math.floor(ctx.sampleRate * durationS));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2; // decaying white noise
  }
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = "bandpass";
  filter.frequency.value = freq;
  filter.Q.value = q;
  const gain = ctx.createGain();
  gain.gain.value = peak;
  src.connect(filter).connect(gain).connect(ctx.destination);
  src.start(now);
  src.stop(now + durationS);
}

function tone(
  ctx: AudioContext,
  type: OscillatorType,
  fromHz: number,
  toHz: number,
  durationS: number,
  peak: number,
) {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(fromHz, now);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, toHz), now + durationS);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(peak, now + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + durationS);
  osc.connect(gain).connect(ctx.destination);
  osc.start(now);
  osc.stop(now + durationS + 0.02);
}

export function useReplayAudio(
  frame: ReplayFrame | undefined,
  pilotId: string,
  enabled: boolean,
): void {
  const engineRef = useRef<Engine | null>(null);
  const lastIndexRef = useRef<number>(-1);

  // The AudioContext is created when the user enables sound (a gesture), satisfying autoplay rules.
  useEffect(() => {
    if (!enabled) return;
    const ctx = new AudioContext();
    void ctx.resume();
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 90;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    engineRef.current = { ctx, osc, gain };
    lastIndexRef.current = -1;
    return () => {
      try {
        osc.stop();
      } catch {
        // already stopped
      }
      void ctx.close();
      engineRef.current = null;
    };
  }, [enabled]);

  useEffect(() => {
    const engine = engineRef.current;
    if (!enabled || !engine || !frame) return;
    const { ctx, osc, gain } = engine;

    const pilot = frame.aircraft.find((a) => a.id === pilotId) ?? frame.aircraft[0];
    if (pilot) {
      const target = 70 + Math.min(pilot.airspeed, 320) * 0.55;
      osc.frequency.setTargetAtTime(target, ctx.currentTime, 0.08);
      gain.gain.setTargetAtTime(pilot.stalled ? 0.015 : 0.045, ctx.currentTime, 0.1);
    }

    // Fire SFX once per new frame (not on re-renders of the same frame).
    if (frame.index !== lastIndexRef.current) {
      lastIndexRef.current = frame.index;
      for (const event of frame.events) {
        if (event.type === "shot") noiseBurst(ctx, 0.12, 1100, 0.7, 0.22);
        else if (event.type === "hit") tone(ctx, "triangle", 680, 160, 0.22, 0.3);
        else if (event.type === "terrain") tone(ctx, "sawtooth", 90, 55, 0.18, 0.16);
      }
    }
  }, [frame, enabled, pilotId]);
}
