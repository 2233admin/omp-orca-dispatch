# XART development template

Private Gitea project template for local-first development with cached CI.

## Start

1. Create a repository from this template in Gitea.
2. Copy `.env.example` to `.env`; never commit `.env`.
3. Add the project-specific install, lint, test, and build commands.
4. Keep dependency lockfiles committed so Actions caches remain deterministic.

Use `xart-safe` for normal tests. Use `ubuntu-24.04` only for trusted workflows that genuinely need Docker access.

Renovate runs from the NAS during the low-traffic window and opens dependency PRs as `renovate-bot`. Keep `renovate.json` unless the project intentionally opts out.
