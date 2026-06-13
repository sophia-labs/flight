import type { Percept, PerceptContact } from "../../protocol/schema";
import type { Encoder, SenseFrame } from "../perception";

// camera-ascii@1: turns a camera SenseFrame into a deterministic monospace "viewport" plus a numeric
// legend — the cheap, batch-safe, pixel-free encoder. In v0.4.0 this is a capability proof + a human
// viewer aid (the pilot still flies on the structured Observation); when perception becomes operative
// it's the first encoder a model would read, so it is kept strictly pure and locale-free.
//
// Hardening: fixed-precision toFixed/round only (no toLocaleString/Intl), every emitted number is
// finite-guarded and -0-normalized, so two encodes of one frame are byte-identical and a degenerate
// projection can never write NaN/-0 into a recorded replay.

const W = 33; // odd → a true centre column for the boresight crosshair
const H = 15; // odd → a true centre row
const RAD2DEG = 180 / Math.PI;

const norm0 = (n: number): number => (n === 0 ? 0 : n); // collapse -0 → 0
const r4 = (n: number): number => (Number.isFinite(n) ? norm0(Math.round(n * 1e4) / 1e4) : 0);

function signedDeg(deg: number): string {
  const v = norm0(Math.round(deg));
  return `${v >= 0 ? "+" : "-"}${Math.abs(v)}`;
}

function clockOf(ndcX: number, ndcY: number): number {
  const hours = (Math.atan2(ndcX, ndcY) / (2 * Math.PI)) * 12;
  const h = ((Math.round(hours) % 12) + 12) % 12;
  return h === 0 ? 12 : h;
}

function elevationOf(ndcY: number): string {
  return ndcY > 0.15 ? "high" : ndcY < -0.15 ? "low" : "level";
}

function aspectWord(aspectDeg: number): string {
  if (aspectDeg < 30) return "nose";
  if (aspectDeg < 70) return "fwd-qtr";
  if (aspectDeg < 110) return "beam";
  if (aspectDeg < 150) return "aft-qtr";
  return "tail";
}

function glyphFor(angularSizeDeg: number): string {
  if (angularSizeDeg >= 6) return "@";
  if (angularSizeDeg >= 2) return "O";
  if (angularSizeDeg >= 0.6) return "o";
  return ".";
}

export const cameraAsciiEncoder: Encoder = {
  id: "camera-ascii@1",
  modality: "camera",
  encode(frame: SenseFrame): Percept {
    const grid: string[][] = Array.from({ length: H }, () =>
      Array.from({ length: W }, () => " "),
    );

    // Horizon: vertical position from pitch (linear in angle), tilted by bank. A viewer cue, not a
    // flight-grade horizon — guarded so extreme attitudes can't blow up.
    const centerNdcY = Math.max(-3, Math.min(3, -frame.pitchRad / Math.max(frame.vHalfFovRad, 1e-3)));
    // ndcX and ndcY are normalized by different half-FOV tangents, so a physical roll projects to a
    // screen slope of tan(bank) * (tanH / tanV) = tan(bank) * aspect — not tan(bank) alone.
    const aspect = Math.tan(frame.hHalfFovRad) / Math.max(Math.tan(frame.vHalfFovRad), 1e-6);
    const slope = Math.tan(Math.max(-1.3, Math.min(1.3, frame.bankRad))) * aspect;
    const horizonGlyph = Math.abs(slope) < 0.25 ? "-" : slope > 0 ? "/" : "\\";
    for (let c = 0; c < W; c += 1) {
      const ndcX = (c / (W - 1)) * 2 - 1;
      const hNdcY = centerNdcY + slope * ndcX;
      const row = Math.round(((1 - hNdcY) / 2) * (H - 1));
      if (row >= 0 && row < H && grid[row][c] === " ") grid[row][c] = horizonGlyph;
    }

    // Boresight crosshair.
    const cx = (W - 1) / 2;
    const cy = (H - 1) / 2;
    grid[cy][cx] = "+";

    // Contacts on top (only those inside the rectangular viewport).
    for (const contact of frame.contacts) {
      if (!contact.inView || Math.abs(contact.ndcX) > 1 || Math.abs(contact.ndcY) > 1) continue;
      const col = Math.round(((contact.ndcX + 1) / 2) * (W - 1));
      const row = Math.round(((1 - contact.ndcY) / 2) * (H - 1));
      if (row >= 0 && row < H && col >= 0 && col < W) {
        grid[row][col] = glyphFor(2 * contact.angularRadiusRad * RAD2DEG);
      }
    }

    const border = `+${"-".repeat(W)}+`;
    const lines: string[] = [];
    lines.push(
      ` ${frame.deviceId}  ${W}x${H}  FOV ${Math.round(frame.hHalfFovRad * 2 * RAD2DEG)}deg`,
    );
    lines.push(border);
    for (let r = 0; r < H; r += 1) lines.push(`|${grid[r].join("")}|`);
    lines.push(border);
    lines.push(
      ` own  spd ${Math.round(frame.selfSpeed)}  alt ${Math.round(frame.selfAltitude)}` +
        `  bank ${signedDeg(frame.bankRad * RAD2DEG)}  pitch ${signedDeg(frame.pitchRad * RAD2DEG)}`,
    );

    const seen = frame.contacts.filter((c) => c.inView);
    if (seen.length === 0) {
      lines.push(" (no contacts in view)");
    } else {
      for (const contact of seen) {
        const aspectDeg = contact.aspectRad * RAD2DEG;
        const side = contact.ndcX >= 0 ? "R" : "L";
        lines.push(
          ` ${contact.id}  ${clockOf(contact.ndcX, contact.ndcY)} o'clock ${elevationOf(contact.ndcY)}` +
            `  rng ${Math.round(contact.range)}  ${aspectWord(aspectDeg)}-${side}  hp ${Math.round(contact.health)}`,
        );
      }
    }

    const contacts: PerceptContact[] = frame.contacts.map((c) => ({
      id: c.id,
      team: c.team,
      ndcX: r4(c.ndcX),
      ndcY: r4(c.ndcY),
      rangeM: r4(c.range),
      aspectDeg: r4(c.aspectRad * RAD2DEG),
      angularSizeDeg: r4(2 * c.angularRadiusRad * RAD2DEG),
      inView: c.inView,
      health: r4(c.health),
    }));

    return {
      deviceId: frame.deviceId,
      modality: "camera",
      encoderId: "camera-ascii@1",
      text: lines.join("\n"),
      contacts,
      attitude: { bankDeg: r4(frame.bankRad * RAD2DEG), pitchDeg: r4(frame.pitchRad * RAD2DEG) },
    };
  },
};
