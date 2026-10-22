"""Send real keystrokes to the X display (Xvfb in tests) through the XTEST extension, as a person's keyboard would.

Usage: python3 keys.py <action> [<action> ...]
  ctrl+z, ctrl+shift+z, alt+e, Return, Escape, Tab, Down ...   a key or chord (X keysym names)
  type:<text>                                                 type plain ASCII text
  move:<x>,<y>                                                move the pointer (focus follows it without a window manager)
  click:<x>,<y>                                               move and left-click
  wait:<ms>                                                   pause between actions
  wait-window:<text>                                          wait (up to 60 s) for a window whose title contains text
  expect-light:<x>,<y> / expect-dark:<x>,<y>                  fail unless the screen pixel there is light / dark

Test-only: needs python-xlib (pip install python-xlib). Not used by the extension itself.
"""
import sys
import time

from Xlib import X, XK, display
from Xlib.ext import xtest

MODS = {"ctrl": "Control_L", "shift": "Shift_L", "alt": "Alt_L", "meta": "Super_L"}


def code(d, name):
    sym = XK.string_to_keysym(name)
    if sym == 0 and len(name) == 1:
        sym = ord(name)
    kc = d.keysym_to_keycode(sym)
    if not kc:
        raise SystemExit(f"no keycode for {name!r}")
    return kc


def chord(d, spec):
    parts = spec.split("+")
    mods = [code(d, MODS[p.lower()]) for p in parts[:-1]]
    key = code(d, parts[-1])
    for m in mods:
        xtest.fake_input(d, X.KeyPress, m)
    xtest.fake_input(d, X.KeyPress, key)
    xtest.fake_input(d, X.KeyRelease, key)
    for m in reversed(mods):
        xtest.fake_input(d, X.KeyRelease, m)
    d.sync()
    time.sleep(0.03)


def type_text(d, text):
    for ch in text:
        if ch == " ":
            chord(d, "space")
        elif ch.isupper():
            chord(d, "shift+" + ch.lower())
        else:
            chord(d, ch)


def titles(d):
    out = []
    stack = [d.screen().root]
    while stack:
        w = stack.pop()
        try:
            name = w.get_wm_name()
            if name:
                out.append(name if isinstance(name, str) else name.decode("utf8", "replace"))
            stack.extend(w.query_tree().children)
        except Exception:
            pass
    return out


def main():
    d = display.Display()
    for action in sys.argv[1:]:
        if action.startswith("type:"):
            type_text(d, action[5:])
        elif action.startswith("move:") or action.startswith("click:"):
            x, y = (int(v) for v in action.split(":", 1)[1].split(","))
            xtest.fake_input(d, X.MotionNotify, x=x, y=y)
            d.sync()
            if action.startswith("click:"):
                xtest.fake_input(d, X.ButtonPress, 1)
                xtest.fake_input(d, X.ButtonRelease, 1)
                d.sync()
            time.sleep(0.05)
        elif action.startswith("wait-window:"):
            want = action.split(":", 1)[1]
            end = time.time() + 60
            while not any(want in t for t in titles(d)):
                if time.time() > end:
                    raise SystemExit(f"no window titled like {want!r}; have {titles(d)!r}")
                time.sleep(0.25)
        elif action.startswith("expect-light:") or action.startswith("expect-dark:"):
            x, y = (int(v) for v in action.split(":", 1)[1].split(","))
            raw = d.screen().root.get_image(x, y, 1, 1, X.ZPixmap, 0xFFFFFFFF).data
            level = (raw[0] + raw[1] + raw[2]) / 3
            light = level > 160
            if light != action.startswith("expect-light:"):
                raise SystemExit(f"pixel at {x},{y} is {'light' if light else 'dark'} ({level:.0f}); expected {action.split(':')[0][7:]}")
        elif action.startswith("wait:"):
            time.sleep(int(action[5:]) / 1000)
        else:
            chord(d, action)


if __name__ == "__main__":
    main()
