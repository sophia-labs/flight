import type { Percept, PerceptContact } from "../../protocol/schema";
import type { Encoder, SenseFrame } from "../perception";

// camera-ascii: turns a camera SenseFrame into a deterministic monospace "viewport" plus a numeric
// legend — the cheap, batch-safe, pixel-free encoder. In v0.4.0 this is a capability proof + a human
// viewer aid (the pilot still flies on the structured Observation); when perception becomes operative
// it's the first encoder a model would read, so it is kept strictly pure and locale-free.
//
// Two encoders ship from this one factory:
//   camera-ascii@1 — the original. FROZEN: its golden snapshot must stay byte-identical, so it is
//                    built with LEGACY options (no projection mode, no clock dead-zone, legend gated
//                    on inView only, schematic horizon line, no ground). Do not change its output.
//   camera-ascii@2 — a TRUE ANALYTIC PROJECTION of the view frustum onto the grid (see below). The
//                    projection mode is gated entirely behind `projection`, so @1 is untouched.
//
// THE PROJECTION (camera-ascii@2). The W x H grid is a UNIFORM raster of the view frustum: cell
// (col,row) owns the NDC rectangle
//     ndcX in [-1 + 2*col/W ,  -1 + 2*(col+1)/W]
//     ndcY in [ 1 - 2*(row+1)/H ,  1 - 2*row/H]            (y down: row 0 is the top)
// and is sampled at its CENTER ray (center NDC). This uniform, linear cell<->NDC map IS the projection
// — the same one the engine render uses — which is what lets the collage overlay map each cell to an
// exact pixel rect (cockpitStills.ts). There is NO non-linear cell-aspect remap: a monospace cell is
// taller than it is wide, but that is a DISPLAY concern handled by the renderers' line-height (the
// overlay sets line-height so cells map 1:1 onto the engine's pixel rows) and by choosing H relative
// to W so the grid's NDC coverage matches the frustum aspect — not by distorting the projection.
//
// Hardening: fixed-precision toFixed/round only (no toLocaleString/Intl), every emitted number is
// finite-guarded and -0-normalized, so two encodes of one frame are byte-identical and a degenerate
// projection can never write NaN/-0 into a recorded replay.

const RAD2DEG = 180 / Math.PI;

// @2 reports a contact within this ndc radius of the boresight as "12 o'clock" (on the nose) instead
// of letting a hair of vertical offset (e.g. the cockpit eye's mount drop) flip a dead-centre target
// to 6 o'clock. Sized just under one half-cell of the default grid so it means "in the centre cell".
const CLOCK_DEADZONE_NDC = 0.05;

// --- @2 ground/terrain channel ----------------------------------------------------------------------
// The sim ground is a flat floor at y=0 (no relief is sensed today). @2 projects that plane ANALYTICALLY:
// each cell casts its centre ray; if the ray dips below the world-horizontal horizon it intersects the
// floor at slant range d = eyeAboveFloor / sin(depression). Nearer ground reads denser. Past a named
// visibility limit the deck fades to BLANK — matching how the 3D render fades distant ground into haze
// and giving a "how far can I see the deck" cue. These bands are FEEL KNOBS — tune them here.
const GROUND_NEAR_GLYPH = "#"; // dense: ground close under the nose / on the deck
const GROUND_MID_GLYPH = ":"; // medium
const GROUND_FAR_GLYPH = "."; // faint: distant ground / the deck seen from high altitude
// Slant-range band edges (metres). d < NEAR_M → '#', NEAR_M..MID_M → ':', MID_M..VIS_M → '.'.
const GROUND_NEAR_BAND_M = 400;
const GROUND_MID_BAND_M = 1500;
// How far we can see the deck. Ground intersected BEYOND this slant range fades to blank (haze), so
// the lowest visible ground band is the edge of sight. Defensible default ~6 km; tunable per encoder.
const GROUND_VISIBILITY_M = 6000;
// A ray must depress at least this far below the horizon to be treated as hitting the ground. Rays
// grazing the horizon (sin→0) give d→∞ and a near-parallel intersection we can't trust, so the band
// just under the horizon is left blank and the horizon glyph carries that row.
const GROUND_MIN_DEPRESSION_RAD = 0.003;

