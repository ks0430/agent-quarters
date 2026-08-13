# Plan: BYOC — run agents in the customer's own AWS account

**Status: proposed — not yet built.** (2026-08-13)

Enterprise customers often can't or won't have servers live in a vendor's
cloud account. In BYOC ("bring your own cloud") the **control plane stays
ours** (dashboard, orchestration, agent lifecycle, support) while the
**data plane runs in their AWS account** — they pay AWS directly for the
servers and pay us a software fee.

Our architecture is already split this way: the host-agent phones home, the
control plane never reaches in, and everything cloud-specific sits behind
one small provider adapter. BYOC is mostly a **credentials + billing**
change, not an architectural one.

## 1. How it works

```
        OUR ACCOUNT                              CUSTOMER'S AWS ACCOUNT
   ┌────────────────────┐   sts:AssumeRole    ┌──────────────────────────┐
   │  Control plane     │ ──(role + external  │  IAM role                │
   │  (Render)          │      id)──────────► │  AgentQuartersDeployRole │
   │  dashboard,        │                     │        │                 │
   │  billing, support  │                     │        ▼                 │
   └────────▲───────────┘                     │  Lightsail instances     │
            │  host-agent phones home         │   └ agent containers     │
            └─────────────────────────────────┴──────────────────────────┘
```

- We never hold their long-lived credentials. They create an IAM role that
  **trusts our AWS account**, guarded by a unique **ExternalId** (prevents
  the confused-deputy problem). We call `sts:AssumeRole` for 1-hour
  credentials each time we act.
- Instances still bootstrap exactly as today and phone home with their
  host_token, so agents, Slack, the API, pause/resume all work unchanged.
- Their servers, their bill, their VPC, their region — our software.

## 2. Build plan

### Phase 1 — connect an AWS account (~1 day)

1. **Schema:** `cloud_accounts(id, user_id, provider, role_arn, external_id,
   region, status, verified_at)`; `instances.cloud_account_id` (NULL = our
   account, so every existing instance keeps working untouched).
2. **Provider adapter:** `getProvider()` becomes `getProvider(account)`.
   When an account is given, mint credentials via `AssumeRoleCommand` and
   cache them (~50 min) keyed by role ARN. Everything downstream
   (create/pause/snapshot/static IP) is unchanged — it just gets a
   different client.
3. **Onboarding UI:** Settings → "Connect your AWS account" → we generate an
   ExternalId and show a **CloudFormation one-click link** that creates the
   role with our minimal policy. They paste back the Role ARN.
4. **Verify:** assume the role and make a harmless call
   (`GetRegions`/`GetInstances`); store `verified_at`, show green/red status.
   Store the role ARN with `enc()` like other customer data.

### Phase 2 — make it safe to sell (~1–2 days)

5. **Preflight checks** before the first deploy: confirm each required
   Lightsail action is permitted, the region is enabled, and quotas
   (instances, static IPs) aren't already exhausted. Fail with a clear,
   copy-pasteable fix rather than a mid-deploy error.
6. **Billing switch:** BYOC instances skip the usage markup entirely
   (`chargeInstance` returns early) and instead accrue a **flat platform
   fee** per server. Their Settings page shows "infrastructure billed by
   AWS to your account" so the numbers are never confusing.
7. **Deploy-time account picker:** "Deploy into: AgentQuarters cloud /
   My AWS account (acct 1234…)".
8. **Timeline as audit log:** every action we take in their account already
   lands in the per-server timeline — surface it as an exportable audit
   trail, which is exactly what their security team will ask for.

### Phase 3 — org readiness (later, only if demand appears)

9. Teams/organisations so several employees share one connected account and
   see each other's agents.
10. Multiple accounts/regions per org; SSO; per-seat pricing.

## 3. IAM policy they grant us

Same actions we already use — no more:

```
lightsail:CreateInstances, GetInstance(s), DeleteInstance,
lightsail:CreateInstanceSnapshot, GetInstanceSnapshot,
lightsail:DeleteInstanceSnapshot, CreateInstancesFromSnapshot,
lightsail:AllocateStaticIp, AttachStaticIp, ReleaseStaticIp, GetStaticIp
```

Trust policy: our account as principal + `sts:ExternalId` condition.
Ship it as a CloudFormation template so it's one click, reviewable, and
identical for every customer.

## 4. Market check (researched 2026-08-13)

