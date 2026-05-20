/**
 * Tiny shared store for the user's current avatar cat skin.
 *
 * Lets disconnected views (empty-state illustrations in notes, friends,
 * mood, …) read the same value without each having to be plumbed through
 * `init(user)`. main.ts is the sole writer; everyone else reads.
 *
 * No reactivity built-in — views that need to live-update on a skin
 * change should listen for the `cat:skin-changed` window event main.ts
 * dispatches after a successful picker save.
 */

let currentCatSkin = "tabby";

export function getCurrentCatSkin(): string {
  return currentCatSkin;
}

export function setCurrentCatSkin(skin: string): void {
  currentCatSkin = skin;
}
