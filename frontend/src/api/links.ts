/**
 * Bidirectional `[[Title]]` link client.
 *
 * The endpoint returns BOTH directions in one shot (backlinks + outgoing)
 * because they're rendered together on every detail card, and the same
 * server-side query already touches both indexes.
 */

import { apiFetch } from "./client";

export type LinkItemType = "paper_note" | "feynman_entry";

export interface LinkedItemRef {
  item_type: LinkItemType;
  item_id: number;
  title: string;
}

export interface BacklinkEntry {
  source: LinkedItemRef;
  label: string;
}

export interface OutgoingLink {
  target: LinkedItemRef;
  label: string;
}

export interface BacklinksRead {
  backlinks: BacklinkEntry[];
  outgoing: OutgoingLink[];
}

export async function getLinks(
  itemType: LinkItemType,
  itemId: number,
): Promise<BacklinksRead> {
  const params = new URLSearchParams({
    item_type: itemType,
    item_id: String(itemId),
  });
  return apiFetch<BacklinksRead>(`/links?${params.toString()}`);
}
