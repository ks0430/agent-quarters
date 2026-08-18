# Plan: first 10 customers

**Status: proposed.** (2026-08-18)

The product works end-to-end. The gap now is not features — it's that
**nobody except us has ever used it**, and a stranger currently *cannot*
try it. This plan closes that, then gets 10 real users.

Target: **10 paying-or-actively-using customers in ~3 weeks.**

---

## Part 1 — Blockers (a stranger can't sign up today)

These are hard blockers. Roughly 1–2 days of work total.

| # | Blocker | Why it stops a customer | Fix |
|---|---|---|---|
| 1 | **Stripe is in test mode** | Literally cannot take money | Activate the Stripe account, swap `sk_test_`→`sk_live_`, recreate the price + webhook in live mode |
| 2 | **New accounts have $0 credit** | Deploy is blocked until they pay — nobody pays before seeing it work | Seed new accounts with **$5 free credit** (~8 days of a server). Costs us ≤$3.30 each, so ≤$35 for all 10 |
| 3 | **Landing copy is out of date** | Says "paste your API key" — we now default to subscription login, our best feature | Rewrite hero around: laptop-free, keeps memory, chat from your phone, uses your existing Claude/ChatGPT plan |
| 4 | **Two brand names** | UI says "AgentDeploy", everything else says "AgentQuarters" | Pick one (AgentQuarters) and make the UI match |
| 5 | **`onrender.com` URL** | Looks like a weekend project; hurts trust at signup | Buy the domain, add it in Render, update `BASE_URL` |
| 6 | **No docs / help page** | Nobody knows what to do after signup | One `/help.html`: what it is, 5-step quickstart, Slack setup, FAQ, support email |
| 7 | **No terms / privacy page** | Stripe activation wants it; so do cautious users | Short, honest ToS + privacy page |
| 8 | **No support channel** | No way to reach you when stuck | A support email on the site + in the dashboard footer |

**Also decide (not code):** the **subscription-login ToS question**. It
determines whether the headline is "use your Claude Max plan" or
"bring your own key". Read Anthropic's current terms before marketing it.

---

## Part 2 — Make the first run succeed without you

The first 10 users will hit the same rough edges we hit. Cheap fixes:

- **Onboarding checklist on the empty dashboard** — "1. Deploy a server
  2. Choose your AI 3. Sign in 4. Connect Slack" so step 1 isn't a blank page.
- **Email on key events** — signup welcome, low balance, server ready.
  (Today the low-balance warning only shows if they happen to open the site.)
- **Slack setup is still the roughest path** — the ⚡ manifest link helps, but
  reinstall-after-scope-change bit us twice. Add a short "Slack setup" section
  in the help page with screenshots.
- **Watch the first 5 signups by hand** via the admin dashboard + timelines,
  and fix whatever they trip on the same day.

---

## Part 3 — Getting the 10 (week by week)

**Do not do a big launch.** Ten conversations beat one Show HN post that
lands on a product nobody has stress-tested.

### Week 1 — fix blockers, recruit 3 people you know
- Ship Part 1.
- Ask 3 developer friends/colleagues to run it for a week, free. Sit with
  them (screen share) for the first deploy. **Watch where they hesitate.**
- Goal: 3 users, ~10 fixes.

### Week 2 — targeted outreach where the pain is documented
The research found people actively complaining about exactly what we solve:
- Reddit: **r/ClaudeAI**, **r/ChatGPTCoding**, **r/selfhosted**
- The recurring threads: *"my laptop has to stay awake for the agent"*,
  *"can I run Claude Code on a server / from my phone?"*
- GitHub issues on anthropics/claude-code asking for remote/mobile access
- X/Twitter replies to people posting that frustration

**Method:** reply *helpfully* first (answer their actual question), then
mention you built something for it and offer free credit. No cold blasting.
Aim for 10–15 genuine conversations → ~5 sign-ups.

### Week 3 — one public post
Once 5+ people have used it without breaking:
- **Show HN: "I built a service that runs Claude Code on a server you own,
  so your laptop can sleep"** — lead with the pain, be honest about pricing
  and that it's early, include the architecture diagram.
- Same story as a Reddit post in r/ClaudeAI.
- Be online all day to reply.

Goal: 10 total users, 3–5 paying after free credit runs out.

---

## Part 4 — What to measure

For each of the 10, record:
1. Did they get to a working agent **without you**? (the only metric that matters early)
2. Where did they stall? (dashboard timeline shows it exactly)
3. Did they come back after day 1?
4. Did they top up after the free credit?
5. What did they ask for that we don't have?

**Kill criteria worth being honest about:** if fewer than half get to a
working agent unaided, stop marketing and fix onboarding. If they get it
working but don't return, the problem is value, not onboarding — and that's
a positioning conversation, not a feature one.

---

## Part 5 — Positioning (what to actually say)

From the market research, first-party tools (Claude Code Channels, Codex
Remote) now cover "remote agent" — so **don't lead with that**. Lead with
what they don't do:

> **Your agent, on your own server — it remembers.**
> Cloud agents reset after every task. AgentQuarters keeps your workspace,
> logins and conversation alive for weeks. Message it from Slack or your
> phone, or call it from code. Pause it for ~$1/month when you're not using it.

Differentiators, in order of strength:
1. **Persistent memory + workspace** (cloud agents are ephemeral)
2. **Slack** (Claude Code Channels has none)
3. **HTTP API** (drive it from CI/other apps)
4. **Unrestricted network + full machine** (sandboxes block egress)
5. **Pause to ~$1/mo** (Codespaces bills you for idle)

---

## Suggested order of work

1. Free starting credit + landing copy + brand (half a day) ← unblocks trying
2. Help page + support email + ToS (half a day)
3. Domain + Stripe live (half a day, some waiting on Stripe)
4. Onboarding checklist + emails (1 day, can trail the first users)
5. Then: recruit 3 → outreach → Show HN
