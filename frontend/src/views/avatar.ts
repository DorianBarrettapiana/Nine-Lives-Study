/**
 * Pixel-cat avatars.
 *
 * One 16x16 base sprite is shared across all skins. Solid-color skins just
 * swap the 5-slot palette (O/B/E/N/W). Patterned skins (tortie, ragdoll,
 * cow) layer a sparse overlay that recolors specific B/W pixels with one
 * or two accent colors (S1/S2).
 *
 * Rendering is inline SVG with shape-rendering:crispEdges — no external
 * assets, no extra HTTP, scales cleanly to any pixel size.
 */

// Base layer symbols:
//   .  empty
//   O  outline (silhouette + eye outline)
//   B  body / fur primary
//   E  eye
//   N  nose
//   W  belly / chest white
const SHAPE = [
  ".OO.........OO..",
  ".OBO.......OBO..",
  ".OBBOOOOOOOBBO..",
  ".OBBBBBBBBBBBBO.",
  "OBBBBBBBBBBBBBBO",
  "OBEEBBBBBBBBEEBO",
  "OBEEBBBBBBBBEEBO",
  "OBBBBBBBNNBBBBBO",
  "OBBBBBBBBBBBBBBO",
  ".OBBBBBBBBBBBBO.",
  "..OBBBBBBBBBBO..",
  "...OBWWWWWWBO...",
  "...OBWWWWWWBO...",
  "...OBBBBBBBBO...",
  "....OOO..OOO....",
  "................",
];

// Overlay symbols (only meaningful on B or W base pixels):
//   .  no overlay
//   1  paint with palette.S1
//   2  paint with palette.S2
// Outline / eyes / nose are never recolored — keeps the face readable.

const COW_PATCHES = [
  "..1.........1...",
  "..11.......11...",
  "..11111....111..",
  "..1111111..1111.",
  "11111111....111.",
  "1111............",
  "111.............",
  "................",
  "................",
  "................",
  "................",
  "....1111111.....",
  "....1111111.....",
  "....11111.......",
  "................",
  "................",
];

const RAGDOLL_POINTS = [
  ".11.........11..",
  ".11.........11..",
  ".11........11...",
  "................",
  "................",
  "................",
  "................",
  ".......1111.....",
  "......111111....",
  "................",
  "................",
  "................",
  "................",
  "................",
  "....111..111....",
  "................",
];

const TORTIE_PATCHES = [
  "................",
  "................",
  "................",
  "....11.....22...",
  "...111.....222..",
  "................",
  "................",
  ".....22.........",
  "........22..11..",
  "...........111..",
  "................",
  ".....222...11...",
  ".....222...11...",
  "................",
  "................",
  "................",
];

export interface CatPalette {
  id: string;
  name: string;
  O: string;
  B: string;
  E: string;
  N: string;
  W: string;
  // Optional pattern overlay.
  S1?: string;
  S2?: string;
  patches?: readonly string[];
}

// Keep IDs in sync with backend/app/schemas/user.py CatSkin.
export const CAT_SKINS: CatPalette[] = [
  { id: "tabby",   name: "Orange tabby",  O: "#3a1f0d", B: "#e08e3c", E: "#1d3a25", N: "#d96b8a", W: "#f7e6c8" },
  { id: "black",   name: "Black",         O: "#070708", B: "#2a2a30", E: "#9bc850", N: "#d96b8a", W: "#3d3d44" },
  { id: "white",   name: "White",         O: "#5a5345", B: "#f3f0e8", E: "#3d82c9", N: "#d96b8a", W: "#ffffff" },
  { id: "gray",    name: "Gray",          O: "#1d2128", B: "#8d96a3", E: "#c4d040", N: "#d96b8a", W: "#cdd2da" },
  { id: "calico",  name: "Calico",        O: "#2a1810", B: "#f0c074", E: "#3d6b32", N: "#d96b8a", W: "#fbf4e3" },
  { id: "siamese", name: "Siamese",       O: "#2e1f15", B: "#ead9b8", E: "#5fb3d1", N: "#d96b8a", W: "#f7ecd4" },
  { id: "tortie",  name: "Tortoiseshell", O: "#1a0e07", B: "#2a1810", E: "#c0a040", N: "#d96b8a", W: "#3a2618",
    S1: "#c66a1f", S2: "#e8c97d", patches: TORTIE_PATCHES },
  { id: "ragdoll", name: "Ragdoll",       O: "#5a4634", B: "#f4ead6", E: "#4ea3d8", N: "#d96b8a", W: "#ffffff",
    S1: "#7d4f33", patches: RAGDOLL_POINTS },
  { id: "cow",     name: "Cow cat",       O: "#0a0a0d", B: "#f3f0e8", E: "#7ec050", N: "#d96b8a", W: "#ffffff",
    S1: "#1a1a1f", patches: COW_PATCHES },
];

const SKIN_BY_ID = new Map(CAT_SKINS.map((s) => [s.id, s]));

function paletteFor(skinId: string | null | undefined): CatPalette {
  return (skinId && SKIN_BY_ID.get(skinId)) || CAT_SKINS[0];
}

/**
 * Return an `<svg>` string sized to `displayPx`, drawing the pixel cat
 * for the given skin id. Unknown id → falls back to the default skin.
 */
export function renderAvatarSvg(skinId: string | null | undefined, displayPx: number = 64): string {
  const palette = paletteFor(skinId);
  const W = SHAPE[0].length;
  const H = SHAPE.length;
  const PX = 8;
  let rects = "";
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const base = SHAPE[y][x];
      if (base === ".") continue;
      let fill: string | undefined;
      if (base === "B" || base === "W") {
        const overlay = palette.patches ? palette.patches[y][x] : ".";
        if (overlay === "1" && palette.S1) fill = palette.S1;
        else if (overlay === "2" && palette.S2) fill = palette.S2;
        else fill = base === "B" ? palette.B : palette.W;
      } else if (base === "O") fill = palette.O;
      else if (base === "E") fill = palette.E;
      else if (base === "N") fill = palette.N;
      if (!fill) continue;
      rects += `<rect x="${x * PX}" y="${y * PX}" width="${PX}" height="${PX}" fill="${fill}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W * PX} ${H * PX}" width="${displayPx}" height="${displayPx}" shape-rendering="crispEdges" style="image-rendering:pixelated">${rects}</svg>`;
}
