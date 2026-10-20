# 07. Layer 1 report (browser capture)

## Verdict
**The gate is met for pages that publish structure, and not met for people and places.** Papers, events and products are extracted accurately with evidence that points back to the right place. People (12% found) and places (16% found) are mostly not found, because most of those pages in the corpus publish no structured data at all. That is a real limit of "structure first", not a bug I can tune away, and it needs a decision from you (below).

## What was built
- **`packages/extract-web`**: reads JSON-LD (with tolerant parsing), schema.org microdata, `citation_*` meta, OpenGraph, plus two narrow low-confidence DOM rules (`mailto:` link with a name-like label; `<address>` block). Attaches evidence to every property, including a pointer to where the value is visible on the page. A resolver re-checks any evidence pointer against the live DOM. No OCR, no vision.
- **`apps/extension`**: Chrome/Edge MV3 popup. Permissions `activeTab` + `scripting` only, no background worker. Shows each object, its source ("Page metadata (JSON-LD)"), its least-sure field, and a **Show** button that highlights the source element on the page (or says the value came from hidden metadata). See `docs/permissions.md`.
- **`corpus/`**: 136 real pages (85 dev, 51 held-out; deterministic split by URL hash), hand-labelled truth, fetcher, scorer.
- **Core additions**: OpenGraph perceiver, more schema.org types (Festival, ProductGroup, many place types), `Last, First` to `First Last` author flip, `ResearchPaper.authors` optional.

## Accuracy (exact match after whitespace/case normalisation)
Official numbers are the **held-out, frozen** column: extractors frozen at commit `78682a2`, held-out pages labelled afterwards, run once. Three later changes (below) make the middle column not clean. Sample sizes are small; treat 100% on 9 items as "no misses seen", not "solved".

| Field | Held-out, frozen (official) | Held-out, after later fixes (not clean) | All 135 pages (dev + held-out, after fixes) |
|---|---|---|---|
| Event.end | 1/1 (100%) | 1/1 (100%) | 2/3 (67%) |
| Event.location | 7/7 (100%) | 7/7 (100%) | 20/21 (95%) |
| Event.start | 7/7 (100%) | 7/7 (100%) | 16/17 (94%) |
| Event.title | 9/9 (100%) | 9/9 (100%) | 24/25 (96%) |
| Location.address | 0/1 (0%) | 0/1 (0%) | 0/4 (0%) |
| Location.name | 0/9 (0%) | 0/9 (0%) | 0/19 (0%) |
| Person.name | 1/5 (20%) | 1/5 (20%) | 2/17 (12%) |
| Product.name | 3/3 (100%) | 3/3 (100%) | 8/9 (89%) |
| ResearchPaper.authors | 7/7 (100%) | 7/7 (100%) | 21/23 (91%) |
| ResearchPaper.authorsFirst | 3/3 (100%) | 3/3 (100%) | 9/9 (100%) |
| ResearchPaper.title | 11/12 (92%) | 12/12 (100%) | 35/35 (100%) |
| ResearchPaper.year | 9/9 (100%) | 9/9 (100%) | 32/32 (100%) |

Object level, held-out frozen: 26 of 38 labelled page objects found (68%), 1 spurious. By kind: events 9/9, papers 11/12, products 3/3, people 1/5, places 2/9. Related objects on a page (cards, recommendations; 55 held-out) are counted but not scored.

**Against the proposed targets:**
| Target | Result | Met? |
|---|---|---|
| 95% for `name/title` | Events 100% (9), products 100% (3), papers 92% frozen / 100% after fix; **people 20%, places 0%** | Structured: yes. People/places: **no** |
| 85% for dates and addresses | Event start 100% (7); **place address 0% (n=1)** | Dates: yes. Addresses: not demonstrated |
| 90% for `citation_*` where present | authors 100% (7), year 100% (9); DOI had 2 dev cases only | Yes |
| Evidence links back to the right element | 354/354 held-out (793/793 all) properties have a pointer that resolves; 99.5% on the first pointer | Yes, with caveat below |
| `url` accuracy | **Not measured** (I did not label URLs) | Unknown |

## Latency
- Extractor inside Chromium on real pages (all 136): warm p50 2 ms, p95 17 ms; **cold p50 13 ms, p95 32 ms, max 53 ms**.
- End to end through the extension (inject + extract + return), 30 runs on small fixtures: **p50 5 ms, p95 6.5 ms**.
- Budget is 100 ms for structured capture: met on everything measured. This is a fast sandbox CPU; a slow laptop may take 2 to 3 times as long, and the fixtures are smaller than real pages.

