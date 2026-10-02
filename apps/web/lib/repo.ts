import { MemoryRepository, type Repository } from "@recast/store";

/**
 * Demo mode: an in-memory repository seeded with example data, so the control center runs and
 * is testable with no cloud project. A Supabase-backed repository replaces this once a project
 * exists (see docs/10-layer4-control-center.md); the pages only ever see `Repository`.
 */
async function seed(r: Repository) {
  await r.putObject({ id: "person-meera", kind: "Person", title: "Meera Iyer", data: { email: "meera@example.com" }, source: "Page metadata" });
  await r.putObject({ id: "place-toit", kind: "Location", title: "Toit", data: { address: "298 100 Feet Rd, Indiranagar, Bengaluru" }, source: "Page metadata (microdata)" });
  await r.putObject({ id: "event-launch", kind: "Event", title: "Launch dinner", data: { start: "2026-11-14T19:30" }, source: "Page metadata (JSON-LD)" });
  await r.putRelationship({ id: "rel-1", relation: "attendee", fromId: "person-meera", toId: "event-launch" });
  await r.putRelationship({ id: "rel-2", relation: "location", fromId: "place-toit", toId: "event-launch" });
  await r.setIntegration({ destination: "google-calendar.event-editor", app: "Google Calendar", reliability: "official-api", enabled: true });
  await r.setIntegration({ destination: "mail.compose", app: "Mail compose window", reliability: "accessibility", enabled: true });
  await r.setIntegration({ destination: "legacy.crm", app: "Legacy CRM", reliability: "keyboard-simulation", enabled: false });
  await r.grant({ id: "grant-gcal", destination: "google-calendar.event-editor", scope: "Create and edit events" });
  await r.grant({ id: "grant-mail", destination: "mail.compose", scope: "Fill the To field" });
}

const g = globalThis as unknown as { __recastRepo?: Promise<Repository> };
export function getRepo(): Promise<Repository> {
  g.__recastRepo ??= (async () => { const r = new MemoryRepository(); await seed(r); return r; })();
  return g.__recastRepo;
}
export const reliabilityLabel: Record<string, { label: string; hint: string }> = {
  "official-api": { label: "Reliable", hint: "Uses the app's official interface." },
  accessibility: { label: "Usually works", hint: "Reads and fills the app through its accessibility layer." },
  "keyboard-simulation": { label: "Best effort", hint: "Types for you. Can break if the app changes." },
  visual: { label: "Last resort", hint: "Finds things on screen. Slowest and least certain." },
  manual: { label: "You do it", hint: "Recast shows you what to enter." },
};
