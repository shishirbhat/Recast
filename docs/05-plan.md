# 05. Plan for Layers 0 to 2

Estimates are **full-time solo weeks**, with ranges. If this is part-time alongside other work, multiply accordingly. They assume the TypeScript core and Windows-first decisions in `03-decisions.md`.

| Layer | Work | Estimate |
|---|---|---|
| 0 | Schemas for nine types; polished implementation for four (Person, Event, Location, ResearchPaper); grammar as data; capability-contract format; provenance/evidence; trust and risk model; conformance fixtures and runners; CI | 3 to 4 wks |
| 1 | Chrome/Edge MV3 extension; extractors (JSON-LD, OpenGraph, `citation_*`, DOM); **corpus of 100+ real pages with hand-labelled ground truth**; per-field accuracy harness; evidence-to-element linking; permission doc and security review | 5 to 6 wks |
| 1b | Firefox (about 1 wk) and Safari (about 2 wks, includes Apple Developer setup and packaging) | 3 wks |
| Probe (proposed) | Browser-only lift/place, 5 to 10 users | 3 wks |
| 2 | Windows: helper spike (2), overlay, token, chips (3), hit-testing plus extension coordination (2), three bridges (3), preview, undo, history log (1.5), hardening and security review (1), user study (2, recruiting starts earlier) | 10 to 13 wks |

**Total Layers 0 to 2:** about 23 weeks (range 19 to 30), roughly 5 to 6 months, or 4 to 5 months if Firefox/Safari and the probe are deferred.

Where the estimates are soft, and why:
- **Corpus labelling** is the hidden cost: 100 pages at about 10 minutes each is roughly 17 hours before any tooling, and disputes over ground truth add more.
- **Google OAuth verification** for Calendar/Gmail/Sheets scopes can take weeks and I have not checked the requirements. Test-user mode may be enough for the gate study. Verify first thing in Layer 2.
- **Windows native spike** is the largest technical unknown (hooks, overlay click-through, UIPI).
- The **user study** is bounded by recruiting ten non-technical people, so start recruiting during Layer 1.

## Cuts, if you want them (I'm not making them silently)
| Cut | Saves | Cost |
|---|---|---|
| Defer Safari and Firefox | 3 wks | Chrome/Edge only; fine for the gate |
| Two bridges (Calendar, Gmail compose) instead of three | 1 to 1.5 wks | Gate tasks limited to two destinations |
| Polish three types, not four | 0.5 to 1 wk | Drops ResearchPaper polish, hurts the paper story |
| Skip the browser probe | 3 wks | Lose the early premise signal |

## Gates and how each will be measured
- **L0:** conformance suite green on every binding (with the caveat in `02-architecture.md`).
- **L1:** target accuracy per field to be agreed with you (proposal: 95% for `name/title/url`, 85% for dates and addresses, 90% for `citation_*` where present, on the labelled corpus, reporting per-field precision/recall). Evidence links resolve to the right element.
- **L2:** ten non-technical people, no instructions, real tasks; record time and errors against plain copy/paste; if most cannot succeed unprompted, stop and report.
- **Latency budgets** (structured capture under 100 ms, preview under 150 ms, API placement under 1 s) are measured with a benchmark harness in CI and reported; none are measured yet.

## Not done at this checkpoint
No product code. Nothing measured. No security review (there is no code to review). Layer 0 has not started.
