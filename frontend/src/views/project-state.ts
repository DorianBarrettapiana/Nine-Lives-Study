/**
 * Shared cache of the user's projects.
 *
 * Every place that needs to render a project picker / chip pulls from
 * here instead of re-fetching `/projects` each time. A single in-app event
 * (`projects:updated`) signals any open pickers to re-render after a CRUD
 * operation in the Projects view.
 */

import { listProjects, type ProjectRead } from "../api/projects";

let cache: ProjectRead[] = [];
let inFlight: Promise<ProjectRead[]> | null = null;

export function getCachedProjects(): ProjectRead[] {
  return cache;
}

export function getActiveProjects(): ProjectRead[] {
  return cache.filter((p) => !p.is_archived);
}

export function findProject(id: number | null): ProjectRead | undefined {
  if (id === null) return undefined;
  return cache.find((p) => p.id === id);
}

export async function refreshProjects(force = false): Promise<ProjectRead[]> {
  if (!force && inFlight) return inFlight;
  inFlight = (async () => {
    try {
      // include_archived=true so chips on historical tasks/notes can still
      // resolve a name even after the user archives the project.
      cache = await listProjects(true);
      return cache;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Fire-and-forget: tells listening pickers to re-render. */
export function notifyProjectsUpdated(): void {
  window.dispatchEvent(new CustomEvent("projects:updated"));
}
