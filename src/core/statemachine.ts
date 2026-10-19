import type { ActorKind, TaskState } from "./types.ts";

/**
 * Legal transitions and which kinds of actor may perform each.
 * Guards that need project state (prerequisites, the completion gate) live in the engine.
 *
 * review_required means execution finished; completed means a human approved integration
 * after Relay itself observed passing verification. An agent can never reach completed.
 */
export const TRANSITIONS: Record<TaskState, Partial<Record<TaskState, readonly ActorKind[]>>> = {
  proposed: { queued: ["human"], cancelled: ["human"] },
  queued: { running: ["agent", "human", "system"], blocked: ["agent", "human", "system"], cancelled: ["human"] },
  running: {
    review_required: ["agent", "human", "system"],
    blocked: ["agent", "human", "system"],
    failed: ["agent", "human", "system"],
    cancelled: ["human", "system"],
  },
  blocked: { queued: ["human", "system"], cancelled: ["human"] },
  review_required: { completed: ["human"], running: ["human"], failed: ["human", "system"], cancelled: ["human"] },
  failed: { queued: ["human"], cancelled: ["human"] },
  completed: {},
  cancelled: {},
};

export function canTransition(from: TaskState, to: TaskState, actor: ActorKind): boolean {
  return TRANSITIONS[from][to]?.includes(actor) ?? false;
}

export function isTerminal(state: TaskState): boolean {
  return Object.keys(TRANSITIONS[state]).length === 0;
}
