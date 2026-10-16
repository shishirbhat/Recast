# 04. Design system

## North star: "Grab, Carry, Place"
Every pixel, motion and word exists to make moving an object across apps feel like picking something up with your hand. A choice is right if it makes the token feel weighted, the snap feel like a magnet, the preview feel like a hologram, the toast feel like a receipt. Tone: calm, confident, a little playful. Not neon, not gradients everywhere, not corporate blue, not "AI purple", no motion for its own sake.

### Colour (`design/tokens.css`)
| Token | Light | Dark | Use |
|---|---|---|---|
| surface (page) | `#FAF9F6` | `#0F0F0F` | warm off-white / near-black |
| surface-raised | `#FFFFFF` | `#1A1A1A` | cards, chips, token |
| text | `#1A1A1A` | `#FAF9F6` | |
| text-muted | `#6B6B6B` (5.06:1) | `#A3A3A3` (6.9:1) | |
| accent | `#FF6B35` | `#FF6B35` | grab, place, primary actions, glyphs, fills, bars |
| accent-soft | `#FFE5DC` | `#3D1F14` | active chip, nav pill, selection |
| ok / warn / danger | `#22C55E` / `#F59E0B` / `#EF4444` | same | dots, fills, borders |

**Accessibility rule, computed not eyeballed:** the bright colours fail as text on light backgrounds. `#FF6B35` on cream is 2.69:1, green is 2.28:1 and amber is 2.15:1. They stay fills, and text uses an `-ink` step of the same hue:

| Ink | Light | Ratio on cream | Dark |
|---|---|---|---|
| `accent-ink` | `#B83D12` | 5.37:1 (4.71:1 on accent-soft) | `#FF6B35` (6.76:1) |
| `ok-ink` | `#15803D` | 4.76:1 | `#22C55E` |
| `warn-ink` | `#B45309` | 4.77:1 | `#F59E0B` |
| `danger-ink` | `#B91C1C` | 6.15:1 | `#F87171` (6.29:1) |

Text on the accent is `#1A1A1A` (6.14:1). White on `#FF6B35` would be 2.84:1, so it is never used. Focus rings use `--focus` (`#B83D12` light, `#FF6B35` dark) for 3:1 against the page. axe-core reports no serious or critical issue on every overlay state and every control-center page, in light and dark.

### Type
EB Garamond 500 for display (page titles 40px, wordmark), Figtree 400/500/600 for body and UI (15px body, 12–14px labels), JetBrains Mono 400 for ids and code. All are self-hosted through `@fontsource` (latin subsets, SIL OFL), so no font CDN is called at runtime.

### Motion: physics, not durations (`packages/overlay/src/motion.ts`)
| Interaction | Trigger | Feedback | Spring |
|---|---|---|---|
| Lift | key held | candidate outline pulses once | 200 ms pulse |
| Carry | pointer moves | token trails on a spring, tilts with momentum (max 8°), shadow grows with speed | (300, 24, mass .8) |
| Approach | pointer within 56 px of a chip | nearest chip grows 5%, glows, leans up to 6 px toward the pointer | (400, 20) |
| Snap | pointer within 20 px | chip locks with a small overshoot; token docks beside it | (500, 15) |
| Preview | chip locked | translucent, blurred "hologram" floats just above the destination | (300, 24) |
| Hold-to-confirm | press and hold | chip shrinks to .97 and fills with the accent over 600 ms, then pops to 1.06 | linear fill |
| Place | release / Enter | receipt toast slides up with a 6 s countdown bar | (300, 24) |
| Undo / dismiss | Undo, or time out | toast slides back down | (300, 24) |
| Cancel | Esc, or dropped on nothing | token falls back to where it was lifted, bounces once, fades | (200, 25, mass 1.2) |

Springs are interruptible: a change of direction mid-animation is absorbed, not finished. Reduced motion makes every spring instant, with no tilt, lean, glow pulse or drop-back. Every state keeps its screen-reader label and keyboard path.

Tested in Chromium (`apps/harness/test/flows.test.ts`, "physical feel"): the token tilts while moving and settles flat; its shadow changes with speed; a near chip grows and leans before it locks; it locks within the magnet; Esc drops the token back near its origin and then removes it; the hold fill tracks the hold in `#FF6B35`; under reduced motion there is no tilt and no drop-back. Screenshots: `docs/images/north-star/`.

