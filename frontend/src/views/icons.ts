/**
 * Small pixel icons used inline in buttons and status lines.
 *
 * These are intentionally fixed-color (no theme variables) — they read as
 * stickers / illustrations, and changing them with theme would weaken the
 * "this is the cheer icon" / "this is the streak icon" recognition.
 */

import { CAT_SKINS } from "./avatar";
import { getCurrentCatSkin } from "./user-state";

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

// --- Sleeping cat with Zzz (empty-state illustration) ----------------------
//
// 20×14 sprite — front-facing cat head with closed eyes + 3 graduated Z's
// drifting up-right. Body color follows the user's current avatar skin so
// empty states feel personal.
//   O = outline (skin.O)   B = body (skin.B)   E = closed-eye line (skin.O)
//   N = nose pink (fixed)  Z = drifting Z's (fixed muted gray)
const SLEEPING_CAT_ROWS = [
  "................ZZZZ",
  "..................Z.",
  ".................Z..",
  "................ZZZZ",
  "..............ZZZZ..",
  ".OO......OO.....Z...",
  ".OBO....OBO....Z....",
  "OBBOOOOOOBBO..ZZZZ..",
  "OBBBBBBBBBBOZZZZ....",
  "OBBEEBBEEBBO..Z.....",
  "OBBBBNNBBBBO.Z......",
  ".OBBBBBBBBO.ZZZZ....",
  "..OOOOOOOO..........",
  "....................",
] as const;
const SLEEPING_Z_COLOR = "#9ca3af"; // muted gray; readable on both themes.

/** Render a sleeping cat with drifting Zzz, tinted to the given skin id.
 *  Falls back to the default (tabby) on unknown ids so call sites don't
 *  have to validate input. Default pixelSize keeps it small enough to fit
 *  inside an `.empty-state` block without dominating the message. */
export function renderSleepingCatSvg(skinId: string | null | undefined, pixelSize: number = 3): string {
  const skin = (skinId && CAT_SKINS.find((s) => s.id === skinId)) || CAT_SKINS[0];
  const palette: Palette = {
    O: skin.O,
    B: skin.B,
    E: skin.O,       // closed eye uses the outline color
    N: "#d96b8a",    // shared nose pink across all cats
    Z: SLEEPING_Z_COLOR,
  };
  return renderPixelSprite(SLEEPING_CAT_ROWS, palette, pixelSize);
}

/** Convenience: build the standard `<div class="empty-state">` block with
 *  a sleeping-cat illustration above the message. Cat tint follows the
 *  user's currently-selected skin (read at call time, so re-renders after
 *  a skin change pick up the new value).
 *
 *  `message` is rendered verbatim — pass plain text only; if you need to
 *  inject user-provided content, escape it first. */
export function renderEmptyStateWithCat(message: string): string {
  return `<div class="empty-state with-cat">
    <div class="empty-cat">${renderSleepingCatSvg(getCurrentCatSkin())}</div>
    <div>${message}</div>
  </div>`;
}

// --- Flower (like reaction) -----------------------------------------------
// Tiny 3×5 X-shape: 4 corner petals + yellow center + 2-pixel green stem.
// Style references the user's 8-bit reference image — deliberately minimal.
const FLOWER_ROWS = [
  "P.P",
  ".Y.",
  "P.P",
  ".G.",
  ".G.",
] as const;
const FLOWER_PALETTE: Palette = {
  P: "#f9a8d4", // pink petal
  Y: "#fbbf24", // yellow stamen
  G: "#65a30d", // green stem
};
/** X-shaped pixel flower used inline as the "like" icon. */
export function renderFlowerIconSvg(pixelSize: number = 3): string {
  return renderPixelSprite(FLOWER_ROWS, FLOWER_PALETTE, pixelSize);
}

// --- Sun (light theme indicator) ------------------------------------------
// 13×13: 8 short rays (4 cardinal + 4 corner) + outlined yellow disc with
// a bright cream core. Color family matches the streak flame.
const SUN_ROWS = [
  "......X......",
  "X...........X",
  "....OOOOO....",
  "..OOYYYYYOO..",
  ".OYYYCCCYYYO.",
  "OYYYCCCCCYYYO",
  "X.OYCCCCCYO.X",
  "OYYYCCCCCYYYO",
  ".OYYYCCCYYYO.",
  "..OOYYYYYOO..",
  "....OOOOO....",
  "X...........X",
  "......X......",
] as const;
const SUN_PALETTE: Palette = {
  O: "#7c2d12", // dark red-brown outline (shared with flame)
  X: "#f59e0b", // orange ray (shared with second hand)
  Y: "#fbbf24", // yellow body
  C: "#fde68a", // bright cream core
};
/** Pixel sun for the theme toggle (dark → light). */
export function renderSunIconSvg(pixelSize: number = 2): string {
  return renderPixelSprite(SUN_ROWS, SUN_PALETTE, pixelSize);
}

// --- Moon (dark theme indicator) ------------------------------------------
// 13×13 crescent: outlined disc, cream visible crescent on the left, dark
// indigo "night sky" interior with 3 yellow stars scattered inside.
const MOON_ROWS = [
  "....OOOOO....",
  "..OOCCCDDOO..",
  ".OCCCCDDDDDO.",
  "OCCCCCDDDDDDO",
  "OCCCCCDSDDDDO",
  "OCCCCCDDDDDDO",
  "OCCCCCDDDSDDO",
  "OCCCCCDDDDDDO",
  "OCCCCCDDSDDDO",
  "OCCCCCDDDDDDO",
  ".OCCCCDDDDDO.",
  "..OOCCCDDOO..",
  "....OOOOO....",
] as const;
const MOON_PALETTE: Palette = {
  O: "#1f1438", // very dark indigo outline
  C: "#fef9c3", // cream crescent body
  D: "#312e81", // dark indigo night sky
  S: "#fbbf24", // yellow star
};
/** Pixel crescent moon for the theme toggle (light → dark). */
export function renderMoonIconSvg(pixelSize: number = 2): string {
  return renderPixelSprite(MOON_ROWS, MOON_PALETTE, pixelSize);
}
