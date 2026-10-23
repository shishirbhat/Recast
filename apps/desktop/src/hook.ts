// The keys and the mouse, system-wide: how Recast is turned on from inside any app without opening a window.
//   Off: tap the trigger key twice (Option on a Mac, Ctrl on Windows and Linux) → on.
//   On:  tap it once, or press Escape → off. While on, finishing a text selection (a drag, or a double or triple click)
//        lifts it into a blob where the mouse let go.
// The trigger rule is the extension's (createControlTrigger): a tap is the key pressed and released on its own, so
// chords (⌥E, Ctrl+C), holding it, or using it with the mouse never turn Recast on or off.
// macOS asks for the Accessibility permission before any of this sees a key; nothing is recorded, only these patterns.
import { createControlTrigger, type TapInput } from "@recast/interaction";
import type { UiohookKeyboardEvent, UiohookMouseEvent } from "uiohook-napi";

type Hook = typeof import("uiohook-napi");
export interface HookEvents {
  /** The trigger: "on" (twice while off) or "off" (once while on). */
  onTrigger(next: "on" | "off"): void;
  /** Escape, pressed anywhere while Recast is on. */
  onEscape(): void;
  /** A text selection just ended at this screen point (the mouse let go after a drag, or a double or triple click). */
  onSelectionEnd(x: number, y: number): void;
  /** While on: the app underneath may have changed what it shows (a scroll, or a plain click in it). */
  onScreenChanged(): void;
}

/** The trigger key's name, as the tap rule calls it: Option (Alt) on a Mac, where Control twice is the system's Dictation. */
export const TRIGGER_KEY = process.platform === "darwin" ? "Alt" : "Control";
export const TRIGGER_LABEL = process.platform === "darwin" ? "⌥ Option" : "Ctrl";

export function createHook(events: HookEvents, isOn: () => boolean) {
  const trigger = createControlTrigger({ key: TRIGGER_KEY });
  let hook: Hook | null = null;
  let started = false, problem = "";
  const down = new Set<number>();                 // keys held now, to tell a fresh press from auto-repeat
  let press: { x: number; y: number } | null = null;
  let settle: NodeJS.Timeout | null = null;      // a selection that may still grow with another click

  /** One key event in the tap rule's terms. Exported through feedKey for tests that cannot press keys. */
  function feedKey(name: string, type: "keydown" | "keyup", repeat = false) {
    const r = trigger({ type, key: name, repeat, at: Date.now() } as TapInput, isOn());
    if (r) events.onTrigger(r);
    if (type === "keydown" && name === "Escape" && isOn()) events.onEscape();
  }
  function keyName(h: Hook, code: number) {
    const K = h.UiohookKey;
    if (code === K.Alt || code === K.AltRight) return "Alt";
    if (code === K.Ctrl || code === K.CtrlRight) return "Control";
    if (code === K.Escape) return "Escape";
    return `k${code}`;
  }
  function onKey(e: UiohookKeyboardEvent, type: "keydown" | "keyup") {
    const repeat = type === "keydown" && down.has(e.keycode);
    if (type === "keydown") down.add(e.keycode); else down.delete(e.keycode);
    feedKey(keyName(hook!, e.keycode), type, repeat);
  }
  function onMouseDown(e: UiohookMouseEvent) {
    if (settle) { clearTimeout(settle); settle = null; }
    trigger({ type: "pointerdown", at: Date.now() }, isOn());   // the trigger key used with the mouse is not a tap
    press = { x: e.x, y: e.y };
  }
  function onMouseUp(e: UiohookMouseEvent) {
    const p = press; press = null;
    if (!isOn() || !p) return;
    const dragged = Math.hypot(e.x - p.x, e.y - p.y) > 6;
    // A double click may become a triple click (word → line): wait for the clicking to stop, then grab once.
    if (dragged || e.clicks >= 2) { if (settle) clearTimeout(settle); settle = setTimeout(() => { settle = null; if (isOn()) events.onSelectionEnd(e.x, e.y); }, 320); }
    else events.onScreenChanged();
  }

  return {
    /** Starts listening. On a Mac, only once the Accessibility permission is given (the caller checks). */
    start(): boolean {
      if (started) return true;
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        hook = require("uiohook-napi") as Hook;
        hook.uIOhook.on("keydown", (e) => onKey(e, "keydown"));
        hook.uIOhook.on("keyup", (e) => onKey(e, "keyup"));
        hook.uIOhook.on("mousedown", onMouseDown);
        hook.uIOhook.on("mouseup", onMouseUp);
        hook.uIOhook.on("wheel", () => { if (isOn()) events.onScreenChanged(); });
        hook.uIOhook.start();
        started = true; problem = "";
      } catch (e) { problem = `The keyboard listener could not start: ${e instanceof Error ? e.message : String(e)}`; }
      return started;
    },
    stop() { if (started) { try { hook?.uIOhook.stop(); } catch { /* already stopped */ } started = false; } },
    get started() { return started; },
    get problem() { return problem; },
    feedKey,
    /** Copy in the app in front: ⌘C on a Mac, Ctrl+C elsewhere (used to read a selection). */
    copyKeys(): void {
      if (!hook || !started) throw new Error("the keyboard listener is not running");
      const K = hook.UiohookKey;
      hook.uIOhook.keyTap(K.C, [process.platform === "darwin" ? K.Meta : K.Ctrl]);
    },
  };
}
export type RecastHook = ReturnType<typeof createHook>;
