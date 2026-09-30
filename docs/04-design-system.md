# 04. Design system

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
