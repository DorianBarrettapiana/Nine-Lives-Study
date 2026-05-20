/**
 * Small pixel icons used inline in buttons and status lines.
 *
 * These are intentionally fixed-color (no theme variables) — they read as
 * stickers / illustrations, and changing them with theme would weaken the
 * "this is the cheer icon" / "this is the streak icon" recognition.
 */

type Palette = Record<string, string>;

function renderPixelSprite(rows: readonly string[], palette: Palette, pixelSize: number): string {
  const H = rows.length;
  const W = rows[0].length;
  let rects = "";
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = rows[y][x];
      if (c === ".") continue;
      const fill = palette[c];
      if (!fill) continue;
      rects += `<rect x="${x * pixelSize}" y="${y * pixelSize}" width="${pixelSize}" height="${pixelSize}" fill="${fill}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W * pixelSize} ${H * pixelSize}" width="${W * pixelSize}" height="${H * pixelSize}" shape-rendering="crispEdges" style="image-rendering:pixelated;vertical-align:middle">${rects}</svg>`;
}

// --- Beer mug (Cheer icon) -------------------------------------------------
//   O outline   W foam   B amber beer   H bubble highlight
const BEER_ROWS = [
  "...WW.WWW....",
  "..WWWWWWWW...",
  ".WWWWWWWWWW..",
  "OBBBBBBBBBO..",
  "OBHBBBBHBBO..",
  "OBBBBBBBBBOOO",
  "OBBBHBBBBBO.O",
  "OBBBBBBBBBO.O",
  "OBHBBBBBBBOOO",
  "OBBBBBBBBBO..",
  "OBBBBBBBBBO..",
  ".OOOOOOOOO...",
] as const;
const BEER_PALETTE: Palette = {
  O: "#3b2f1c", // dark brown glass outline
  W: "#fef9c3", // foam (cream)
  B: "#d97706", // amber beer
  H: "#fbbf24", // bubble highlight
};

/** Beer-mug pixel sprite. Default size is sized for inline-text use. */
export function renderBeerIconSvg(pixelSize: number = 2): string {
  return renderPixelSprite(BEER_ROWS, BEER_PALETTE, pixelSize);
}

// --- Flame (Streak icon) ---------------------------------------------------
//   O outline   B body   C bright core
const FLAME_ROWS = [
  "...O...",
  "..OBO..",
  "..OBO..",
  ".OBBBO.",
  ".OBCBO.",
  "OBBCBBO",
  "OBCCCBO",
  "OBBCBBO",
  ".OBBBO.",
  "..OOO..",
] as const;
const FLAME_PALETTE: Palette = {
  O: "#7c2d12", // dark red-brown outline
  B: "#f59e0b", // orange body (same as the running second hand)
  C: "#fde68a", // bright yellow core
};

/** Flame pixel sprite, used inline before the streak counter. */
export function renderFlameIconSvg(pixelSize: number = 2): string {
  return renderPixelSprite(FLAME_ROWS, FLAME_PALETTE, pixelSize);
}