### Not done
A haptic "click" on snap needs the native shell: browsers have no desktop haptics. The logo is a wordmark (EB Garamond plus an ember dot), not a designed mark. A designer should own the final logo.

---

## Earlier system (kept for history)

Design read: *utility overlay for consumers and professionals, calm and premium in the manner of Wispr Flow's restraint, not an AI-futuristic look.* Dials: variance 3, motion 4, density 3. Overlay UI, not a landing page, so marketing-page rules are used only where they apply (no AI-purple, no pure black or white, one accent, one radius rule, real contrast checks).

Files: `design/tokens.css` (three layers: primitive, semantic, component) and `design/mockups.html` (six states, light and dark, screenshots checked in both themes). Open the HTML in a browser. Geist is not bundled yet, so mockups fall back to the system font; the real build self-hosts Geist and Geist Mono (`next/font` for the web app; bundled files for the overlay).

## Palette (one accent, locked)
| Role | Light | Dark |
|---|---|---|
| surface | `#F7F7F5` | `#121316` |
| surface-raised | `#FFFFFF` | `#1B1C21` |
| text | `#1C1D21` | `#ECEDEF` |
| text-muted | `#5F626B` | `#9A9DA6` |
| accent (cobalt, not purple) | `#2D50C8` | `#8BA3FF` |
| danger / warn / ok | `#B3261E` / `#8A5A00` / `#1E7A46` | `#FF8A80` / `#F2C46D` / `#7FD6A2` |

Measured contrast (WCAG 2.x): text on surface 15.7 (light) and 15.9 (dark); muted 5.7 and 6.9; accent on surface 6.3 and 7.8; on-accent text 6.8 and 7.8; danger 6.1 and 8.1; the hairline colour is 3.09 against light surface, which clears the 3:1 non-text bar. No pure black or white for surfaces or text.

## Type
Geist (UI) and Geist Mono (identifiers, type glyphs). Scale: 11 / 12 / 13 / 14 / 16 / 20 px. Token title 13px medium. Body line-height 1.5, tight 1.2. I chose Geist over Inter deliberately (neutral grotesk as requested, avoids the default look).

## Space and shape
4px base: 4, 8, 12, 16, 24, 32. **One radius rule:** interactive elements are pills (999px), containers 12px, inputs 8px. Nothing else. Shadows are tinted to the surface, never pure black. Cards are avoided; regions are separated by hairlines.

## Motion
120ms fast, 160ms base, 220ms slow, all `cubic-bezier(.2,.7,.1,1)`. The token follows the pointer with a spring (stiffness 320, damping 30, via Motion `useMotionValue`, never React state). Toast lasts 6000ms. Only `transform` and `opacity` animate. Under `prefers-reduced-motion` durations collapse to 1 to 80ms and the token follows the pointer without lag (spring stiffness 0). Every animation has one job: hierarchy, feedback or state change.

## States (see mockups)
1. Lift mode: 1px accent outline and monogram glyph on capturable objects.
2. Token: 44px pill, glyph, truncated title, favicon, soft shadow, no gradient.
3. Destination response: hairline around region, 2 to 4 landing chips (32px) on the edge, active chip fills with accent and shifts 4px.
4. Preview: dashed accent ghost of the result in place.
5. Place: toast "Added as attendee" plus Undo, 6s with a 2px countdown bar.
6. High risk: chip requires hold (about 600ms) with a danger fill. Keyboard equivalent: hold Enter.

## Accessibility (hard requirement)
- Keyboard path: lift by keyboard, Tab through destinations, Enter to place, Esc cancels.
- Token and chips are labelled for screen readers ("Meera Iyer, Person. Landing options: Attendee, Location"). The toast is `role="status"`, and Undo is focusable.
- Focus ring: 2px accent, 2px offset, on every interactive element.
- Never rely on colour alone: the active chip also moves and the high-risk chip changes its label and requires a hold.
- Not yet verified: overlay windows and screen readers on real Windows (Narrator/NVDA). That is a Layer 2 test item.

## Not designed yet
Mobile tray (Layer 3) and the control center (Layer 4) get the same tokens but no mockups at this checkpoint.
