# Extension permissions and threat model (Layer 1)

## What the extension can do
| Permission | Why | What it allows |
|---|---|---|
| `activeTab` | Read the page you are looking at, only after you click the Recast button. | Temporary access to the current tab. Chrome grants it on your click and revokes it when you navigate or close the tab. |
| `scripting` | Inject the reader into that tab. | `chrome.scripting.executeScript` on tabs where `activeTab` is active. |

Nothing else: no `host_permissions`, no `<all_urls>`, no background worker, no content scripts that run on their own, no `storage`, `cookies`, `tabs`, `history`, `downloads` or network access. The production manifest is audited by a test (`apps/extension/test/manifest-audit.test.ts`).

## What it reads, and why
When you click: JSON-LD blocks, `<meta>` tags (`citation_*`, OpenGraph), schema.org microdata, `<a href="mailto:">` links and `<address>` elements, plus visible text nodes (held in memory only, to point at where a value appears). It returns the extracted objects (type, properties, confidence, evidence) to the popup. **It does not return page text, cookies, form values or storage.** Nothing is written to disk, sent anywhere, or kept after the popup closes.

## Threat model
The page is hostile: it controls every string and all the HTML the extractor sees.

| Threat | Mitigation | Verified by |
|---|---|---|
| Page strings run as HTML/script in the popup | Popup builds DOM with `textContent` only; no `innerHTML`/`outerHTML`/`DOMParser`; strict CSP (`default-src 'none'; script-src 'self'; connect-src 'none'`) | E2E test with a hostile page (`<img onerror>` in JSON-LD): shown literally, nothing runs; static test bans HTML sinks |
| Page reaches the extension's injected code | Reader runs in the isolated world; its global is not visible to page scripts; extension pages are not web-accessible | Manifest audit (no `web_accessible_resources`, no `externally_connectable`) |
| Data leaves the device | No network APIs in built code; CSP `connect-src 'none'` | Static test on `page.js`/`popup.js` (no fetch, XHR, WebSocket, beacon, storage, cookies) |
| `javascript:`/`data:` URLs carried into later actions | Only `http(s)` URLs kept for `url`, `image`, `pdfUrl`; others dropped and logged | Unit test |
| Prototype tampering via `itemprop="__proto__"` | Unsafe keys skipped | Unit test |
| Page stalls the tab (huge JSON-LD, millions of nodes) | Size and count limits (2 MB per JSON-LD block, repair only under 300 KB, 50 scripts, 1000 microdata items, 5000 properties, 2000 meta tags) | Unit tests (a large unrepairable block returns within 1.5 s) |
| Test hook chooses which tab to read | Compiled out of production (`__RECAST_TEST__`) | Static test |
| Vulnerable dependency | Runtime code is only Ajv-generated validators (precompiled, no runtime Ajv compile) | `pnpm audit --prod`: no known vulnerabilities |

## What was NOT done
- The `security-review` skill could not run here (needs a git remote ref this sandbox lacks). The review above was manual. It has not been independently audited.
- The real `activeTab` click flow is not automated (Playwright cannot perform the user gesture); the end-to-end tests use a test build that adds `http://127.0.0.1/*` host permission and nothing else. Please try the production build by hand (see the Layer 1 report).
- Edge and Firefox are untested. Screen-reader behaviour of the popup is untested.
- Pages are read as they are when you click. Content that a site loads later is not seen.
- The corpus fetcher does not check `robots.txt`.
