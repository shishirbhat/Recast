// Messages between the clay content script in each tab and the service worker.
import type { ClumpEffect, ClumpEvent, ClumpState, DestinationSpec } from "@recast/interaction";

/** An event without its clock reading: the worker stamps it, so every tab shares one clock. */
export type EventInput = ClumpEvent extends infer E ? (E extends ClumpEvent ? Omit<E, "now"> : never) : never;

export type ToBackground =
  | { type: "get" }
  | { type: "dispatch"; event: EventInput }
  | { type: "destinations"; destinations: DestinationSpec[] }
  | { type: "activate"; tabId: number }
  /** From the toolbar popup only: the same as the keyboard command, for the tab the person is looking at. */
  | { type: "invoke"; tabId: number }
  /** Control pressed twice in a tab Recast is already in: the Recast command for that tab. */
  | { type: "command" }
  /** From the popup only: look at (and, once allowed, use) the Recast program on this computer for the real Google Calendar. */
  | { type: "link" };

export type ToTab =
  | { type: "state"; state: ClumpState }
  | { type: "effect"; effect: ClumpEffect }
  /** Recast was invoked from the keyboard here: move focus into the module. */
  | { type: "focus" };
