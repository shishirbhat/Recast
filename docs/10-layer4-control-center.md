# 10. Layer 4 report (web control center)

## Verdict
The control center runs and is tested end to end in a real browser, **in demo mode with in-memory data**. The database schema and its security rules are tested on a real Postgres engine (PGlite). **No Supabase project exists, nothing is deployed to Vercel, and the Supabase client adapter is not written yet.** Those create accounts, billing and public URLs, so they wait for your say-so.

## What was built
- `supabase/migrations/20260101000000_init.sql`: tables for objects, relationships, integrations, permission grants and an audit log. Every row has an owner; row-level security restricts each user to their own rows.
- `packages/store`: a `Repository` interface, an in-memory implementation and a SQL implementation. Both run the same 6 contract tests.
- `apps/web`: Next.js (App Router), TypeScript, Tailwind v4 with the Recast design tokens, `motion/react` for the nav pill, shadcn-style primitives. Six sections: Objects, Relationships, Integrations and reliability, Permissions, History and audit, Privacy and data controls.

## Rules the database enforces (tested, 8 tests)
- A user sees only their own rows in every table; the same object id can exist for two users.
- A signed-out request sees nothing and cannot write. Writing a row owned by someone else is rejected.
- Updating or deleting another user's row changes zero rows.
- The audit log is append-only: you can add and read your own lines, never edit or remove them.
- `delete_my_data()` erases only the caller's data and leaves one audit line saying so.
- A destination's reliability must be one of the five known classes.

## What the app does (11 browser tests, production build)
- Each section renders; the nav marks the current page.
- Relationships read as sentences: "Meera Iyer is an attendee of Launch dinner".
- Integrations show a plain reliability label (Reliable, Usually works, Best effort, Last resort, You do it) and can be turned off and on.
- Revoking a permission shows "Revoked" and is logged. Forgetting an object also removes its relationships.
- Export downloads one JSON file with everything, including the audit log.
- Delete everything needs the exact word DELETE. A wrong word deletes nothing and says so.
- Keyboard: a skip link first, then every nav link in order. axe finds no serious or critical issue on any section in light or dark. No sideways scroll at 375 px.

## Screenshots
`docs/images/layer4/`: objects, integrations and privacy, light and dark.

## Problems found while building
- Two test mistakes of mine: Next's route announcer is an empty `role=alert`, and a page lead line contained the word I asserted was gone. Both fixed in the tests.
- A missing icon caused a 404 on every page; added `app/icon.svg`.

## Not done, stated plainly
- **Sign-in.** Demo mode has one pretend user. Row-level security is proven in the database tests, but nothing in the app signs anyone in.
- **Supabase adapter.** The pages use `Repository`; the Supabase implementation is not written, so cloud sync does not exist.
- **Live data.** The desktop and browser pieces don't write into this app yet; the demo data is seeded.
- **Deploy.** Not deployed. Needs a Supabase project and a Vercel project, which need your accounts.
- Demo state lives in server memory and resets on restart.
