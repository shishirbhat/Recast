import { resolve, perceive } from "../src/index.js";
import type { Bridge, Candidate, CapabilityContract, Operation, Receipt, SemanticObject } from "../src/index.js";

export const SRC = { app: "test-page", url: "https://example.org/x" };
export const AT = "2026-09-30T10:00:00Z";
let tick = 0;
export const clock = () => new Date(Date.UTC(2026, 8, 30, 10, 0, tick++)).toISOString().replace(".000Z", "Z");

const ev = (v: string) => [{ locator: { kind: "css" as const, value: v } }];
export function candidate(type: Candidate["type"], properties: Record<string, unknown>, confidence = 0.95): Candidate {
  return {
    type, properties,
    fields: Object.fromEntries(Object.keys(properties).map((k) => [k, { confidence, evidence: ev(`#${k}`) }])),
    provenance: { source: SRC, capture: { method: "dom", adapter: "test", at: AT } },
  };
}
export const obj = (type: Candidate["type"], properties: Record<string, unknown>, confidence?: number): SemanticObject =>
  resolve(candidate(type, properties, confidence));

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
  destination: "tasks.list", app: "Tasks", targetKind: "Task", reliability: "deep-link",
  accepts: [{ relationId: "document-task-reference", effect: "Attach reference", dataMoved: ["Document.title", "Document.url"] }],
};

/** A real, minimal in-memory destination used to exercise commit/undo. */
export class MemoryBridge implements Bridge {
  state: string[] = []; fail = false;
  constructor(private contract: CapabilityContract) {}
  describe() { return this.contract; }
  async execute(op: Operation) {
    if (this.fail) throw new Error("destination unavailable");
    const line = `${op.proposal.relation}:${op.dataMoved.map((d) => d.value).join("|")}`;
    this.state.push(line);
    return { ref: line };
  }
  async undo(r: Receipt) { this.state = this.state.filter((l) => l !== r.bridgeRef); }
}

export { perceive };
