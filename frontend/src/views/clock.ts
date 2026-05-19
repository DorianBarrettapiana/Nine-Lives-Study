/**
 * Pixel analog clock — main visual for the stopwatch widget.
 *
 * Pure inline SVG (no canvas, no external assets). Three hands move in
 * pixel-discrete steps so the look stays consistent with the avatars:
 * the second hand snaps every second, the minute hand snaps every minute,
 * the hour hand interpolates within the hour.
 *
 * Cat ears sit on top of the rim — their inner fill picks up the user's
 * current avatar body color so the clock visually belongs to "their" cat.
 */

import { CAT_SKINS } from "./avatar";

// 5×5 ear pattern. Bottom row attaches to the clock rim.
//   .  empty   O  outline   B  ear body fill   P  inner pink (ear canal)
const EAR_PATTERN = [
  "..O..",
  ".OBO.",
  ".OBBO",
  "OBPBO",
  "OBBBO",
] as const;

type Grid = (string | null)[][];

function makeGrid(n: number): Grid {
  return Array.from({ length: n }, () => Array<string | null>(n).fill(null));
}

function plot(g: Grid, x: number, y: number, color: string): void {
  if (x < 0 || y < 0 || x >= g.length || y >= g.length) return;
  g[y][x] = color;
}

/** Midpoint circle algorithm — used for the rim. */
function drawCircle(g: Grid, cx: number, cy: number, r: number, color: string): void {
  let x = r;
  let y = 0;
  let err = 1 - r;
  while (x >= y) {
    const offsets: [number, number][] = [
      [x, y], [y, x], [-x, y], [-y, x],
      [-x, -y], [-y, -x], [x, -y], [y, -x],
    ];
    for (const [dx, dy] of offsets) plot(g, cx + dx, cy + dy, color);
    y++;
    if (err < 0) err += 2 * y + 1;
    else { x--; err += 2 * (y - x) + 1; }
  }
}

