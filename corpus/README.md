# Corpus

Real web pages used to measure extraction accuracy. **Snapshots are not committed** (public repo, third-party content, 41 MB). Everything needed to rebuild them is:

- `sources.json`: URL and category of every page.
- `manifest.json`: what was fetched (status, size, sha256, fetched-at) and each page's split. Split is `sha256(url)[0] % 5 < 2` → held-out, else dev, so nobody chooses what is held out.
- `truth/<id>.json`: hand-labelled ground truth (what a person sees on the page). `{"skip": true}` excludes a corrupt snapshot.
- `fetch.mjs`: polite fetcher (identified user agent, 1 request/s/host, one attempt, no retry on 402/403/429; honours robots.txt, and a disallowed page is recorded as `robots-disallowed`, not fetched).
- `browser.mjs`, `eval.mjs`, `score.mjs`: load a snapshot in Chromium as a static page (page scripts blocked, network cut), run the extractor, score against truth.
- `peek.mjs`: prints what a person sees on a page, for labelling. Does not run the extractor.
- `reports/`: the results. `heldout-FROZEN-78682a2.json` is the official held-out run; `postfix-*` were produced after later changes and are not clean.

```
pnpm --filter @recast/corpus run fetch      # re-download snapshots (pages change; sha256 will differ)
pnpm --filter @recast/corpus run eval -- --split heldout
WHY=1 node eval.mjs --split dev             # list every miss
```

Protocol: extractors were developed on `dev` only. `heldout` was labelled after the extractors were frozen (commit `78682a2`) and run once. Any change after that is reported separately as not clean.

## Pages this sandbox cannot fetch (Amazon.in, Zomato, BookMyShow and others)
Bot blocks return 403/503 or reset the connection, and those are not retried. Save them from your own browser instead and use `import.mjs` (see its header): put the files and a `urls.txt` (`filename<TAB>category<TAB>url`) in `corpus/pages-user/`, run `node import.mjs --reduce-only` locally (strips scripts, styles, form values), check for personal data, push. The repo is public, so only push pages you are comfortable publishing. Imported pages are labelled from visible content first and evaluated once, as a separate clean set.
