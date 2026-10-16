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

## Added later: agents, approvals and the audit chain
Three more sections for the Agent Runtime (see `docs/13-agent-runtime.md`): **Agents** (what each may do and how many calls are left), **Approvals** (approve or reject what an agent asked for, once, for that exact request), **Audit chain** (every action with a verified/broken banner). They run on sample data unless the runtime's address, admin token and tenant id are set. The demo has no sign-in, so decisions are recorded as `demo-user`. 13 browser tests, axe clean on all nine sections.

## Added later: Postgres and sign-in
With `DATABASE_URL` set, the control center reads and writes the Supabase tables through `pg`. Each page or action runs as one transaction under the signed-in person's identity: role `authenticated`, plus the JWT claims that `auth.uid()` reads, all transaction-local. So row-level security, not application code, decides whose rows exist (`packages/store/src/scoped.ts`). A database with no sign-in configured refuses to start serving.

Sign-in has three modes, chosen by environment:
- **Demo** (no database): sample data, recorded as `demo-user`.
- **Local accounts** (`RECAST_SESSION_SECRET` of 32+ characters, `RECAST_LOCAL_USERS="email|scrypt-hash|uuid;..."`, hashes from `pnpm --filter @recast/web hash-password`): passwords are checked with scrypt in constant time, and unknown emails cost the same time. Success sets an HMAC-signed, httpOnly, SameSite=Lax cookie for 8 hours.
- **Supabase** (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_JWT_SECRET`): the server calls Supabase Auth's password grant and checks the access token (HS256, audience and role `authenticated`, expiry, uuid subject; `alg: none` refused). The proxy renews expired tokens with the refresh token.

`proxy.ts` sends anyone without a valid session to `/signin?next=...`. Every data page and action checks again. `next` only accepts same-site paths. Five wrong passwords lock that email for 15 minutes. That lock is per server instance, as stated in the code. Approvals now record the signed-in person.

Tested (`apps/web/test/postgres.test.ts`, 8 browser tests, and `session.test.ts`, 8 unit tests), using every migration in a Postgres wire server, the built app and Chromium:
- signed-out visitors are redirected and forged cookies are refused;
- two people see only their own rows, and one deleting everything leaves the other untouched;
- sign-out ends the session, and the lockout applies;
- Supabase sign-in and token renewal work against a stand-in Supabase Auth.

**Not verified:** a real Supabase project (task #21). Newer Supabase projects sign tokens with asymmetric keys (JWKS); only the legacy HS256 secret is supported here.

## Screenshots
`docs/images/layer4/`: objects, integrations and privacy, light and dark.

## Problems found while building
- Two test mistakes of mine: Next's route announcer is an empty `role=alert`, and a page lead line contained the word I asserted was gone. Both fixed in the tests.
- A missing icon caused a 404 on every page; added `app/icon.svg`.

## Not done, stated plainly
- **Live data.** The desktop and browser pieces don't write into this app yet; the demo data is seeded.
- **Deploy.** Not deployed. Needs a Supabase project and a Vercel project, which need your accounts.
- Demo state lives in server memory and resets on restart.
