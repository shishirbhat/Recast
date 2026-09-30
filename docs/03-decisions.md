# 03. Open decisions and recommendations

Two decisions need your choice, plus one scope proposal I think you should see before approving the plan.

## (a) Core language: Rust or TypeScript

**Recommendation: TypeScript for Layers 0 to 2. Revisit at the start of Layer 3, using the conformance fixtures to make the port mechanical.** This is the opposite of the brief's leaning, so here is the reasoning.

For Rust:
- iOS share extensions are killed at ~120 MB. A Rust core is small and predictable there. [secondary source, see 01-research]
- UniFFI is production-grade for Swift/Kotlin (Firefox uses it), so one core for both mobile shells is realistic.
- A real second binding makes the "same object round-trips through every shell" conformance gate meaningful.

Against, for now:
1. **Nothing in Layers 0 to 2 needs it.** The shells there are a browser extension and an Electron/Windows app. Both run TypeScript natively. Rust would add a WASM build for the extension and an FFI or N-API boundary for Electron with no user-visible benefit.
2. **You said you are more fluent in TypeScript, and you are one developer.** The riskiest thing in this project is the unproven consumer premise (Layer 2's gate). Every week spent on toolchain is a week not spent finding out if it works.
3. **The expensive parts are not language-sensitive.** Extraction accuracy, the grammar, bridges and the overlay UX dominate the schedule. None get easier in Rust.
4. **The port is cheap if we prepare for it.** Schema-first codegen plus language-neutral golden fixtures mean a Rust port at Layer 3 is "make the fixtures pass", not a redesign. The core is pure (no I/O), which is the property that makes porting easy.
5. **iOS has a fallback.** JavaScriptCore ships on iOS, so a bundled JS core inside a share extension is possible; memory cost needs measuring and is untested. If it is too heavy, that is exactly the trigger for the Rust port. Android can embed a JS engine similarly.

What would change my mind: if you expect to start Layer 3 within roughly two months of Layer 0, or if a spike shows the TS core cannot fit the iOS extension budget.

Reversibility cost if wrong: a Rust port of `core` (estimated 3 to 5 weeks, once fixtures exist). The schema, grammar, bridges (which are per-platform anyway) and UI are unaffected.

## (b) Which desktop OS first

**Recommendation: Windows first.**

- Market fit: you are in India, where Windows dominates, and your first testers are more likely to be on it.
- Wispr Flow's own Windows build needs no Accessibility permission, only microphone. The Windows permission story for a lift-and-place tool is lighter than macOS's TCC prompts. [primary: Wispr docs]
- macOS adds recurring costs: paid Developer Program membership, notarization, TCC re-approval after updates, and distribution outside the Mac App Store (sandboxed apps cannot drive other apps' accessibility trees) [unverified, see 01-research].
- Chromium's native UIA (Chrome 138+) helps, but the accessibility-tree wake-up trap means **you should not rely on UIA for browser content**. That is fine here: browser content goes through the extension, and all four Layer 2 destination candidates (Calendar, Gmail, Sheets, Notion) are web apps.

The counter-argument you raised is real: macOS Accessibility APIs are generally richer and more consistent across native apps. If your Layer 2 testers are mostly on Macs, flip this. Windows risks I would spike in the first two weeks: UIPI (elevated windows), overlay click-through behaviour, and the lift-key hook's interaction with security software.

## (c) Scope proposal: a browser-only premise probe before the desktop shell

The Layer 2 gate ("ten non-technical people, no instructions, real tasks") is where the consumer premise is tested, and it sits about five months in, after building a Windows shell, native helper and overlay. Yet the four candidate destinations are all web apps. A **browser-only version** (content-script overlay: lift a Person/Location/Paper on any page, place it on a Calendar/Gmail/Notion tab) reuses Layer 0 and Layer 1 almost entirely and could test the same premise roughly 3 weeks after Layer 1.

This does not narrow your plan. Layer 2 stays as specified. It adds a cheap early read on the riskiest claim. If most users fail unprompted, you learn it before building the native shell. I'd like your yes/no on it, because it changes the calendar.

## Also decided (no action needed unless you object)
- Repository: you asked for a new repo named `recast`. This session is scoped to the existing, empty `shishirbhat/Recast` repo, so I used it. Modulus is untouched.
- Overlay UI stack: React + Tailwind + Motion (`motion/react`) inside Electron and the extension. The web control center (Layer 4) uses your fixed stack (Next.js App Router, Supabase, Vercel, shadcn-style components).
- Icons: type glyphs are text monograms in the mockups. Real icons from Phosphor when we build components (no hand-drawn SVG).
