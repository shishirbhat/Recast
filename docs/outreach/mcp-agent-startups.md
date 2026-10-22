# Outreach: MCP-agent startups (design partners)

**Wedge:** teams building AI agents on MCP who need their agents to act safely on people's tools. **Message:** "Give your AI agent an identity, permissions and a paper trail, in one command." **What we measure:** how many first conversations become a running pilot, and how many pilots continue after two weeks.

Landing page: `/agents` on the API app (`apps/api/app/agents/page.tsx`). Every claim on it is in `apps/api/lib/claims.ts` with the file that proves it, and a test fails if that file disappears. Use the same rule here: **only send what is built and tested.** No customer names, user numbers, benchmarks against competitors, or claims that it is ready for production. Nothing has run with a real provider or a real design partner yet.

Nothing in this file has been sent to anyone.

## Who to write to
- Founders or first engineers of startups whose product is an agent that **acts** (sends, books, buys, edits), not only chats.
- Signals: they ship an MCP server or client, list tools that write to Gmail, calendars, CRMs or payments, or talk publicly about agents going wrong (wrong recipient, runaway loops, surprise bills).
- Not now: agents that only read; teams that need SOC 2 from a vendor before a pilot (we have no external review yet).

## First message (about 80 words)
> Hi {first name}, saw {their product} lets agents {the action, e.g. "send follow-ups from Gmail"}. We built a gateway for exactly that moment: each agent gets its own key, can only call the actions a person allowed (with a call and money budget and an expiry), asks before the risky ones, and every decision lands in a signed log. It works with MCP clients as they are. Would you try it on one agent for two weeks? I'll set it up with you.

## Shorter (X / LinkedIn DM)
> {first name}, when your agent {acts on X}, who decides what it may do, and where's the record? We built a small MCP gateway for that: per-agent identity, bounded permissions, approvals, signed audit. Looking for 3 design partners. Interested?

## Follow-up (5 to 7 days later, once)
> Following up once. The concrete version: one `agent-auth init`, a Space that says "drafts only, 200 calls, 3 days", and your MCP client points at `agent-auth connect`. If sending email ever shows up, it is refused and logged. Happy to show it in 20 minutes on your own tools. If now is not the time, no worries.

## If they ask
| Question | Honest answer |
|---|---|
| Is it hosted? | Not yet. For a pilot we run it with you, in your environment or ours. |
| Is it audited? | Internal review only (`docs/14-security-review.md`, open risks listed). Not externally reviewed. |
| What does it cost? | Free for design partners. Pricing comes from what pilots show is worth paying for. |
| Which MCP clients? | Tested with the official MCP SDK over HTTP and stdio. Not yet checked inside each desktop product. |
| What if your gateway is down? | Calls fail closed: nothing is forwarded without an audit entry. Your agent sees a clear error. |
| Can the agent go around it? | Only if it holds tool credentials itself. Keep them in the runtime's vault (`docs/17-agent-pilot.md`). |
| What about our data? | Model keys never pass through Recast. Logs and corrections are never used as training data without opt-in. |

## Before sending
- [ ] The landing page is deployed and `RECAST_CONTACT_URL` is set (needs task #21).
- [ ] A runtime is ready for the pilot (local or hosted, task #21).
- [ ] Each message is personalised: their product, their action. No mass sends.
