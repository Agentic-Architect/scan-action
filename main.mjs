/**
 * scan-action entry point (Phase 13 step 5). Zero dependencies, node20, no
 * checkout: parse inputs → POST /api/v1/ci/scan (shas from the event context)
 * → poll the run status URL → write the step summary → exit non-zero when the
 * fail-on threshold is met. The App-driven pipeline does the GitHub surface
 * (check-run, inline comments, masked report); this step is the workflow-side
 * view of the same run.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { parseInputs, prShas, decideFailure, summaryMarkdown } from "./lib.mjs";

const POLL_INTERVAL_MS = 10_000;
const MAX_CONSECUTIVE_POLL_ERRORS = 5;

const fail = (msg) => {
  console.log(`::error::${msg}`);
  process.exit(1);
};

async function apiFetch(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(15_000) });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, retryAfter: Number(res.headers.get("retry-after") ?? "0") };
}

function writeOutput(key, value) {
  const out = process.env.GITHUB_OUTPUT;
  if (out) appendFileSync(out, `${key}=${value}\n`);
}

function writeSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (file) appendFileSync(file, `${markdown}\n`);
}

async function main() {
  let inputs;
  try {
    inputs = parseInputs(process.env);
  } catch (err) {
    fail(err instanceof Error ? err.message : "invalid inputs");
  }

  let event = {};
  try {
    event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8"));
  } catch {
    fail(`could not read the workflow event payload (GITHUB_EVENT_PATH=${process.env.GITHUB_EVENT_PATH ?? "unset"})`);
  }
  const shas = prShas(event);
  if (!shas) {
    fail("no pull_request head/base SHA in the event — run this action on: pull_request");
  }

  const headers = { "content-type": "application/json" };
  if (inputs.apiKey) headers.authorization = `Bearer ${inputs.apiKey}`;

  const post = await apiFetch(`${inputs.apiUrl}/api/v1/ci/scan`, {
    method: "POST",
    headers,
    body: JSON.stringify({ repo: inputs.repo, pr: inputs.pr, ...shas }),
  });
  if (post.status === 429) {
    fail(`Preflight rate limit for this repo (public repos: 2 scans/hour). Retry after ~${post.retryAfter || 600}s.`);
  }
  if (post.status === 401) {
    fail(post.body?.error === "private_repo_requires_api_key"
      ? "This repository is private — an api-key input (Preflight API key) is required."
      : "Preflight rejected the api-key input (invalid or revoked).");
  }
  if (post.status === 404) {
    fail(`"${inputs.repo}" is not scan-ready: install the Preflight GitHub App on it first (and check spelling).`);
  }
  if (post.status !== 200 && post.status !== 202) {
    fail(`Preflight API returned ${post.status} (${post.body?.error ?? "no body"}).`);
  }

  const { ciRunId, statusUrl } = post.body;
  writeOutput("ci-run-id", ciRunId);
  console.log(`Preflight run ${ciRunId} — ${post.body.cached ? "cached (same commit already scanned)" : post.body.deduped ? "already in flight" : "queued"}.`);

  const deadline = Date.now() + inputs.timeoutMs;
  let run = null;
  let consecutiveErrors = 0;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    let res;
    try {
      res = await apiFetch(`${inputs.apiUrl}${statusUrl}`);
    } catch {
      res = null;
    }
    if (!res || res.status !== 200) {
      if (++consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
        fail(`lost contact with the Preflight API while polling (last status ${res ? res.status : "network error"}). The scan may still finish — check the PR check-run.`);
      }
      continue;
    }
    consecutiveErrors = 0;
    run = res.body;
    if (run.status === "done" || run.status === "failed") break;
  }

  if (!run || (run.status !== "done" && run.status !== "failed")) {
    fail(`scan did not finish within ${Math.round(inputs.timeoutMs / 60_000)} minutes — check the PR check-run for the result.`);
  }

  writeSummary(summaryMarkdown(run));
  if (run.status === "done") {
    writeOutput("critical", run.counts?.critical ?? 0);
    if (run.reportUrl) writeOutput("report-url", run.reportUrl);
    writeOutput("blocked", String(run.blocked === true));
    if (decideFailure(run.counts, inputs.failOn)) {
      const c = run.counts ?? {};
      fail(`Preflight found ${c.critical ?? 0} critical / ${c.high ?? 0} high / ${c.medium ?? 0} medium / ${c.hygiene ?? 0} hygiene finding(s) (fail-on: ${inputs.failOn}).`);
    }
    console.log("Preflight: no findings at or above the fail-on threshold.");
    process.exit(0);
  }
  // failed run — the summary carries the honest reason code
  fail(`Preflight scan failed (${run.error ?? "unknown"}).`);
}

main().catch((err) => fail(err instanceof Error ? err.message : "unexpected action failure"));
