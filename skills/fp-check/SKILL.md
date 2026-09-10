---
name: fp-check
description: Multi-gate security audit that suppresses false positives before anything reaches the report. Use when asked to audit or security-review code (a diff, a repo, an API, a smart contract), when findings will be delivered to a client or filed to a bounty program, or when the user complains that security findings are noisy, speculative, or false positives. Validates every candidate through a scope check, a layered false-positive pattern library, an assumption audit, concrete-impact requirements, and PoC self-proof; reports findings tiered by confidence with a rejection log.
---

# Security audit with false-positive suppression

An audit is not finished when suspicious behavior is found. It is finished when every candidate finding has been either **validated or rejected with a recorded reason**. Run every candidate through the gates below in order; it stops at the first gate it fails. Only survivors are reported.

One-line operating principle: **explore broadly, filter with context, challenge assumptions, produce evidence before the user has to care.**

Cost model behind the pipeline: an unvalidated finding costs the reader far more than it costs the writer. Every gate exists to move noise out of the report before a human pays for it.

## Step 0 — Define "reportable" before hunting

Establish the scope contract before looking for vulnerabilities. A technically real issue is still not reportable if it is out of scope, already disclosed, or an accepted tradeoff.

1. From the user's request (ask if absent): in-scope components, deployment environment, threat model, eligible vulnerability classes, severity criteria.
2. From the repo: SECURITY.md, advisories (GHSA/CVE), past audit reports, known-issues lists, won't-fix or accepted-risk decisions, comments marking known behavior as intentional.
3. Record the contract in the report header, including known issues that must NOT be re-reported.

Out-of-scope checklist — reject if any answer is "no":

- Is the affected code within scope?
- Is the vulnerability class eligible?
- Is the affected deployment/configuration within scope?
- Has the issue already been acknowledged (advisory, changelog, issue, code comment)?
- Has the team explicitly accepted this behavior as a tradeoff?
- Would the applicable review rules recognize the claimed impact?

## Step 1 — Hunt broadly, collect candidates

Explore widely and cheaply; do not report yet. For each candidate record five fields — incomplete candidates are allowed, because the missing field is often exactly why a candidate later dies:

- Location (`file:line`)
- Claimed defect
- Triggering role (who must act: anonymous user, authenticated user, admin, deployer, external system)
- Victim (who or what is harmed that is not the attacker), or the broken property
- Preconditions (state that must hold before the attack)

## Step 2 — Gate: known false-positive patterns

Check each candidate against the pattern library in `references/false-positive-patterns.md`, from the most specific layer to the most general:

1. **Project layer**: `<repo>/.claude/security-audit-patterns.md` if present
2. **Domain/protocol layer** (lending market, bridge, vault; or API gateway, SPA + API, CI pipeline…)
3. **Language/framework layer** (Solidity, Rust, Go, Foundry; Express, Next.js…)
4. **Global patterns**

A matching pattern rejects the candidate — *unless the candidate explains why the pattern does not apply here*. Record the pattern ID in the rejection log.

When unsure whether a pattern matches, do not force it: pass the candidate to the next gate instead.

## Step 3 — Gate: assumption audit

Most plausible-looking findings rest on one load-bearing assumption that does not survive inspection. Interrogate the full setup:

- Can the system actually reach the required state through supported operations?
- Can the attacker create that state themselves, or does it require an admin or privileged actor to act (or misbehave)?
- Who controls the decisive parameters?
- Would a rational participant allow the condition to persist (keeper/arbitrageur/maintenance incentives)?
- Does the attack require extreme time, extreme capital, extreme coordination, or prolonged absence of intervention?
- Does the scenario depend on an oracle, bridge, signer, dependency, or other trusted external system misbehaving — and is that misbehavior itself demonstrated, or only assumed?

Calibration: distinguish **states a machine could reach** from **states plausible in production**. A pool becoming unusable after 300 days without any maintenance call is machine-possible; if the maintenance function is permissionless, economically incentivized, and normally runs every hour, the finding is noise.

## Step 4 — Gate: concrete code-level impact

Not every bad outcome is a vulnerability. Reject:

- **Self-harm** — only the attacker's own transaction fails, or only the attacker's own funds are lost.
- **Self-protecting code** — the code reverts, clamps, or validates; nothing breaks except the attacker's own call (e.g. checked-arithmetic overflow reverting user-supplied extreme input: the user loses gas, no protocol property is broken).
- **Universal footguns** — properties of the language or token standard everywhere, not a defect of the code under review (e.g. tokens transferred to a wrong address being unrecoverable).

A reportable finding must state all five:

1. The code-level defect
2. The role that can trigger it
3. The victim (non-attacker) or the broken protocol property
4. The unexpected state transition
5. The concrete impact

Disposition rules:

- Clear non-finding → reject, log why.
- Real but limited risk → keep as **informational**, not a vulnerability.
- Unresolved assumption → **needs-human-review**. Never silently promote it to a finding, and never silently bury it.

## Step 5 — Gate: self-proof (PoC), when runnable code exists

If the project has a test setup, the best validator for a surviving finding is a runnable proof.

A valid PoC:

- runs real code through the project's native test framework — no re-implementation of the logic under test
- grants the attacker only permissions they would realistically have
- asserts the **claimed impact** — not a proxy, not a precondition, not a conclusion pre-seeded in setup

Then audit the PoC itself before trusting it:

- Do the mocks create setups that cannot occur in reality?
- Was the attacker given a privileged role?
- Is the victim's loss pre-seeded in the test setup rather than caused by the attack?
- If the vulnerability were fixed, would the assertion still pass? (If yes, the PoC proves nothing.)
- Does it prove the original claimed impact, or a weaker one?
- Does running it reveal new preconditions that change the severity rating?

**Evidence wins.** If the PoC contradicts the written finding, correct, downgrade, or delete the finding — never the other way around.

If no runnable environment exists (diff-only review), mark confidence as `validated (reasoning only)` and say so in the report.

## Step 6 — Report

```markdown
## Scope
<one short paragraph: what is in scope, threat model, and known/accepted issues excluded>

## Findings
### [severity] Title — file:line
- Defect:
- Trigger / attacker role:
- Victim / broken property:
- Preconditions (each one validated in Step 3):
- Impact:
- Evidence: <PoC path + the assertion it checks, or explicit "reasoning only">
- Confidence: confirmed | validated (reasoning only) | informational | needs-review

## Rejected candidates
| Candidate (file:line) | Died at gate | Reason / pattern ID |
```

The rejection log is part of the deliverable: it lets the reader audit the filtering itself, and it feeds Step 7.

## Step 7 — Learn (after every audit)

Every false positive and every miss should change the system.

- A rejected candidate that revealed a new recurring weak conclusion → write it into the matching layer: project patterns go to `<repo>/.claude/security-audit-patterns.md` (create it); language/domain/global patterns go into this skill's `references/false-positive-patterns.md`.
- A filter that rejected a real finding (a miss surfaced later) → find which gate killed it and why, fix the pattern, then **re-run sibling candidates** past the corrected gate.
- Watch the direction of travel: false-positive reduction must *raise* recall over time, never lower it. If a pattern starts eating real findings, narrow the pattern — don't delete the lesson.
