# Design direction (saved for later; not yet applied)

**Status:** recorded on 2026-10-17 from the founders' brief. The final visual identity will be integrated with the **Modulark and Modulus** websites (palette, patterns, typography, overall design language). Do not finalise a permanent palette or overhaul the control center until that integration is decided. New components keep using tokens from `design/tokens.css`, so the switch is a token change, not a rewrite.

What is in the code today is the interim "Grab, Carry, Place" pass (`docs/04-design-system.md`). Where this brief differs from it, this brief wins when the UI pass happens (task "Heavy UI pass").

## The look in one sentence
Recast should feel like a small, beautiful physical object floating above the desktop, not a browser extension. The product is the gesture; the interface is a temporary layer above the user's real work.

```
Calm desktop → grab something → a token appears → destination chips appear only nearby → place → everything disappears
```
No permanent sidebar, no dashboard-first experience, no clutter.

References: Wispr Flow's warmth (cream surfaces, one restrained accent, generous space, one focal object), Linear's restraint (near-black, one accent, precise type, almost no noise), Raycast's focused command surface.

## Principles
| Principle | Rule |
|---|---|
| Calm by default | Nothing changes on the desktop until the user grabs something |
| One focal object | Only one capsule is ever visually dominant |
| Soft physicality | Rounded surfaces, soft shadows, subtle depth; not glossy skeuomorphism |
| Warm, not corporate | Ivory light mode, warm charcoal dark mode |
| One accent | Orange only for action, risk or the active object; never long body text; text on orange is near-black |
| Motion with meaning | Every animation explains lift, carry, snap, place or return; motion settles |
| Typography does the work | Clear labels; no tiny cramped text |

## Palette proposal (pending Modulark/Modulus alignment)
Light: canvas `#F7F4EE`, surface `#FFFFFF`, raised `#FFFDF9`, border `#E7E1D6`, ink `#191714`, muted `#6E675C`, brand `#C2410C`, brand-soft `#FDEDE4`, success `#15803D`, warning `#B45309`, danger `#B91C1C`.
Dark: canvas `#0E0D0B`, surface `#171511`, raised `#1F1C17`, border `#2C2822`, ink `#F5F1E8`, muted `#A39C8D`, brand `#F97316`, brand-soft `#2A1A10`, success `#4ADE80`, warning `#FBBF24`, danger `#F87171`.
Contrast must be computed for every text pairing before adoption, as for the interim palette.

## Type proposal
Display and wordmark: Instrument Serif (sparingly: wordmark 20–24px, section headings 24–32px). UI and body: Inter or Geist (13–16px). IDs and code: JetBrains Mono 12px. Replaces the interim EB Garamond/Figtree pairing, because a serif across a utility UI reads old-fashioned.

## Overlay: three small surfaces, never a full window
1. **Capsule (token).** 44–52px pill: glyph plus one truncated title, an optional tiny type badge. Hairline border, soft directional shadow, velocity tilt of 6–8° at most. No confidence scores, IDs or provenance on it; those belong in the preview.
2. **Destination chips.** Only relevant destinations, never more than four. 120–150px each: icon, destination name, action ("Calendar · Attendee"). Inactive at 70% opacity. The nearest valid chip is fully opaque, slightly larger and accent-bordered. A blocked chip shows a lock and its reason on hover or focus. Magnetic: lean at 56px, snap at 20px in 100–140ms, then completely still.
3. **Preview.** 260–340px, 88–92% opacity, 8–14px backdrop blur. One action sentence ("Add Meera Iyer as attendee"), one or two relevant fields, and trust shown as a dot plus label. No walls of provenance by default. It answers: what exactly happens if I release here?
4. **Receipt (toast).** Slides up 12px. One Undo, and only when the bridge supports reliable reversal. A countdown bar. Success only after execution is confirmed.

## Motion
Springs, interruptible. The token appears by scaling from 0.92 to 1 over 180–220ms. It follows on a spring with stiffness 280–340 and damping 22–28. Approach scales the chip to 1.04; snap returns it to 1.00 in 100–140ms. The preview fades in with a 6px rise over 140–180ms. On place, the token collapses into the chip over 220–280ms. On Undo or Esc, the token returns to its origin. With reduced motion, everything is instant: no tilt, bounce or travel. After a snap, nothing wobbles.

## Control center
Linear-like calm structure, not a SaaS admin panel: a quiet 220–240px sidebar, 32–48px of padding, hairline cards with a 12–16px radius, no heavy gridlines, status shown as a dot plus label, one primary action per screen. Dark mode is the default aesthetic, and light mode is equally considered.

## Remove first, then style
Too many colours, borders and badges, too much on the token, full-width panels, orange everywhere, a generic dashboard layout, animations that never settle, and tiny explanatory text.

## Quality bar
A five-second silent screen recording should make it obvious: "they picked up an object and put it somewhere else."