**Who really does BYOC:** Databricks (canonical — classic compute in the
customer's account, serverless in theirs), Confluent/WarpStream, ClickHouse
Cloud (CloudFormation-installed `ClickHouseManagementRole`, requires a
committed contract), Instaclustr, Northflank, Estuary, groundcover, and
**E2B — the closest analogue to us** (agent sandboxes, BYOC on the
enterprise tier).

**Correction on Supabase:** they do **not** have a formal BYOC product.
What exists is (a) open-source self-hosting via Docker/Helm — unsupported,
you run it — and (b) an **AWS Marketplace listing** so purchases draw down
the customer's AWS spend commitment. That second point matters a lot (see
§7). No BYOC either: MongoDB Atlas, Neon, Temporal Cloud, Airbyte.

**Published pricing (rare — most route to sales):**

| Vendor | BYOC pricing |
|---|---|
| WarpStream (best template) | Software fee only, infra excluded: $100 / $500 / $1,500 per month tiers + $0.01/GiB throughput; idle clusters free; no per-node fees |
| ScaleGrid | Flat management fee **from $6/month** per database |
| Northflank | **No premium** — same price to run in your VPC |
| Databricks | ~$0.22/DBU in your account vs ~$0.70/DBU serverless in theirs |
| ClickHouse / Estuary / E2B / Airbyte | Enterprise only, annual commitment |

**Direction:** the *unit* software fee is usually flat or lower than hosted
(you've unbundled the infra markup), but **total contract value is higher**
because BYOC is gated behind an enterprise tier with a minimum commitment.

**Our shape:** keep the per-hour software rate roughly equal to today's
markup (~$6/server/month equivalent) so BYOC isn't a discount vector, plus
a platform floor. Economics flip in our favour — infra cost becomes ~$0, so
nearly all fee is margin — but support cost rises, which is exactly why
everyone gates it.

## 5. Risks and honest downsides

| Risk | Mitigation |
|---|---|
| **Support burden** — debugging infrastructure we can't see | Lean on the per-server timeline + bootstrap error reporting we already have; add a "diagnostics bundle" the customer can send |
| **Their account blocks us** — SCPs, disabled regions, quota limits, no Lightsail | Phase 2 preflight checks; explicit error messages |
| **Version drift** — old host-agents in their account | Already solved: host-agent self-update reaches every instance |
| **Security review pressure** — they'll audit our IAM ask | Least-privilege policy + published CloudFormation + audit trail |
| **We can't clean up** — if they revoke the role, orphan servers keep billing *them* | Detect assume-role failure, mark the account degraded, warn loudly |
| **Complexity for a tiny company** | Gate it: enterprise-only, no self-serve, and only build when a real customer asks |

## 6. The strongest warning from the field

Jack Vanlightly's [BYOC critique](https://jack-vanlightly.com/blog/2024/9/11/byoc-not-the-future-of-cloud-services-but-a-pillar-of-an-everywhere-platform)
is the sharpest: BYOC **destroys multi-tenant economics**. You inherit
"hundreds or thousands of single-tenant deployments across a heterogeneous
set of environments where the vendor has only partial control" — version
drift, blind debugging, and a three-way support boundary between you, the
customer and AWS. **Day one is easy; day two kills you.** An entire tooling
market (Nuon raised $16.5M and serves only a few dozen BYOC vendors) exists
because this is hard.

Practical guardrails, drawn from what works:
- **Zero-access posture** (Confluent/WarpStream's framing): minimise the IAM
  scope, no impersonation by default, just-in-time access for debugging.
- **Force auto-upgrade in the contract** — our host-agent self-update
  already delivers this technically.
- **Build remote diagnostics BEFORE selling.** We lose SSH-level debugging;
  log shipping and a downloadable diagnostics bundle are prerequisites, not
  nice-to-haves.

## 7. Consider first: AWS Marketplace (cheaper win)

If the customer's real driver is **"we must burn our committed AWS spend"**
— which is common — selling through **AWS Marketplace** achieves that with
none of the BYOC operational burden: their purchase draws down their EDP
commitment while the servers stay in *our* account. This is exactly what
Supabase does instead of BYOC.

**Ask the customer which they actually need:**
- "Spend commitment / procurement" → **AWS Marketplace listing** (days of
  paperwork, no engineering)
- "Data/servers must live in our VPC, security policy" → **real BYOC**

## 8. Recommendation

1. **First**, qualify the motivation — Marketplace may solve it.
2. **If genuinely BYOC**, build Phase 1 + 2 (~2–3 days) *only with a named
   customer waiting*, which may be your own company.
3. **Gate it**: enterprise-only, assisted onboarding, annual commitment with
   a meaningful floor. Never self-serve.
4. **Prerequisite**: remote diagnostics/log shipping shipped first.

The strategic upside beyond revenue: BYOC removes the "your servers hold our
code and credentials" objection — the single biggest blocker to selling this
into companies.
