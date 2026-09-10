---
name: finding-format-skill
description: Defines the canonical Markdown structure and English severity rubric for security findings. Use whenever Codex needs to write, format, or review security findings in a document, report, or audit artifact.
---

# Finding Format Skill

## Finding Fields

- `title`: Concisely describe the specific vulnerability and identify its root cause or direct impact.
- `severity`: Use only `critical`, `high`, `medium`, `low`, or `info`.
- `file_path`: Provide the affected source path relative to the audit target root.
- `root_cause`: Identify the specific faulty logic, missing validation, or ineffective security control. Do not describe only the surface symptom.
- `description`: Describe the vulnerability in detail.
- `impact`: State the demonstrated security consequence, affected asset, or violated invariant.
- `recommendation`: Provide a concrete remediation that addresses the root cause.
- `source_locations`: List the source files, start and end lines, and any necessary code excerpts.

## Severity Definitions

Determine severity from the demonstrated production impact, attacker reachability, exploitation prerequisites, and scope of impact. Do not rate a finding by its theoretical maximum impact.

- `critical`: An extremely severe vulnerability that requires no special access and can directly steal or permanently lock protocol funds, or completely disable the system.
- `high`: A severe vulnerability that can cause partial loss of funds or compromise the core economic model, but requires specific conditions or significant prerequisites to exploit.
- `medium`: A vulnerability with prerequisites or limited scope that does not directly cause loss of funds but can cause functional failure, denial of service (DoS), or invalid state transitions.
- `low`: A defense-in-depth issue with a concrete but minor production impact that cannot directly cause significant loss of assets, privileges, integrity, or availability.
- `info`: A hardening recommendation or code-quality issue with no demonstrated security impact.

Treat any path requiring a contract owner, privileged role, multisig, allowlist membership, hard-coded address, or private key as requiring special privileges. Unless an ordinary external user can bypass that check, the finding must not be rated critical and should be downgraded to `info`.
Reserve higher severities for concrete issues that require no special access, are reachable through production paths, and have end-to-end evidence. Lower the severity when any of the following conditions apply. If production reachability or real security impact cannot be demonstrated, downgrade the finding to `info` and explicitly record the missing evidence:

- The issue is purely theoretical.
- The path is reachable only from test code.
- Exploitation requires local privileges.
- Exploitation depends on a non-default configuration.
- Exploitation depends on brute force or winning a race condition.
- End-to-end evidence is missing.
- The issue is a suspected false positive.

## Markdown Output Format

```markdown
## [severity] Finding title

- File Path: `path/relative/to/audited/target.sol`

### Root Cause

The exact faulty logic or missing security control.

### Impact

The demonstrated security outcome and affected asset or invariant.

### Description

The detailed description of the finding.

### Recommendation

Optional concrete remediation.

### Source Locations

- `path/relative/to/audited/target.sol:10-20`
  ```solidity
  vulnerable source snippet
  ```