## Findings that should change decisions
1. **People and places mostly have no structure.** Of 14 dev place pages, none carried `Place`/`LocalBusiness` data (only generic `Organization`); personal sites and Wikipedia have no person markup. Restaurants, people and events are exactly the consumer cases, so this matters. Events (Eventbrite) and papers are the opposite: excellent structure.
2. **Data can be richer than what the page shows** (`Christopher D. Manning` in metadata, `Christopher Manning` on screen). Both are right; exact-match scoring counts it as a miss, and I did not bend the labels to fit.
3. **One page can contain many objects** (a Shopify product page had 36 "related product" cards). Each object is now marked primary or related.
4. **Metadata conventions differ** (`Last, First` authors), so normalisation is required for citations to look right.

## Decision needed: how to reach people and places
| Option | Effect | Cost / risk |
|---|---|---|
| **A. Accept for Layer 1** and cover them in Layer 2 by user-directed lift (you hover a name or address; Recast classifies that element in context) | No fake accuracy claims; matches the product idea (you point at the thing) | People/places need Layer 2's element-level capture |
| B. Per-site adapters (Wikipedia, LinkedIn, Zomato...) | High accuracy on those sites | Maintenance treadmill; the OLE/Smart Tags failure mode. Not recommended beyond a very small set |
| C. On-device small-model fallback for "what is the subject of this page / this element" | Could lift people/places on unstructured pages | Adds a model, latency and privacy design; must be opt-in and measured on this corpus |

**Recommendation: A now, then C inside Layer 2** (element-level, local, opt-in), and no per-site adapters.

## What changed after the held-out run (not clean)
1. `ResearchPaper.authors` made optional: one PLOS paper had a title and DOI but no author tags and was being rejected. (92% to 100% on paper titles.)
2. `<address>` text no longer runs words together ("Tate ModernBanksideLondon"), and the evidence resolver got the same fix.
3. OpenGraph objects merge into a structured one when they share two or more words (fixes duplicate products in a fixture).
4. Security hardening (below). These did not change held-out numbers.

## Security
Manual review (the skill could not run here); findings and fixes are in `docs/permissions.md`: prototype-key skipping, dropping `javascript:`/`data:` URLs, size/count limits against pages that stall the tab, a stricter popup CSP, and removing the test hook from production. `pnpm audit --prod`: no known vulnerabilities.

## Tests
core 74, extract-web 27, conformance 6 (22 fixture cases on 3 bindings), extension 15 (7 static audit checks incl. permissions, no network/storage/eval, no HTML sinks; 7 end-to-end in real Chromium incl. hostile-page XSS, highlight lands on the real element, latency). All pass, none skipped.

## Limits and honesty
- **Truth was labelled by me alone.** Please spot-check about 25 truth files, especially `corpus/truth/place-*.json` (place labelling is the most subjective; e.g. I counted museum home pages as places).
- **The corpus is biased**: this sandbox blocked many sites (Tripadvisor, Etsy, IMDb, GitHub, Zomato and others), so it over-represents arXiv, Nature, Eventbrite and Wikipedia and has no Indian consumer sites. Pages are static snapshots taken 2026-09-30; JavaScript-rendered content is missing; the fetcher did not read `robots.txt`.
- **Small held-out sets per field** mean wide error bars.
- **Not tested**: the real `activeTab` click flow (Playwright cannot do the gesture; end-to-end tests used a test build with `http://127.0.0.1/*` only), Edge, Firefox, Safari, screen readers, non-English pages.
- Snapshots are not in git (public repo). `corpus/README.md` explains how to rebuild them.

## How to try the production build by hand
`pnpm install && pnpm --filter @recast/extension run build`, then in Chrome: `chrome://extensions`, enable Developer mode, **Load unpacked**, choose `apps/extension/dist`. Open an arXiv, Nature or Eventbrite event page and click the Recast icon.

## What I need from you
1. Decision on people/places (A, B or C; I recommend A then C).
2. Spot-check ~25 truth files.
3. Optionally save ~30 pages from sites I could not fetch (Zomato, BookMyShow, Amazon.in, restaurant sites) into `corpus/pages/` so I can measure Indian consumer pages honestly.
4. Try the extension by hand once.
