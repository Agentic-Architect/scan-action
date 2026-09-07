# Preflight Scan

Runs the Preflight check on your pull requests: the **30 known AI-code failure
patterns** — committed secrets, open databases, missing auth, and the rest of
the list AI-generated code fails at most often. Writes a step summary with
masked findings and fails the step on Critical (configurable).

> Preflight checks known failure patterns. It is not a penetration test or a
> security guarantee — findings are advisory, and review before you merge is
> still your job.

## What it does

1. Sends the PR's head/base SHAs to the Preflight API (`api-url`).
2. The full engine runs off-GitHub: secrets (gitleaks), raw SQL, missing RLS,
   exposed service keys, and 26 more checks.
3. The Preflight GitHub App posts the check-run, inline comments on new
   findings, and a masked full report — **this action step** adds the workflow
   summary, outputs, and the fail/success exit code.
4. Re-runs of the same commit replay the cached result: pushing a no-op commit
   or re-running the workflow never re-scans an unchanged tree.

Public repos are free. Private repos need a Preflight API key (CI tier,
$19/mo per private repo, includes the API).

## Requirements

- The **Preflight GitHub App** installed on the repository (it posts the
  check-run and comments; without it there is nothing to trigger).
- Run on `pull_request` events — the action reads head/base SHAs from the
  event context and does **not** check out your code.

## Usage

```yaml
on: [pull_request]

jobs:
  preflight:
    runs-on: ubuntu-latest
    permissions: {} # the action needs no repo permissions
    steps:
      - uses: devmeth/scan-action@v1
        with:
          fail-on: critical
          # api-key: ${{ secrets.PREFLIGHT_API_KEY }}   # private repos only
```

## Inputs

| Input             | Default              | Description                                                                 |
| ----------------- | -------------------- | --------------------------------------------------------------------------- |
| `repo`            | `${{ github.repository }}` | Repository to scan (`owner/name`).                                    |
| `pr`              | PR number from the event | Pull request number.                                                  |
| `fail-on`         | `critical`           | Fail the step at this severity or worse: `critical` / `high` / `medium` / `hygiene` / `never`. |
| `api-key`         | _(empty)_            | Preflight API key (`dvm_…`) — required for private repos, which must belong to the key's org. |
| `api-url`         | `https://dev-meth-web.vercel.app` | Preflight deployment base URL.                                            |
| `timeout-minutes` | `15`                 | Poll limit for the scan (a full scan typically finishes in 1–3 minutes).    |

## Outputs

| Output      | Description                                             |
| ----------- | ------------------------------------------------------- |
| `ci-run-id` | The Preflight run id (also in the step summary).        |
| `critical`  | Critical finding count on the scanned tree (when done). |
| `report-url`| Masked share-link report (when done).                   |
| `blocked`   | `true` when the repo's critical threshold was met.      |

## Rate limits and cost

- Public repos: 2 PR scans/hour, 8/day per repo — shared with runs the App
  triggers from PR events. Cache hits don't count.
- The nightly full scan of the default branch and live-deployment checks are
  configured per-repo via `.devmeth.yml` (see the docs).
- Scanned code is deleted after every scan.

## License

MIT