export interface CameraAsciiOptions {
  /** grid width in characters (odd → a true centre column for the boresight crosshair) */
  width: number;
  /** grid height in characters (odd → a true centre row) */
  height: number;
  /**
   * radius (in ndc) around the boresight inside which a contact is reported as 12 o'clock. `undefined`
   * disables the dead-zone (legacy @1 behaviour, where any tiny offset gets a literal clock).
   */
  clockDeadzoneNdc?: number;
  /**
   * when true, the legend only lists a contact that actually falls inside the rectangular viewport
   * (|ndcX|<=1 AND |ndcY|<=1) — so the grid and the legend AGREE. When false (legacy @1), a contact
   * is legended on `inView` alone, which can assert a clock position for a marker that is off-frame
   * because the device cone is wider than the viewport's horizontal FOV.
   */
  legendGateToViewport?: boolean;
  /**
   * when set, @2's TRUE-PROJECTION rendering is enabled: the grid is a uniform frustum raster, ground
   * is the analytically-projected flat floor (depth-banded, faded past GROUND_VISIBILITY_M), and the
   * horizon is the TRUE sky/ground boundary per column. `undefined` = legacy @1 (schematic horizon
   * line, sky-blank below it, no ground). The bands are the named GROUND_* constants passed through so
   * they stay tunable; visibility is the "how far can I see the deck" knob.
   */
  projection?: ProjectionOptions;
}

// Tunable depth bands + visibility for the @2 projected-ground channel. Distances are slant range (m).
export interface ProjectionOptions {
  nearGlyph: string;
  midGlyph: string;
  farGlyph: string;
  nearBandM: number; // d < nearBandM → nearGlyph
  midBandM: number; // nearBandM <= d < midBandM → midGlyph; d >= midBandM → farGlyph
  visibilityM: number; // ground intersected beyond this slant range fades to blank (haze edge)
  minDepressionRad: number; // rays shallower than this graze the horizon and are left blank
}

const DEFAULT_PROJECTION: ProjectionOptions = {
  nearGlyph: GROUND_NEAR_GLYPH,
  midGlyph: GROUND_MID_GLYPH,
  farGlyph: GROUND_FAR_GLYPH,
  nearBandM: GROUND_NEAR_BAND_M,
  midBandM: GROUND_MID_BAND_M,
  visibilityM: GROUND_VISIBILITY_M,
  minDepressionRad: GROUND_MIN_DEPRESSION_RAD,
};

const norm0 = (n: number): number => (n === 0 ? 0 : n); // collapse -0 → 0
const r4 = (n: number): number => (Number.isFinite(n) ? norm0(Math.round(n * 1e4) / 1e4) : 0);

function signedDeg(deg: number): string {
  const v = norm0(Math.round(deg));
  return `${v >= 0 ? "+" : "-"}${Math.abs(v)}`;
}

