import type { CapabilityContract, Composition, Consent, EventField, Fragment, Operation, Preview, Proposal, Receipt, SemanticObject } from "@recast/core";

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; w: number; h: number }

/**
 * Something on screen that can be lifted. Supplied by a host (extension, Windows UIA, test harness).
 * `object`: a whole thing (a person, a place) that can be carried on its own.
 * `fragment`: a piece (a time, a place, a title) that is collected into a capsule and composed into an object.
 * A candidate has at least one of the two.
 */
export interface Candidate { id: string; rect: Rect; object?: SemanticObject; fragment?: Fragment; favicon?: string }
/** Something on screen that can receive. `contract` says exactly which relationships it supports. */
export interface Destination { id: string; label: string; rect: Rect; contract: CapabilityContract }

/** The toast (with Undo) is separate state, so a new lift can start while an earlier placement can still be undone. */
export type Phase = "idle" | "lifting" | "carrying" | "approaching" | "previewing" | "completing" | "confirming" | "committing";
export type InputMode = "pointer" | "keyboard";

export interface Chip {
  proposalId: string; destinationId: string; label: string; rect: Rect;
  status: "ready" | "blocked"; reason?: string; tier: "low" | "medium" | "high"; reliability: string; deliberate: boolean;
  /** A capsule that is not complete yet: placing here first asks for these fields. */
  needs?: string[];
  relationId?: string;
}

/** Pieces collected into one capsule, and what they compose into so far. */
export interface Capsule {
  fragments: Fragment[];
  candidateIds: string[];
  composition: Composition;
  answers: Partial<Record<EventField, string | boolean>>;
  choices: Partial<Record<EventField, string>>;
}

export type Outcome =
  | { kind: "cancelled"; reason: string }
  | { kind: "failed"; message: string }
  | { kind: "undone"; label: string };

export interface Toast { kind: "placed" | "undone" | "error"; text: string; receipt?: Receipt; expiresAt: number; startedAt: number }

export interface State {
  phase: Phase; mode: InputMode; now: number; pointer: Point; liftKeyDown: boolean;
  hitSeq: number;
  hovered: Candidate | null;                // lifting: what would be lifted
  carried: Candidate | null;
  destination: Destination | null;          // approaching/previewing: the destination in play
  proposals: Proposal[];                    // one per chip
  chips: Chip[];
  activeChip: string | null;                // proposalId that is snapped / focused
  preview: Preview | null;
  blockedNote: string | null;
  pending: { op: Operation; kind: "confirm" | "hold" } | null;
  hold: { startedAt: number | null; progress: number };
  toast: Toast | null;
  candidates: Candidate[]; destinations: Destination[]; focusIndex: number;   // keyboard mode
  placements: { destination: Destination; proposalId: string; label: string }[];   // keyboard mode: flat Tab order
  live: string;                             // text for a screen-reader live region
  outcome: Outcome | null;
  capsule: Capsule | null;
  /** The person's IANA time zone and the clock reading relative dates. Supplied by the host. */
  timezone: string;
  /** completing: the destination and relation the person chose for an incomplete capsule. */
  completingFor: { destinationId: string; relationId: string; asked: { missing: Composition["missing"]; conflicts: Composition["conflicts"] } } | null;
}

export type Event =
  | { type: "liftKey"; down: boolean; now: number }
  | { type: "keyboardLift"; now: number }
  | { type: "pointerMove"; p: Point; now: number }
  | { type: "hitResult"; seq: number; candidate: Candidate | null; destination: Destination | null; now: number }
  | { type: "pointerDown"; p: Point; now: number }
  | { type: "pointerUp"; p: Point; now: number }
  | { type: "key"; key: string; down: boolean; shift?: boolean; now: number }
  | { type: "enumerated"; candidates: Candidate[]; destinations: Destination[]; now: number }
  | { type: "tick"; now: number }
  | { type: "committed"; receipt: Receipt; now: number }
  | { type: "commitFailed"; message: string; now: number }
  | { type: "undoRequest"; now: number }
  | { type: "undone"; receipt: Receipt; now: number }
  | { type: "undoFailed"; message: string; now: number }
  | { type: "answer"; field: EventField; value: string | boolean; now: number }
  | { type: "choose"; field: EventField; fragmentId: string; now: number }
  | { type: "submitCompletion"; now: number };

/** Requests the machine makes of its host. The host performs them and answers with events. */
export type Effect =
  | { type: "hitTest"; seq: number; p: Point }
  | { type: "enumerate" }
  | { type: "commit"; op: Operation; consent: Consent }
  | { type: "undo"; receipt: Receipt };

export interface Result { state: State; effects: Effect[] }
