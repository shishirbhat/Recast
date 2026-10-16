import { gmailDraft, googleCalendar, googleSheets, googleTasks, notion, DestinationError, type Spec, type Transport } from "@recast/bridges";
import type { Receipt } from "@recast/core";
import { b64 } from "./b64";

// ---- What the caller says it is placing into, per destination --------------------------------------------------------
const field = (t: Record<string, unknown>, k: string, optional = false): string | undefined => {
  const v = t[k];
  if (v === undefined && optional) return undefined;
  if (typeof v !== "string" || !v || v.length > 256 || /[\0-\x1f]/.test(v)) throw new PlaceInputError(`target.${k} must be a string of 1 to 256 visible characters`);
  return v;
};
export class PlaceInputError extends Error {}

interface DestinationTarget { spec: Spec<any>; parse(t: Record<string, unknown>): Record<string, string> }
/** destination id -> its bridge and the fields that pick the exact calendar event, sheet range, task list or database. */
export const PLACE_TARGETS: Record<string, DestinationTarget> = {
  google_calendar: { spec: googleCalendar, parse: (t) => ({ calendarId: field(t, "calendar_id")!, eventId: field(t, "event_id")! }) },
  gmail: { spec: gmailDraft, parse: () => ({ userId: "me" }) },   // always the token owner's own mailbox; a caller cannot name another
  google_sheets: { spec: googleSheets, parse: (t) => ({ spreadsheetId: field(t, "spreadsheet_id")!, range: field(t, "range")! }) },
  google_tasks: { spec: googleTasks, parse: (t) => ({ taskListId: field(t, "task_list_id")! }) },
  notion: { spec: notion, parse: (t) => { const o: Record<string, string> = { databaseId: field(t, "database_id")! }; const tp = field(t, "title_property", true), up = field(t, "url_property", true); if (tp) o.titleProperty = tp; if (up) o.urlProperty = up; return o; } },
};

// ---- Network: the only hosts a placement may reach --------------------------------------------------------------------
export const DESTINATION_HOSTS = new Set(["www.googleapis.com", "gmail.googleapis.com", "sheets.googleapis.com", "tasks.googleapis.com", "api.notion.com"]);
/** Bridges speak through this. It adds the tenant's token, refuses any other host, never follows redirects and gives up after `timeoutMs`. */
export function fetchTransport(accessToken: string, f: typeof fetch = fetch, timeoutMs = 10_000): Transport {
  return async (req) => {
    const u = new URL(req.url);
    if (u.protocol !== "https:" || !DESTINATION_HOSTS.has(u.hostname)) throw new DestinationError(`refusing to call ${u.hostname}`);
    let res: Response;
    try {
      res = await f(req.url, {
        method: req.method, redirect: "error", signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: "application/json", ...(req.body !== undefined ? { "content-type": "application/json" } : {}), ...(req.headers ?? {}), authorization: `Bearer ${accessToken}` },
        ...(req.body !== undefined ? { body: JSON.stringify(req.body) } : {}),
      });
    } catch { throw new DestinationError(`${u.hostname} could not be reached`); }
    const text = await res.text(); let json: unknown = null; try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    return { status: res.status, json };
  };
}

// ---- Credentials ------------------------------------------------------------------------------------------------------
export interface Credential { accessToken: string }
export interface CredentialStore {
  get(tenantId: string, destination: string): Promise<Credential | null>;
  set(tenantId: string, destination: string, c: Credential): Promise<void>;
  remove(tenantId: string, destination: string): Promise<boolean>;
}
export class MemoryCredentialStore implements CredentialStore {
  private m = new Map<string, Credential>();
  async get(t: string, d: string) { return this.m.get(`${t}|${d}`) ?? null; }
  async set(t: string, d: string, c: Credential) { this.m.set(`${t}|${d}`, c); }
  async remove(t: string, d: string) { return this.m.delete(`${t}|${d}`); }
}

/** AES-256-GCM with the (tenant, destination) pair as associated data: a sealed token only opens for the row it was written for. */
export class CredentialCipher {
  private key: Promise<CryptoKey>;
  constructor(keyBase64: string) {
    const raw = b64.decode(keyBase64);
    if (raw.length !== 32) throw new Error("RECAST_CREDENTIALS_KEY must be 32 random bytes, base64-encoded");
    this.key = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  }
  static generateKey() { return b64.encode(crypto.getRandomValues(new Uint8Array(32))); }
  private aad = (t: string, d: string) => new TextEncoder().encode(`recast-credential|${t}|${d}`);
  async seal(t: string, d: string, c: Credential): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: this.aad(t, d) }, await this.key, new TextEncoder().encode(JSON.stringify(c))));
    return `v1:${b64.encode(iv)}:${b64.encode(ct)}`;
  }
  async open(t: string, d: string, sealed: string): Promise<Credential> {
    const [v, iv, ct] = sealed.split(":");
    if (v !== "v1" || !iv || !ct) throw new Error("unknown credential format");
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64.decode(iv), additionalData: this.aad(t, d) }, await this.key, b64.decode(ct));
    return JSON.parse(new TextDecoder().decode(pt)) as Credential;
  }
}

// ---- Placement records, for undo --------------------------------------------------------------------------------------
export interface PlacementRecord { tenantId: string; destination: string; target: Record<string, string>; receipt: Receipt; dataMoved: { path: string; value: string }[]; status: "done" | "undoing" | "undone" }
export interface PlacementStore {
  save(r: PlacementRecord): Promise<void>;
  get(tenantId: string, receiptId: string): Promise<PlacementRecord | null>;
  /** Atomically moves done -> undoing. False if it was not "done" (already undone, or another undo is running). */
  claimUndo(tenantId: string, receiptId: string): Promise<boolean>;
  finishUndo(tenantId: string, receiptId: string, ok: boolean, receipt?: Receipt): Promise<void>;
}
export class MemoryPlacementStore implements PlacementStore {
  private m = new Map<string, PlacementRecord>();
  async save(r: PlacementRecord) { this.m.set(r.receipt.receiptId, structuredClone(r)); }
  async get(t: string, id: string) { const r = this.m.get(id); return r && r.tenantId === t ? structuredClone(r) : null; }
  async claimUndo(t: string, id: string) { const r = this.m.get(id); if (!r || r.tenantId !== t || r.status !== "done") return false; r.status = "undoing"; return true; }
  async finishUndo(t: string, id: string, ok: boolean, receipt?: Receipt) { const r = this.m.get(id); if (!r || r.tenantId !== t) return; r.status = ok ? "undone" : "done"; if (ok && receipt) r.receipt = receipt; }
}

export interface PlacementDeps { credentials: CredentialStore; placements: PlacementStore; fetch?: typeof fetch; timeoutMs?: number }
