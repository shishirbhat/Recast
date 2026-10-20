// Messages between the clay content script in each tab and the service worker.
import type { ClumpEffect, ClumpEvent, ClumpState, DestinationSpec } from "@recast/interaction";

/** An event without its clock reading: the worker stamps it, so every tab shares one clock. */
export type EventInput = ClumpEvent extends infer E ? (E extends ClumpEvent ? Omit<E, "now"> : never) : never;

export type ToBackground =
  | { type: "get" }
  | { type: "dispatch"; event: EventInput }
  | { type: "destinations"; destinations: DestinationSpec[] }
  | { type: "activate"; tabId: number };

export type ToTab =
  | { type: "state"; state: ClumpState }
  | { type: "effect"; effect: ClumpEffect };
