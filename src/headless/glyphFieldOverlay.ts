// REGISTRATION PRIMITIVE: the live cockpit overlay (film.ts cinema HUD) will reuse this to place the
// ASCII glyph field onto an undistorted camera render at exact per-cell pixel registration.
//
// glyphFieldOverlay maps a WxH glyph grid onto a DISPLAYED render rectangle {x0,y0,w,h} (in CSS px,
// relative to its positioned parent). The render rect is the LETTERBOXED image rect — the camera image
// drawn at its native aspect ratio, centred, with neutral bars filling the rest of the panel. Because
// the camera-ascii grid is a uniform raster of the SAME view frustum the render draws, each cell maps
// to a uniform sub-rect of that image rect with the standard cell<->NDC map:
//     pixelX = x0 + (col/W)*w .. x0 + ((col+1)/W)*w
//     pixelY = y0 + (row/H)*h .. y0 + ((row+1)/H)*h
// Glyphs therefore sit on the undistorted image and register exactly with image features. This is
// parameterized purely by (renderRect, grid dims) — it is NOT tied to any panel/collage dimensions.

export interface RenderRect {
  x0: number; // left edge of the displayed (letterboxed) image, px
  y0: number; // top edge, px
  w: number; // displayed image width, px (native aspect preserved)
  h: number; // displayed image height, px
}

export interface GlyphGrid {
  rows: string[]; // H strings, each W chars; a single space (" ") = blank cell
  W: number;
  H: number;
}

function esc(ch: string): string {
  return ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch;
}

// Pure: build the absolutely-positioned glyph spans for the field. Returns the HTML for the cell layer
// (a flat string of <span class="cell" ...> elements). Renders ONLY projected glyph content — no frame
// border, no panel chrome. Blank (" ") cells are skipped. Each span is sized to its cell rect with the
// glyph centred (flex), so registration does not depend on monospace font-advance metrics.
export function glyphFieldOverlay(grid: GlyphGrid, rect: RenderRect): string {
  const W = Math.max(grid.W, 1);
  const H = Math.max(grid.H, 1);
  const cellW = rect.w / W;
  const cellH = rect.h / H;
  // Fit a glyph within the smaller cell dimension so it never overflows its rect.
  const fontPx = Math.max(6, Math.min(cellW, cellH) * 0.95);
  const cells: string[] = [];
  for (let r = 0; r < grid.rows.length; r += 1) {
    const row = grid.rows[r];
    for (let c = 0; c < row.length; c += 1) {
      const ch = row[c];
      if (ch === " ") continue;
      const left = rect.x0 + (c / W) * rect.w;
      const top = rect.y0 + (r / H) * rect.h;
      cells.push(
        `<span class="cell" style="left:${left.toFixed(3)}px;top:${top.toFixed(3)}px;` +
          `width:${cellW.toFixed(3)}px;height:${cellH.toFixed(3)}px;` +
          `font-size:${fontPx.toFixed(2)}px;">${esc(ch)}</span>`,
      );
    }
  }
  return cells.join("");
}

// Pure: compute the letterboxed image rect for a native (imgW x imgH) image displayed inside a
// (panelW x panelH) box at its native aspect, centred (bars on the short axis). Used by the overlay so
// the camera render is NEVER stretched.
export function letterboxRect(
  imgW: number,
  imgH: number,
  panelW: number,
  panelH: number,
): RenderRect {
  const scale = Math.min(panelW / Math.max(imgW, 1), panelH / Math.max(imgH, 1));
  const w = imgW * scale;
  const h = imgH * scale;
  const x0 = (panelW - w) / 2;
  const y0 = (panelH - h) / 2;
  return { x0, y0, w, h };
}