/** Bresenham line — used for ticks and hands. */
function drawLine(g: Grid, x0: number, y0: number, x1: number, y1: number, color: string): void {
  const dx = Math.abs(x1 - x0);
  const dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  let x = x0;
  let y = y0;
  // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
  while (true) {
    plot(g, x, y, color);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}

/** A two-pixel-thick line along the major axis, for the hour/minute hands. */
function drawThickLine(g: Grid, x0: number, y0: number, x1: number, y1: number, color: string): void {
  drawLine(g, x0, y0, x1, y1, color);
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  if (dx >= dy) drawLine(g, x0, y0 + 1, x1, y1 + 1, color);
  else          drawLine(g, x0 + 1, y0, x1 + 1, y1, color);
}

function handEnd(cx: number, cy: number, angleDeg: number, len: number): [number, number] {
  const a = (angleDeg - 90) * Math.PI / 180;
  return [Math.round(cx + Math.cos(a) * len), Math.round(cy + Math.sin(a) * len)];
}

function bodyColorFor(skinId: string | null | undefined): string {
  const skin = (skinId && CAT_SKINS.find((s) => s.id === skinId)) || CAT_SKINS[0];
  return skin.B;
}

export interface AnalogClockOptions {
  seconds: number;
  running: boolean;
  catSkin: string;
  /** Default 11 cells; produces a ~150 px wide clock at pixelSize=6. */
  radius?: number;
  /** Default 6 — each grid cell is rendered as a 6×6 SVG rect. */
  pixelSize?: number;
}

/**
 * Return an `<svg>` string for the analog clock at the given moment.
 * All UI colors except the second hand and ear fill go through CSS
 * variables (`var(--text)`, `var(--text-soft)`, `var(--accent)`,
 * `var(--text-muted)`) so the same markup adapts to dark/light themes.
 */
export function renderAnalogClockSvg(opts: AnalogClockOptions): string {
  const radius = opts.radius ?? 11;
  const pixelSize = opts.pixelSize ?? 6;
  const EAR_HEIGHT = 5;
  const cellN = radius * 2 + 5 + EAR_HEIGHT;
  const cx = Math.floor(cellN / 2);
  const cy = Math.floor(cellN / 2) + Math.ceil(EAR_HEIGHT / 2);

  const g = makeGrid(cellN);

  const RIM       = "var(--text-soft)";
  const TICK      = "var(--text-soft)";
  const HR_HAND   = "var(--text)";
  const MIN_HAND  = "var(--accent)";
  const SEC_HAND  = opts.running ? "#f59e0b" : "var(--text-muted)";
  const PIVOT     = opts.running ? "#f59e0b" : "var(--text-muted)";
  const EAR_OUT   = "var(--text-soft)";
  const EAR_FILL  = bodyColorFor(opts.catSkin);
  const EAR_INNER = "#d96b8a"; // shared cat-nose pink across all avatars

  // --- Cat ears (drawn first so the rim overlaps their bases) -------------
  const earOffsetX = Math.max(3, Math.floor(radius * 0.5) - 1);
  const earBaseY0 = (cy - radius) + 1 - (EAR_PATTERN.length - 1);

  const drawEar = (originX: number, originY: number, mirror: boolean): void => {
    for (let row = 0; row < EAR_PATTERN.length; row++) {
      const line = EAR_PATTERN[row];
      for (let col = 0; col < line.length; col++) {
        const ch = mirror ? line[line.length - 1 - col] : line[col];
        if (ch === ".") continue;
        let color = "";
        if (ch === "O") color = EAR_OUT;
        else if (ch === "B") color = EAR_FILL;
        else if (ch === "P") color = EAR_INNER;
        if (color) plot(g, originX + col, originY + row, color);
      }
    }
  };
  drawEar(cx - earOffsetX - 2, earBaseY0, false);  // left
  drawEar(cx + earOffsetX - 2, earBaseY0, true);   // right

  // --- Rim + tick marks --------------------------------------------------
  drawCircle(g, cx, cy, radius, RIM);
  for (let i = 0; i < 12; i++) {
    const angle = i * 30;
    const long = i % 3 === 0;
    const [tx0, ty0] = handEnd(cx, cy, angle, radius - 1);
    const [tx1, ty1] = handEnd(cx, cy, angle, radius - (long ? 3 : 2));
    drawLine(g, tx0, ty0, tx1, ty1, TICK);
  }

  // --- Hands -------------------------------------------------------------
  // 12 o'clock = 0 elapsed; sweep clockwise. Hour hand interpolates within
  // the hour for a smoother visual; minute and second hands snap.
  const s = Math.max(0, opts.seconds);
  const hh = (s / 3600) % 12;
  const mm = (s / 60) % 60;
  const ss = s % 60;
  const hourLen = Math.floor(radius * 0.45);
  const minuteLen = Math.floor(radius * 0.7);
  const secondLen = Math.floor(radius * 0.85);

  const [hex, hey] = handEnd(cx, cy, hh * 30, hourLen);
  const [mex, mey] = handEnd(cx, cy, Math.floor(mm) * 6, minuteLen);
  const [sex, sey] = handEnd(cx, cy, Math.floor(ss) * 6, secondLen);
  drawThickLine(g, cx, cy, hex, hey, HR_HAND);
  drawThickLine(g, cx, cy, mex, mey, MIN_HAND);
  drawLine(g, cx, cy, sex, sey, SEC_HAND);

  // --- Pivot (3×3) -------------------------------------------------------
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) plot(g, cx + dx, cy + dy, PIVOT);
  }

  // --- Emit SVG ----------------------------------------------------------
  let rects = "";
  for (let y = 0; y < cellN; y++) {
    for (let x = 0; x < cellN; x++) {
      const c = g[y][x];
      if (!c) continue;
      rects += `<rect x="${x * pixelSize}" y="${y * pixelSize}" width="${pixelSize}" height="${pixelSize}" fill="${c}"/>`;
    }
  }
  const W = cellN * pixelSize;
  return `<svg xmlns="http://www.w3.org/2000/svg" class="analog-clock-svg" viewBox="0 0 ${W} ${W}" width="${W}" height="${W}" shape-rendering="crispEdges">${rects}</svg>`;
}
