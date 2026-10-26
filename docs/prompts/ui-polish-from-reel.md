# Prompt: Recast UI polish (from the launch reel)

You are refining the Recast overlay and desktop UI so the product looks like it does in the launch reel. Stack: Next.js (App Router), TypeScript, Tailwind, Framer Motion. Source of truth for tokens: `design/tokens.css`, `docs/04-design-system.md`, logo in `design/brand/`. Keep the existing spring values (carry 300/24/0.8, approach 400/20, snap 500/15, cancel 200/25). Do not add new colours or radii.

## 1. One surface language: "objects resting on warm dark"
- Dark theme is the hero: page `#0F0F0F`, raised surfaces `#1A1A1A`, hairline `rgb(255 255 255 / .08)`, warm shadows (`--shadow-rgb: 61 31 20`), never pure black shadows.
- Add a single, slow ember ambient glow behind the active object only (radial, ember-500 at ≤12% opacity, 600px). Remove decorative glows elsewhere: one light source per screen.
- Light mode (cream `#FAF9F6`) must use the same layout and components. No white `#FFF` page anywhere; white is only for raised cards.

## 2. Selection → token
- When text is selected in any app, outline it with a 1.5px ember-500 ring, radius 6px, plus a 4% ember fill. No thick orange underline.
- The grabbed piece becomes a **token pill**: 40px tall, `--r-pill`, raised surface, 28px ember icon disc on the left, 9px uppercase tracked label (TIME / PLACE / PERSON) in `--text-muted`, value in Figtree 15/600.
- While carried: speed-dependent tilt (max 6°), lifted shadow, 1.03 scale. On drop: snap spring, shadow settles to `--shadow-token`.

## 3. Combine (two tokens → one object)
- When token B approaches token A within `--magnet-px`, they pull together and merge into one **stack card** (`--r-panel`, 16px padding) listing each token as a row. Header: `2 DETAILS · 2 SOURCES` in 11px tracked muted caps.
- Below the card: one primary pill button with the inferred action ("Create calendar event"), ember fill, `--on-accent` ink text (not white: contrast rule), calendar icon left. A quiet text "Cancel" under it.
- Hold-to-confirm: fill the button left→right over `--hold-ms` (600ms).

## 4. Preview ("hologram") before anything is written
- The preview panel header shows the destination icon + "New calendar event" and a status line `PREVIEW · NOT CREATED YET` in ember-ink, 10px tracked caps. This line must always be visible; it is the trust signal.
- Fields (TITLE / WHEN / WHERE) use `--r-input`, the focused field gets an ember ring. Pre-filled values are editable inline.
- `FROM` row: source chips (Messages, juniper.coffee) at 12px, each with its app favicon, clickable to jump back to the source.
- Remove dead space: panel height hugs content; actions sit 24px below the last field. Cancel = outline pill, Create = ember pill, right-aligned, same height.

## 5. Placement receipt
- After placing, the destination (Calendar) briefly shows the new item with a 2px ember left border and ember-100 fill, then fades to normal over 1.2s.
- Receipt toast at bottom centre: dark pill, check icon, "Event created", ember "Open" and "Undo" actions, auto-dismiss at `--toast-ms`. It must be sharp: no motion blur on text at rest.

## 6. Brand chrome
- Top-centre floating badge: new R mark (ember dot) + "Recast", 32px pill, raised surface. Same component everywhere.
- Display type: EB Garamond only for marketing/hero lines ("Turn what you see on your screen into what you need."). In-product UI is Figtree only. Do not mix serif inside panels.

## 7. Accessibility and motion
- Every ember-on-dark and ink-on-ember pair must pass WCAG (use the computed values in tokens.css).
- `prefers-reduced-motion`: replace tilt, magnet and glow with 150ms opacity fades; keep the hold-fill as a static progress bar.
- All overlay controls reachable by keyboard: Tab between tokens, Enter to combine, Esc to cancel (drop-back animation).

## Done when
Recreating the reel's flow (select time in Messages → select place on a web page → combine → preview → create → receipt) in the app looks frame-for-frame like the reel in both themes, at 1x and 2x, with reduced motion on and off.
