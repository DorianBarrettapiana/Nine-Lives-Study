/**
 * Pixel-cat avatars.
 *
 * One 16x16 sprite is reused across all skins; only the palette changes.
 * Render is an inline SVG (no external assets, no extra HTTP).
 */

// Symbols:
//   .  empty
//   O  outline (silhouette + eye outline)
//   B  body / fur primary color
//   E  eye fill
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

export interface CatPalette {
  id: string;
  name: string;
  O: string;
  B: string;
  E: string;
  N: string;
  W: string;
}

// Keep IDs in sync with backend/app/schemas/user.py CatSkin.
export const CAT_SKINS: CatPalette[] = [
  { id: "tabby",   name: "Orange tabby", O: "#3a1f0d", B: "#e08e3c", E: "#1d3a25", N: "#d96b8a", W: "#f7e6c8" },
  { id: "black",   name: "Black",        O: "#070708", B: "#2a2a30", E: "#9bc850", N: "#d96b8a", W: "#3d3d44" },
  { id: "white",   name: "White",        O: "#5a5345", B: "#f3f0e8", E: "#3d82c9", N: "#d96b8a", W: "#ffffff" },
  { id: "gray",    name: "Gray",         O: "#1d2128", B: "#8d96a3", E: "#c4d040", N: "#d96b8a", W: "#cdd2da" },
  { id: "calico",  name: "Calico",       O: "#2a1810", B: "#f0c074", E: "#3d6b32", N: "#d96b8a", W: "#fbf4e3" },
  { id: "siamese", name: "Siamese",      O: "#2e1f15", B: "#ead9b8", E: "#5fb3d1", N: "#d96b8a", W: "#f7ecd4" },
];

const SKIN_BY_ID = new Map(CAT_SKINS.map((s) => [s.id, s]));

function paletteFor(skinId: string | null | undefined): CatPalette {
  return (skinId && SKIN_BY_ID.get(skinId)) || CAT_SKINS[0];
}

/**
 * Return an `<svg>` string sized to `displayPx` pixels, drawing the pixel cat
 * for the given skin id. Falls back to the default skin if id is unknown.
 */
export function renderAvatarSvg(skinId: string | null | undefined, displayPx: number = 64): string {
  const palette = paletteFor(skinId) as unknown as Record<string, string>;
  const W = SHAPE[0].length;
  const H = SHAPE.length;
  // Each pixel is rendered at 8px in viewBox units so the SVG scales cleanly.
  const PX = 8;
  let rects = "";
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const c = SHAPE[y][x];
      if (c === "." || !palette[c]) continue;
      rects += `<rect x="${x * PX}" y="${y * PX}" width="${PX}" height="${PX}" fill="${palette[c]}"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W * PX} ${H * PX}" width="${displayPx}" height="${displayPx}" shape-rendering="crispEdges" style="image-rendering:pixelated">${rects}</svg>`;
}
