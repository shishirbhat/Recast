// A real host for the machine: performs effects with the real core (propose/plan/commit/undo) and a real
// in-memory destination. The only things faked are the screen and the pointer, which a test has to supply.
import { InMemoryEventLog, commit, resolve, undo } from "@recast/core";
import type { Bridge, Candidate as CoreCandidate, CapabilityContract, Operation, Receipt } from "@recast/core";
import { contains, initialState, reduce } from "../src/index.js";
import type { Candidate, Destination, Effect, Event, State } from "../src/index.js";

type WithoutNow<E> = E extends { now: number } ? Omit<E, "now"> & { now?: number } : never;
export type EventInput = WithoutNow<Event>;

export const calendar: CapabilityContract = {
  destination: "google-calendar.event-editor", app: "Google Calendar", targetKind: "Event", reliability: "official-api",
  accepts: [
    { relationId: "person-event-attendee", effect: "Add attendee", effectFlags: ["notifies-third-party"], dataMoved: ["Person.name", "Person.email"] },
    { relationId: "location-event-location", effect: "Set location", dataMoved: ["Location.name", "Location.address"] },
  ],
};
export const mailSend: CapabilityContract = {
  destination: "mail.send-now", app: "Mail", targetKind: "Message", reliability: "structured-interface",
  accepts: [{ relationId: "person-message-recipient", effect: "Send to person", effectFlags: ["send"], dataMoved: ["Person.email"] }],
};
export const tasks: CapabilityContract = {
  destination: "tasks.task", app: "Tasks", targetKind: "Task", reliability: "deep-link",
  accepts: [{ relationId: "document-task-reference", effect: "Attach reference", dataMoved: ["Document.title", "Document.url"] }],
};

export class MemoryBridge implements Bridge {
  state: string[] = []; failNext = false;
  constructor(private c: CapabilityContract) {}
  describe() { return this.c; }
  async execute(op: Operation) {
    if (this.failNext) { this.failNext = false; throw new Error("destination unavailable"); }
    const line = `${op.proposal.effect}|${op.dataMoved.map((d) => d.value).join("|")}`;
    this.state.push(line); return { ref: line };
  }
  async undo(r: Receipt) { this.state = this.state.filter((l) => l !== r.bridgeRef); }
}

const ev = (k: string) => [{ locator: { kind: "css" as const, value: `#${k}` } }];
export function obj(type: CoreCandidate["type"], properties: Record<string, unknown>, confidence = 0.95) {
  return resolve({
    type, properties, fields: Object.fromEntries(Object.keys(properties).map((k) => [k, { confidence, evidence: ev(k) }])),
    provenance: { source: { app: "test" }, capture: { method: "dom", adapter: "test", at: "2026-09-30T10:00:00Z" } },
  });
}

export const R = {
  meera: { x: 20, y: 20, w: 140, h: 30 }, noEmail: { x: 20, y: 60, w: 140, h: 30 }, toit: { x: 20, y: 100, w: 140, h: 30 }, shaky: { x: 20, y: 140, w: 140, h: 30 },
  calendar: { x: 300, y: 20, w: 300, h: 260 }, mail: { x: 300, y: 320, w: 300, h: 200 }, tasks: { x: 700, y: 20, w: 200, h: 200 },
};

export function scene() {
  const candidates: Candidate[] = [
    { id: "meera", rect: R.meera, object: obj("Person", { name: "Meera Iyer", email: ["meera@example.com"] }) },
    { id: "noemail", rect: R.noEmail, object: obj("Person", { name: "No Email" }) },
    { id: "toit", rect: R.toit, object: obj("Location", { name: "Toit", address: "298 100 Feet Rd, Bengaluru" }) },
    { id: "shaky", rect: R.shaky, object: obj("Person", { name: "Maybe Meera", email: ["maybe@example.com"] }, 0.4) },
  ];
  const destinations: Destination[] = [
    { id: "calendar", label: "Google Calendar", rect: R.calendar, contract: calendar },
    { id: "mail", label: "Mail", rect: R.mail, contract: mailSend },
    { id: "tasks", label: "Tasks", rect: R.tasks, contract: tasks },
  ];
  return { candidates, destinations };
}

export class Driver {
  state: State = initialState(0);
  effects: Effect[] = []; log: Effect[] = [];
  bridges: Record<string, MemoryBridge> = { "google-calendar.event-editor": new MemoryBridge(calendar), "mail.send-now": new MemoryBridge(mailSend), "tasks.task": new MemoryBridge(tasks) };
  eventLog = new InMemoryEventLog();
  clock = 0;
  sc = scene();
  autoRun = true;

  send(e: EventInput): Effect[] {
    if (e.now !== undefined) this.clock = e.now;
    const r = reduce(this.state, { ...e, now: this.clock } as Event);
    this.state = r.state; this.effects = r.effects; this.log.push(...r.effects);
    return r.effects;
  }
  advance(ms: number) { this.clock += ms; return this.send({ type: "tick" }); }

  /** Answer hit-test effects from the scene, as a real host would. */
  hit(effects: Effect[] = this.effects) {
    for (const f of effects) if (f.type === "hitTest") {
      const candidate = this.sc.candidates.find((c) => contains(c.rect, f.p)) ?? null;
      const destination = this.sc.destinations.find((d) => contains(d.rect, f.p)) ?? null;
      this.send({ type: "hitResult", seq: f.seq, candidate, destination });
    }
  }
  move(x: number, y: number) { const fx = this.send({ type: "pointerMove", p: { x, y } }); this.hit(fx); }
  down(x: number, y: number) { const fx = this.send({ type: "pointerDown", p: { x, y } }); this.hit(fx); return fx; }
  up(x: number, y: number) { return this.send({ type: "pointerUp", p: { x, y } }); }
  key(key: string, down = true, shift = false) { return this.send({ type: "key", key, down, shift }); }

  /** Perform commit / undo / enumerate effects for real and feed the results back. */
  async run(effects: Effect[]) {
    for (const f of effects) {
      if (f.type === "enumerate") this.send({ type: "enumerated", candidates: this.sc.candidates, destinations: this.sc.destinations });
      if (f.type === "commit") {
        const bridge = this.bridges[f.op.proposal.destination.destination]!;
        try { const receipt = await commit(f.op, f.consent, { bridge, log: this.eventLog, now: () => new Date(this.clock).toISOString() }); this.send({ type: "committed", receipt }); }
        catch (err) { this.send({ type: "commitFailed", message: err instanceof Error ? err.message : String(err) }); }
      }
      if (f.type === "undo") {
        const bridge = this.bridges[f.receipt.destination]!;
        try { const receipt = await undo(f.receipt, { bridge, log: this.eventLog, now: () => new Date(this.clock).toISOString() }); this.send({ type: "undone", receipt }); }
        catch (err) { this.send({ type: "undoFailed", message: err instanceof Error ? err.message : String(err) }); }
      }
    }
  }
  /** Lift `id` with the pointer and carry it to (x,y). */
  lift(id: string) {
    const c = this.sc.candidates.find((x) => x.id === id)!;
    this.hit(this.send({ type: "liftKey", down: true }));
    this.move(c.rect.x + 5, c.rect.y + 5);
    this.down(c.rect.x + 5, c.rect.y + 5);
  }
}