// Clock from screen position. atan2(ndcX, ndcY) measures clockwise from straight-up, so up→12,
// right→3, down→6, left→9. A contact inside `deadzoneNdc` of the boresight is "on the nose" (12).
function clockOf(ndcX: number, ndcY: number, deadzoneNdc?: number): number {
  if (deadzoneNdc !== undefined && Math.hypot(ndcX, ndcY) <= deadzoneNdc) return 12;
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

// A contact is "visible" — drawn in the grid AND eligible for the legend — when it is inView and (for
// @2) actually inside the rectangular viewport. @1 legends on inView alone (legacy).
function isVisible(
  c: { inView: boolean; ndcX: number; ndcY: number },
  legendGateToViewport?: boolean,
): boolean {
  if (!c.inView) return false;
  if (legendGateToViewport) return Math.abs(c.ndcX) <= 1 && Math.abs(c.ndcY) <= 1;
  return true;
}

// --- THE UNIFORM CELL <-> NDC MAP (the projection). Linear in both axes; shared with the overlay. ---
// Cell centre NDC. col 0 → just right of the left edge; row 0 → just below the top edge (y down).
function ndcXForCol(col: number, W: number): number {
  return -1 + (2 * (col + 0.5)) / W;
}
function ndcYForRow(row: number, H: number): number {
  return 1 - (2 * (row + 0.5)) / H;
}
// Inverse: which cell owns an NDC coord. Clamped to the grid; the caller decides whether to draw.
function colForNdcX(ndcX: number, W: number): number {
  return Math.floor(((ndcX + 1) / 2) * W);
}
function rowForNdcY(ndcY: number, H: number): number {
  return Math.floor(((1 - ndcY) / 2) * H);
}

// LEGACY @1 horizon-line row from an ndcY (1:1 anisotropic mapping over [0,H-1]). Kept ONLY for @1.
function legacyRowForNdcY(ndcY: number, H: number): number {
  return Math.round(((1 - ndcY) / 2) * (H - 1));
}
function legacyColForNdcX(ndcX: number, W: number): number {
  return Math.round(((ndcX + 1) / 2) * (W - 1));
}

// EXTENSION SEAM for real terrain relief. Today the sim ground is a flat floor at y=0, so the height
// under any ground sample is 0 and the eye-above-floor drop is exactly `selfAltitude`. When real
// terrain-height sampling lands, replace this with a lookup of the terrain elevation along the cell's
// ground intercept, and the band logic stays the same: the drop becomes `selfAltitude - terrainHeight`.
function terrainFloorHeightForCell(_frame: SenseFrame, _ndcX: number, _depressionRad: number): number {
  return 0; // flat floor — the only ground the sim renders today
}

// Slant range from the eye to the flat ground floor for a ray depressed `depressionRad` below the true
// horizon, when the eye sits `eyeAboveFloorM` above that floor: d = drop / sin(depression). Returns
// Infinity for a ray at/above the floor's horizon (depression ≤ 0) or grazing it (below the min), so
// the caller leaves those cells to the sky / the horizon glyph.
function groundSlantRangeM(eyeAboveFloorM: number, depressionRad: number, minDepressionRad: number): number {
  if (eyeAboveFloorM <= 0) return Infinity; // on or below the deck: no ground plane ahead to paint
  if (depressionRad < minDepressionRad) return Infinity; // near-parallel graze — distance untrustworthy
  const d = eyeAboveFloorM / Math.sin(depressionRad);
  return Number.isFinite(d) ? d : Infinity;
}

// Depth band for a ground slant range. Past visibility → blank (haze edge): we can't see that far.
function groundGlyphForRange(d: number, g: ProjectionOptions): string {
  if (!Number.isFinite(d) || d > g.visibilityM) return " ";
  if (d < g.nearBandM) return g.nearGlyph;
  if (d < g.midBandM) return g.midGlyph;
  return g.farGlyph;
}

export function makeCameraAsciiEncoder(id: string, opts: CameraAsciiOptions): Encoder {
  const { width: W, height: H, clockDeadzoneNdc, legendGateToViewport, projection } = opts;
  return {
    id,
    modality: "camera",
    encode(frame: SenseFrame): Percept {
      const grid: string[][] = Array.from({ length: H }, () =>
        Array.from({ length: W }, () => " "),
      );

      // Horizon CENTRE in ndcY (where the world-horizontal horizon crosses the boresight column) from
      // pitch, normalized by the vertical half-FOV so it is in the SAME ndc space as the projection.
      // Guarded so extreme attitudes can't blow up.
      const vHalf = Math.max(frame.vHalfFovRad, 1e-3);
      const centerNdcY = Math.max(-3, Math.min(3, -frame.pitchRad / vHalf));
      // ndcX and ndcY are normalized by different half-FOV tangents, so a physical roll projects to a
      // screen slope of tan(bank) * (tanH / tanV) = tan(bank) * aspect — not tan(bank) alone.
      const aspect = Math.tan(frame.hHalfFovRad) / Math.max(Math.tan(frame.vHalfFovRad), 1e-6);
      const slope = Math.tan(Math.max(-1.3, Math.min(1.3, frame.bankRad))) * aspect;

      if (projection) {
        renderProjection(grid, frame, W, H, projection, centerNdcY, slope, vHalf);
      } else {
        renderLegacyHorizon(grid, W, H, centerNdcY, slope);
      }

      // Boresight crosshair (centre cell), painted over ground/horizon, under contacts.
      const cx = Math.round((W - 1) / 2);
      const cy = Math.round((H - 1) / 2);
      grid[cy][cx] = "+";

      // Contacts on top, at their TRUE projected cell (only those inside the rectangular viewport).
      for (const contact of frame.contacts) {
        if (!contact.inView || Math.abs(contact.ndcX) > 1 || Math.abs(contact.ndcY) > 1) continue;
        const col = projection ? colForNdcX(contact.ndcX, W) : legacyColForNdcX(contact.ndcX, W);
        const row = projection ? rowForNdcY(contact.ndcY, H) : legacyRowForNdcY(contact.ndcY, H);
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

      const seen = frame.contacts.filter((c) => isVisible(c, legendGateToViewport));
      if (seen.length === 0) {
        lines.push(" (no contacts in view)");
      } else {
        for (const contact of seen) {
          const aspectDeg = contact.aspectRad * RAD2DEG;
          const side = contact.ndcX >= 0 ? "R" : "L";
          lines.push(
            ` ${contact.id}  ${clockOf(contact.ndcX, contact.ndcY, clockDeadzoneNdc)} o'clock ${elevationOf(contact.ndcY)}` +
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
        encoderId: id,
        text: lines.join("\n"),
        contacts,
        attitude: { bankDeg: r4(frame.bankRad * RAD2DEG), pitchDeg: r4(frame.pitchRad * RAD2DEG) },
      };
    },
  };
}

// --- @1 LEGACY horizon: one schematic '-'/'/'/'\' line drawn per column from the formula, sky-blank
// above AND below. Frozen path; do not alter (its snapshot is byte-pinned). ----------------------
function renderLegacyHorizon(
  grid: string[][],
  W: number,
  H: number,
  centerNdcY: number,
  slope: number,
): void {
  const horizonGlyph = Math.abs(slope) < 0.25 ? "-" : slope > 0 ? "/" : "\\";
  for (let c = 0; c < W; c += 1) {
    const ndcX = (c / (W - 1)) * 2 - 1;
    const hNdcY = centerNdcY + slope * ndcX;
    const row = legacyRowForNdcY(hNdcY, H);
    if (row >= 0 && row < H) grid[row][c] = horizonGlyph;
  }
}

// --- @2 TRUE PROJECTION: ground plane + horizon-as-true-boundary, both from the uniform cell map. ---
// Painter order within this function: ground depth fill first, then the boundary glyph on top of the
// topmost ground cell in each column. (Crosshair and contacts are painted by the caller, after.)
function renderProjection(
  grid: string[][],
  frame: SenseFrame,
  W: number,
  H: number,
  g: ProjectionOptions,
  centerNdcY: number,
  slope: number,
  vHalf: number,
): void {
  // 1) GROUND. For each cell, recover the per-column horizon ndcY (same line geometry as the boundary
  // below, so fill and horizon agree under bank), measure how far the cell centre sits below it,
  // convert that ndc gap to a depression angle (ndcY * vHalf is the cell's elevation vs the boresight,
  // matching how centerNdcY encodes pitch), range the flat floor, and band it. The TOPMOST ground row
  // reached in each column is the true sky/ground boundary, recorded here for step 2.
  const topGroundRow: number[] = Array.from({ length: W }, () => -1); // -1 = no ground in this column
  for (let c = 0; c < W; c += 1) {
    const ndcX = ndcXForCol(c, W);
    const hNdcY = centerNdcY + slope * ndcX; // horizon ndcY in this column
    for (let r = 0; r < H; r += 1) {
      const cellNdcY = ndcYForRow(r, H);
      if (cellNdcY >= hNdcY) continue; // at/above the horizon → sky
      const depressionRad = (hNdcY - cellNdcY) * vHalf;
      const eyeAboveFloorM = frame.selfAltitude - terrainFloorHeightForCell(frame, ndcX, depressionRad);
      const d = groundSlantRangeM(eyeAboveFloorM, depressionRad, g.minDepressionRad);
      const glyph = groundGlyphForRange(d, g);
      if (glyph !== " ") {
        grid[r][c] = glyph;
        if (topGroundRow[c] === -1) topGroundRow[c] = r; // first (topmost) ground cell = boundary
      }
    }
  }

  // 2) HORIZON = the TRUE sky/ground boundary. In each column the boundary sits at the topmost ground
  // cell; its glyph encodes the LOCAL boundary slope (the boundary's drift between this column and the
  // next), so a banked deck reads '/' or '\' by the actual boundary, not a separately-drawn formula.
  // Where a column has visible ground but no neighbour ground (an isolated edge) we fall back to the
  // analytic `slope`. Columns with no ground at all (e.g. on the deck, or all-sky) get no boundary.
  for (let c = 0; c < W; c += 1) {
    const row = topGroundRow[c];
    if (row < 0) continue;
    const prev = c > 0 ? topGroundRow[c - 1] : -1;
    const next = c < W - 1 ? topGroundRow[c + 1] : -1;
    let localSlope: number;
    if (prev >= 0 && next >= 0) {
      // boundary rows fall as we move right → ground rising; convert row delta to an ndcY/ndcX slope.
      localSlope = ((prev - next) / 2) * (W / H);
    } else if (prev >= 0) {
      localSlope = (prev - row) * (W / H);
    } else if (next >= 0) {
      localSlope = (row - next) * (W / H);
    } else {
      localSlope = slope; // isolated boundary cell — use the analytic bank slope
    }
    grid[row][c] = Math.abs(localSlope) < 0.25 ? "-" : localSlope > 0 ? "/" : "\\";
  }
}

// camera-ascii@1 — FROZEN. Legacy options reproduce the original byte-for-byte: 33x15 grid, schematic
// horizon line, 1:1 (anisotropic) row mapping, no clock dead-zone, legend gated on inView alone.
export const cameraAsciiEncoder: Encoder = makeCameraAsciiEncoder("camera-ascii@1", {
  width: 33,
  height: 15,
});

// camera-ascii@2 — a TRUE ANALYTIC PROJECTION of the view frustum:
//   * the grid is a UNIFORM frustum raster (linear cell<->NDC map, sampled at cell centres) — the same
//     projection the engine render uses, so the collage overlay can map cells to exact pixel rects;
//   * GROUND is the analytically-projected flat floor, depth-banded (NEAR '#' / MID ':' / FAR '.') and
//     faded to blank past GROUND_VISIBILITY_M (the "how far can I see the deck" haze edge);
//   * the HORIZON is the TRUE sky/ground boundary per column, glyph by the local boundary slope;
//   * contacts are positioned glyphs at their true projected cell (size-coded), painted on top;
//   * plus the two legend fixes: clock dead-zone and legend gated to the rectangular viewport.
// 65x31 is the default acuity (raised from 33x15 for the v0.9.x aiming loop: the Body now flies the
// reticle onto the target and calls its own shot, so it needs the spatial acuity to see the target
// glyph creep onto the centre boresight cell — a coarse grid quantised the pipper too far to aim by).
// Odd dimensions keep a single true CENTRE column+row under the boresight +. Resolution IS the acuity
// knob — cameraAsciiEncoderV2Hi is the SAME projection at an even finer grid (81x37).
export const cameraAsciiEncoderV2: Encoder = makeCameraAsciiEncoder("camera-ascii@2", {
  width: 65,
  height: 31,
  clockDeadzoneNdc: CLOCK_DEADZONE_NDC,
  legendGateToViewport: true,
  projection: DEFAULT_PROJECTION,
});

// camera-ascii@2 at high resolution — identical projection, finer grid. Acuity = resolution.
export const cameraAsciiEncoderV2Hi: Encoder = makeCameraAsciiEncoder("camera-ascii@2", {
  width: 81,
  height: 37,
  clockDeadzoneNdc: CLOCK_DEADZONE_NDC,
  legendGateToViewport: true,
  projection: DEFAULT_PROJECTION,
});
