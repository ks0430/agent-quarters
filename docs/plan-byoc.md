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

## 4. Pricing shape

They pay AWS directly (~$12/server/month), so our revenue is software-only.
Options:

- **Per server, flat** — e.g. $10–15/server/month. Simple, scales with usage,
  comparable to what they'd pay us in markup today.
- **Per organisation** — e.g. $99–299/month for unlimited servers. Attractive
  to companies with many agents; simpler procurement.
- **Enterprise minimum** — most BYOC vendors gate this behind an annual
  commitment because the support burden is real.

Note the economics flip: today ~34% margin on a marked-up server; in BYOC
our cost per server is ~$0 (they pay AWS), so **almost all of the software
fee is margin** — but we absorb more support cost.

## 5. Risks and honest downsides

| Risk | Mitigation |
|---|---|
| **Support burden** — debugging infrastructure we can't see | Lean on the per-server timeline + bootstrap error reporting we already have; add a "diagnostics bundle" the customer can send |
| **Their account blocks us** — SCPs, disabled regions, quota limits, no Lightsail | Phase 2 preflight checks; explicit error messages |
| **Version drift** — old host-agents in their account | Already solved: host-agent self-update reaches every instance |
| **Security review pressure** — they'll audit our IAM ask | Least-privilege policy + published CloudFormation + audit trail |
| **We can't clean up** — if they revoke the role, orphan servers keep billing *them* | Detect assume-role failure, mark the account degraded, warn loudly |
| **Complexity for a tiny company** | Gate it: enterprise-only, no self-serve, and only build when a real customer asks |

## 6. Recommendation

Build **Phase 1 + 2** only when there is a named customer waiting — which
may be your own company. It is roughly **2–3 days** of work because the
architecture already separates control plane from data plane. Don't
self-serve it: keep BYOC an assisted, enterprise-tier motion.

The strategic upside beyond revenue: BYOC removes the "your servers hold our
code and credentials" objection, which is the single biggest blocker to
selling this into companies.
