# 02. Architecture

## Principles carried over from the brief
One core, thin shells. Schema first. Recast owns the drag on desktop. The graph is optional. Original objects are never mutated. Every bridge is labelled by reliability class.

## Monorepo layout (pnpm workspaces + Turborepo)

```
recast/
  schema/                     SOURCE OF TRUTH. JSON Schema 2020-12, versioned.
    objects/*.schema.json     nine types: Person Document Event Location Image
                              Message Task Product ResearchPaper
    grammar/relations.json    the relationship grammar as data
    contracts/capability.schema.json   destination capability contract format
    common/{provenance,evidence,confidence,risk}.schema.json
  packages/
    core/                     platform-independent engine (TypeScript, no I/O)
    conformance/              language-neutral golden fixtures + runner(s)
    extract-web/              structured extractors (JSON-LD, OG, citation_*, DOM)
    bridges/
      google-calendar/  gmail-compose/  google-sheets/  notion/  tasks-*/
    ui-tokens/                tokens.css, Tailwind preset, Motion springs
    ui-overlay/               token/chips/preview/toast components (React + Motion)
  apps/
    extension/                Chrome/Edge MV3 first; Firefox, Safari later
    desktop-win/              Layer 2 shell (see below)
    web/                      control center, Next.js App Router (Layer 4)
  native/
    win-helper/               tiny native process: hooks, UIA, hit-testing
  corpus/                     100+ real pages, hand-labelled ground truth
  docs/  design/
```

## Schema strategy
- JSON Schema is authored once, versioned (`schemaVersion` on every object; additive changes are minor, breaking changes bump major and ship a migration).
- Generated from it: TypeScript types + Ajv validators now; Rust (typify), Swift and Kotlin types when those shells exist. No hand-written duplicate models.
- **Object envelope:** `id` (stable, content-addressed where possible), `type`, `schemaVersion`, `properties` (typed per type), `provenance` (source app/URL, capture method, time), `evidence[]` per property (element locator, text range, PDF page+region), `confidence` per property, `extensions{}` for app-specific data.
- **Candidate vs Object:** perception yields an *unresolved candidate*. Resolution is a separate, explicit step that may consult a bridge (e.g. match a Person to a Google contact).
- Relationship grammar and capability contracts are **data**, validated against the schema, loaded at runtime. Adding "Product to Product = compare" means adding a row and a fixture, not shipping code.

### Capability contract (what a destination declares)
```json
{
  "destination": "google-calendar.event-editor",
  "reliability": "official-api",
  "accepts": [
    { "from": "Person",   "relation": "attendee", "risk": "medium",
      "requires": ["email"], "effect": "add-attendee", "reversible": true },
    { "from": "Location", "relation": "location", "risk": "low",
      "requires": ["address|name"], "effect": "set-location", "reversible": true }
  ],
  "dataMoved": ["Person.name", "Person.email"]
}
```
`dataMoved` is what the "what data moves" inspector shows the user before commit.

## Core API surface
The core is **pure**: no network, disk, clock or randomness of its own. Shells inject those. That keeps it testable and portable.

```ts
perceive(input: PerceptionInput): Candidate[]                 // structure first, vision last
resolve(c: Candidate, ctx: ResolveContext): SemanticObject
propose(o: SemanticObject, dest: DestinationDescriptor,
        approach?: Approach, prefs?: Preferences): Proposal[] // ranked landing options
preview(p: Proposal): Preview                                 // ghost description, no side effects
plan(p: Proposal): Operation                                  // risk tier, data moved, bridge, reliability
commit(op: Operation, consent: Consent): Receipt              // executes via injected Bridge
undo(r: Receipt): Receipt
inspect(o | op | r): Explanation                              // what we believe, will do, who gets what
```
```ts
interface Bridge {                                            // implemented per destination
  describe(): CapabilityContract
  execute(op: Operation, consent: Consent): Promise<Receipt>
  undo(r: Receipt): Promise<Receipt>
}
```
Intent is computed from source + destination + capabilities + approach + context + preferences. `propose` never looks at the source object alone.

**Trust model:** every `Proposal` carries `confidence` and `risk`. Low and reversible executes on release. Medium previews plus a light confirm. High (send, delete, publish, money, important records) needs an explicit hold-to-confirm. Every committed operation is appended to a local, append-only event log that `undo` reads.

## How each shell links the core

| Shell | Runtime | How it consumes the core |
|---|---|---|
| Chrome/Edge extension | JS | imports `@recast/core` directly; capture in content scripts; state in `storage.session`/IndexedDB |
| Firefox | JS | same package, WebExtension polyfill |
| Safari | JS in an app-bundled extension | same package; Xcode/App Store Connect packaging |
| Windows desktop | Electron main/renderer (TS) + `win-helper` | core imported directly; helper talks over a named pipe with a versioned JSON protocol |
| macOS desktop (later) | same Electron shell + a Swift helper | same core |
| Web control center | Next.js | core (or its WASM/JS build) for inspect/history views; Supabase for opt-in sync |
| iOS / Android (Layer 3) | Swift / Kotlin | see decision (a): JS engine embed or Rust port, both driven by the same conformance fixtures |

## Conformance suite
`packages/conformance` holds JSON fixtures (input candidate, destination, expected proposals, expected operation, expected receipt, expected serialized object). It is **language-neutral on purpose**: a runner per shell loads the same files. With a single TypeScript core the browser and Electron bindings run the *same code*, so a green suite there proves packaging and serialisation, not independent correctness. The suite becomes a true cross-implementation test only when a second implementation exists (Rust port or a native engine). I am flagging this now so Layer 0's gate is not over-read.

## Desktop shell (Layer 2, Windows)
- **Electron** for overlay windows and UI: transparent, always-on-top, click-through layered windows for the hairline/chips/token.
- **`win-helper`** (small native binary, .NET or Rust, to be decided in a spike): low-level keyboard hook for the lift key (state only, never logs keys), `ElementFromPoint`-style UIA capture for native apps, window hit-testing for drop.
- Browser content is handled by the **extension**, not UIA. Extension and shell coordinate over native messaging, so the shell knows which tab/element is under the pointer and the extension can describe drop targets (Calendar, Gmail, Sheets, Notion are all web apps).
- Credentials go in Windows Credential Manager (DPAPI). Tokens never touch localStorage.

## Permission threat model (pre-requisites, written before each permission is requested)
Extension: `activeTab` + on-demand host permissions rather than `<all_urls>` where possible; what content scripts read, and why, is documented in `docs/permissions.md` at Layer 1. Desktop: no screen recording, no keystroke logging, hook reads only "lift key held" state; UIA reads only the element under the pointer while lift mode is on. A full STRIDE-style pass is a Layer 1 and Layer 2 release gate, not done yet.
