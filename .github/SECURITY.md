# Security Policy

This document describes how to report security issues for MineStation (`current/`), the production-facing surface of this repository.

## Supported versions

The supported surface is the default/production branch of this repository (`current/`).

That includes:

- Root package `genesis-miner-server` (server)
- Nested `client/` application

We do not publish separate semantic version support matrices for this monorepo layout. The code on the default branch used for production in this repo is the supported target.

## Reporting a vulnerability

**Primary channel:** GitHub Private Vulnerability Reporting / Security Advisories on the canonical repository:

https://github.com/Mine-Station/minestation

Open a private advisory there (Security → Advisories / Report a vulnerability). Do **not** use other remotes or forks as the reporting channel unless maintainers explicitly redirect you.

We do **not** publish a dedicated security email for this project. Prefer GitHub’s private reporting flow so maintainers can triage privately.

### What to include

Please provide as much of the following as you can:

- Clear description of the issue and its impact
- Steps to reproduce (minimal repro preferred)
- Affected paths, endpoints, or components (e.g. auth, wallet, payments)
- Environment details needed to reproduce (browser/OS/runtime only if relevant)
- Whether you believe funds, sessions, admin access, or PII are at risk

### What not to do

- Do **not** open a public GitHub issue for security vulnerabilities
- Do **not** exploit the issue beyond what is necessary to demonstrate impact
- Do **not** access or modify data that is not yours
- Do **not** perform denial-of-service or social-engineering attacks as “proof”

## Response expectations

We acknowledge and investigate reports **as soon as reasonably possible**, and aim for coordinated disclosure. We do not publish fixed SLA timeouts in this policy.

## High-priority scope

Issues in the following areas are treated with elevated priority, especially when they can affect funds or user sessions:

- Authentication and session handling
- Wallet / custody-related flows
- Payments, economy, and balances
- Admin / privileged operations
- Personally identifiable information (PII)

## Dependency updates (Dependabot)

Dependency vulnerability alerts and Dependabot update PRs are welcome. Security-related dependency PRs will be triaged by maintainers.

## Internal documentation

Internal security notes live under [`docs/reference/security/README.md`](../docs/reference/security/README.md). That document is an internal map and may still contain legacy paths; it is **not** the public security policy. This file (`.github/SECURITY.md`) is the authoritative public policy.
