import "server-only";
import { MemoryRepository, userRepository, type Repository } from "@recast/store";
import { requireSession } from "./auth";
import { getPool } from "./db";

/**
 * With DATABASE_URL: Postgres (the Supabase migrations), every call as the signed-in person, so row-level security
 * decides what they see. Without it: the demo, an in-memory repository seeded with example data.
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
export async function getRepo(): Promise<Repository> {
  const session = await requireSession();
  const pool = getPool();
  if (pool) return userRepository(pool, session.userId);
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
