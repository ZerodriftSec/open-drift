# False-positive pattern library

Living document. Every pattern here was once a real false positive (or a near-miss that over-filtered). Append new patterns to the matching layer with an ID, the claim it matches, and why the claim is weak. When a pattern causes a missed real finding, narrow it and note the miss — never delete the lesson.

Check patterns from the project layer down to global. A pattern rejects a candidate **unless the candidate explains why the pattern does not apply here**.

## Layer 1 — Project-specific: `<repo>/.claude/security-audit-patterns.md`

Not in this file. Each audited repo keeps its own: known issues the team accepted, deliberate design decisions, environment-specific trust assumptions, results of past audits. Create the file at the end of an audit (Step 7) whenever lessons were learned, so the next audit of the same repo inherits them.

## Layer 2 — Domain / protocol

### D1. Trusted-external misbehavior assumed, not shown
Claim: "if the oracle / bridge / signer / dependency misbehaved, then …" with no evidence that it can or would.
Weak because: the audit target quietly becomes the trusted system instead of the code under review. Report only if the audited code fails to handle a *documented* failure mode of that external system.

### D2. Irrational-value extraction (DeFi)
Claim: an attack whose gas / capital / opportunity cost exceeds what it extracts, or where the attacker must already control everything of value.
Weak because: rational attackers don't run it. Exception: cheap griefing with denial-of-service relevance may still be informational.

### D3. Maintenance-dependent fragility where maintenance is permissionless and incentivized
Claim: the system breaks after N days / epochs with no upkeep.
Weak if upkeep is permissionless, economically incentivized, and normally runs continuously. Only a real finding if upkeep is privileged AND the privileged actor has no incentive or SLA to run it.

### D4. Multi-hop protection scope (AMM)
Claim: "no slippage protection" on a multi-hop path where protection exists on the decisive leg. Verify which leg the protection applies to before reporting.

## Layer 3 — Language / framework

### Solidity / EVM
- **S1. Expected revert on adversarial input** — user-supplied extreme values revert via checked arithmetic or `require`. That is self-protection, not a bug; the only victim is the caller.
- **S2. Standard proxy initialization assumptions** — initializer front-running concerns on standard proxy patterns where the documented deployment flow is followed.
- **S3. Tokens sent to a wrong address are unrecoverable** — a property of token transfers everywhere, not a defect of the code under review.
- **S4. Front-running with no victim** — MEV narrative where the only affected party is the attacker's own transaction.

### Web / API (general)
- **W1. Placeholder secrets** — secret-looking strings in `.env.example`, test fixtures, docs, or `xxx`-style keys are not credentials.
- **W2. Unauthenticated route serving intentionally public data** — verify against docs/routing intent before reporting missing auth.
- **W3. Self-XSS / same-actor CSRF** — the only victim is the attacker's own session.
- **W4. Unreachable dependency CVE** — vulnerable package version present, but the vulnerable code path is never invoked in this repo. Informational at most.
- **W5. "Admin can do bad things"** — actions available only to a role that the stated threat model already trusts. Not a finding unless privilege separation is itself the point of the system.

## Layer 4 — Global

### G1. User self-harm
The only harmed party is the actor who triggered the behavior. No non-attacker victim, no broken property.

### G2. Self-resolving transient state
Temporary inconsistency that normal operation eliminates on its own. Real only if meaningful damage completes before resolution.

### G3. Machine-possible but production-implausible
Reachable in the formal state space, but requires hundreds of days of neglect, extreme coordination, or counter-incentivized behavior. Downgrade to informational or reject, and state the empirical argument.

### G4. Known / acknowledged / accepted-risk
Already disclosed in an advisory, changelog, issue, or the team's accepted-risk list (Step 0 context). Re-reporting wastes both sides' time.

### G5. Conclusion-shaped evidence
The writeup asserts the impact and cites itself (or its own mock) as proof. Survives only after Step 5 (PoC) or an explicit reasoning-only downgrade.
