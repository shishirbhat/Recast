# Recast

Connect two digital things directly so the computer understands the relationship: GRAB, APPROACH, PREVIEW, PLACE.

Status: **Layer 0 done. Layer 1 built (gate met for structured pages). Layer 2a (interaction engine, overlay, harness) built and tested in Chromium; Windows shell and usability gate open (`docs/08-layer2-interaction.md`). Layer 4 control center built in demo mode, schema and security tested, not deployed (`docs/10-layer4-control-center.md`).**

```
pnpm install && pnpm gen && pnpm typecheck && pnpm test
```

- `docs/01-research.md` verified facts, sources, dead ends
- `docs/02-architecture.md` monorepo, schema strategy, core API, shells
- `docs/03-decisions.md` open decisions and recommendations
- `docs/04-design-system.md`, `design/tokens.css`, `design/mockups.html`
- `docs/05-plan.md` Layers 0 to 2 plan and estimates
- `docs/06-layer0-report.md` Layer 0 results
- `docs/07-layer1-report.md` Layer 1 results, `docs/permissions.md` extension threat model, `corpus/README.md`
- `docs/08-layer2-interaction.md` Layer 2a results, `docs/09-windows-spike-kit.md` Windows feasibility kit
- `docs/10-layer4-control-center.md` Layer 4 results (`apps/web`, `packages/store`, `supabase/migrations`)
- `docs/11-bridges.md` Calendar, Gmail draft, Sheets, Tasks and Notion bridges as data (`packages/bridges`), not run against live services
