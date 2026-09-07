/**
 * scan-action pure logic — no I/O here so the monorepo unit tests (lib.test.ts)
 * pin the contract: input parsing, severity semantics, summary rendering.
 * Masking discipline: this module only ever sees counts, check-side status,
 * and the masked report URL — never evidence (Constitution #4).
 */

export const SEVERITIES = ["critical", "high", "medium", "hygiene"];

/** Severity levels the step can fail on, worst-first; "never" = report-only. */
export const FAIL_ON_VALUES = [...SEVERITIES, "never"];

/** "worse or equal" rank: critical=3 … hygiene=0. */
export function severityRank(s) {
  const i = SEVERITIES.indexOf(s);
  return i === -1 ? -1 : SEVERITIES.length - 1 - i;
}

/**
 * Parse INPUT_* environment variables (GitHub Actions sets INPUT_<NAME> with
 * hyphens preserved, uppercased). Throws Error with a user-actionable message
 * on anything the runner cannot recover from.
 */
export function parseInputs(env) {
  const pick = (...names) => {
    for (const n of names) {
      const v = env[n];
      if (v !== undefined && v.trim() !== "") return v.trim();
    }
    return "";
  };

  const repo = pick("INPUT_REPO");
  if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,99}$/.test(repo)) {
    throw new Error(`repo input must be "owner/name" (got "${repo || "empty"}")`);
  }
  const prRaw = pick("INPUT_PR");
  const pr = Number(prRaw);
  if (!Number.isInteger(pr) || pr < 1) {
    throw new Error(
      `pr input must be a pull request number (got "${prRaw || "empty"}"). Run this action on pull_request events, or set pr: <number> explicitly.`,
    );
  }
  const failOn = pick("INPUT_FAIL-ON", "INPUT_FAIL_ON") || "critical";
  if (!FAIL_ON_VALUES.includes(failOn)) {
    throw new Error(`fail-on must be one of ${FAIL_ON_VALUES.join(" | ")} (got "${failOn}")`);
  }
  const apiUrl = (pick("INPUT_API-URL", "INPUT_API_URL") || "https://devmeth.com").replace(/\/+$/, "");
  if (!/^https:\/\/.+/.test(apiUrl)) {
    throw new Error(`api-url must be an https:// base URL (got "${apiUrl}")`);
  }
  const timeoutRaw = Number(pick("INPUT_TIMEOUT-MINUTES", "INPUT_TIMEOUT_MINUTES") || "15");
  if (!Number.isFinite(timeoutRaw) || timeoutRaw < 1 || timeoutRaw > 120) {
    throw new Error(`timeout-minutes must be 1–120 (got "${timeoutRaw}")`);
  }
  return { repo, pr, failOn, apiKey: pick("INPUT_API-KEY", "INPUT_API_KEY"), apiUrl, timeoutMs: timeoutRaw * 60_000 };
}

/**
 * Head/base SHAs from the workflow event payload. Returns null outside a
 * pull_request context — the server needs both to diff new-vs-base (D4) and
 * guessing a default-branch sha here would silently scan the wrong tree.
 */
export function prShas(event) {
  const head = event?.pull_request?.head?.sha;
  const base = event?.pull_request?.base?.sha;
  if (typeof head === "string" && /^[0-9a-f]{40}$/.test(head) && typeof base === "string" && /^[0-9a-f]{40}$/.test(base)) {
    return { sha: head, baseSha: base };
  }
  return null;
}

/**
 * Fail decision: counts are OPEN findings by severity on the scanned tree —
 * the same numbers the check-run conclusion uses. fail-on names the lowest
 * severity that still fails the step ("never" never fails).
 */
export function decideFailure(counts, failOn) {
  if (failOn === "never") return false;
  const target = severityRank(failOn);
  for (const s of SEVERITIES) {
    if (severityRank(s) >= target && Number(counts?.[s] ?? 0) > 0) return true;
  }
  return false;
}

/** Markdown step summary. Counts and links only — never evidence content. */
export function summaryMarkdown(run) {
  if (run.status === "failed") {
    return [
      "## Preflight scan",
      "",
      `The scan did not complete (\`${run.error ?? "unknown"}\`). Nothing was evaluated — re-run the workflow to try again.`,
    ].join("\n");
  }
  const lines = ["## Preflight scan", ""];
  const c = run.counts ?? {};
  const count = (s) => Number(c[s] ?? 0);
  if (run.status === "done") {
    lines.push(
      `${count("critical")} critical · ${count("high")} high · ${count("medium")} medium · ${count("hygiene")} hygiene finding(s) open on this tree.`,
      "",
    );
    if (typeof run.newCount === "number") {
      lines.push(
        run.newCount > 0
          ? `**${run.newCount} new vs base.**${run.gated ? " (public repo: inline PR comments are limited to the free checks — the report has everything.)" : ""}`
          : "No new findings vs base.",
        "",
      );
    }
    if (run.reportUrl) lines.push(`[Full report](${run.reportUrl})`, "");
  } else {
    lines.push(`Status: \`${run.status}\` — still in progress.`, "");
  }
  lines.push(
    "*Preflight checks the 30 known AI-code failure patterns — not a penetration test or a security guarantee. Findings are advisory: review before you merge.*",
  );
  return lines.join("\n");
}
