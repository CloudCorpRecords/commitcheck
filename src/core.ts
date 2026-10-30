/**
 * commitcheck core: check commit hygiene over a repo's recent history.
 *
 * runCheck shells out to git log for the most recent 50 commits, parses
 * the records with parseCommits, and evaluates them with checkCommits.
 * parseCommits and checkCommits are pure: they take text and records,
 * never touch git, and are the units the tests exercise directly.
 *
 * Checks are adaptive. A commit is only flagged for a missing
 * Signed-off-by trailer when the repo's own history shows a DCO
 * convention (at least half of the other commits in the range carry a
 * well-formed sign-off), and it is only flagged for breaking a message
 * convention when one style dominates at least 70 percent of the range.
 *
 * Output is deterministic: findings follow git log order (newest
 * first), and within one commit they follow the fixed rule order used
 * in checkCommits.
 */
import { execFileSync } from "node:child_process";
import type { Finding, Report, Severity } from "./types.js";

export const VERSION = "0.1.0";
export const CLEAN_VERDICT = "CLEAN";
export const FINDINGS_VERDICT = "FINDINGS";

export const MAX_COMMITS = 50;
export const SUBJECT_LIMIT = 72;

export interface Trailer {
  key: string;
  value: string;
}

export interface CommitRecord {
  sha: string;
  shortSha: string;
  /** First line of the commit message. */
  subject: string;
  /** Everything after the subject line, with outer blank lines trimmed. */
  body: string;
  /** The full commit message as git reported it. */
  message: string;
  /** Trailer lines (Key: value) collected from the end of the message. */
  trailers: Trailer[];
}

/* ------------------------------------------------------------------ */
/* Parsing                                                             */
/* ------------------------------------------------------------------ */

const TRAILER_RE = /^([A-Za-z][A-Za-z0-9-]*):[ \t]+(.*)$/;
const EMAIL_IN_VALUE_RE = /<[^<>\s]+@[^<>\s]+>/;
const SIGNOFF_LINE_RE = /^Signed-off-by:[ \t]*(.*)$/i;

/**
 * Parse the exact output of
 *   git log --format=%H%x00%B%x1e
 * Records are separated by the record separator \x1e; inside a record a
 * NUL separates the sha from the full message (%B). Order is preserved
 * as given (git log order, newest first).
 */
export function parseCommits(text: string): CommitRecord[] {
  const records: CommitRecord[] = [];
  for (const chunk of text.split("\x1e")) {
    const cleaned = chunk.replace(/^\r?\n/, "");
    if (cleaned.trim() === "") continue;
    const nul = cleaned.indexOf("\x00");
    if (nul < 0) continue;
    const sha = cleaned.slice(0, nul).trim();
    if (sha === "") continue;
    const message = cleaned.slice(nul + 1).replace(/\r\n/g, "\n").replace(/\n+$/, "");
    const lines = message.split("\n");
    const subject = (lines[0] ?? "").trim();
    const body = lines.slice(1).join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
    records.push({
      sha,
      shortSha: sha.slice(0, 7),
      subject,
      body,
      message,
      trailers: parseTrailers(message),
    });
  }
  return records;
}

/** Collect the trailer block: matching Key: value lines at the end. */
function parseTrailers(message: string): Trailer[] {
  const lines = message.split("\n");
  const trailers: Trailer[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      if (trailers.length > 0) break;
      continue;
    }
    const m = TRAILER_RE.exec(line.trim());
    if (!m) break;
    trailers.unshift({ key: m[1] ?? "", value: (m[2] ?? "").trim() });
  }
  return trailers;
}

/** Every Signed-off-by line in the record, wherever it appears. */
function signoffValues(commit: CommitRecord): string[] {
  const values: string[] = [];
  const text = commit.message !== "" ? commit.message : `${commit.subject}\n${commit.body}`;
  for (const line of text.split("\n")) {
    const m = SIGNOFF_LINE_RE.exec(line.trim());
    if (m) values.push((m[1] ?? "").trim());
  }
  for (const t of commit.trailers) {
    if (t.key.toLowerCase() === "signed-off-by" && !values.includes(t.value)) values.push(t.value);
  }
  return values;
}

function hasValidSignoff(commit: CommitRecord): boolean {
  return signoffValues(commit).some((v) => EMAIL_IN_VALUE_RE.test(v));
}

function malformedSignoffs(commit: CommitRecord): string[] {
  return signoffValues(commit).filter((v) => !EMAIL_IN_VALUE_RE.test(v));
}

function isMergeCommit(commit: CommitRecord): boolean {
  return /^Merge\b/.test(commit.subject);
}

/* ------------------------------------------------------------------ */
/* Style detection                                                     */
/* ------------------------------------------------------------------ */

const CONVENTIONAL_RE = /^[a-z][a-z0-9-]*(\([^)]*\))?!?:[ \t]+\S/;
const CAPITALIZED_RE = /^[A-Z][a-z]/;

function isConventional(subject: string): boolean {
  return CONVENTIONAL_RE.test(subject);
}

function isCapitalized(subject: string): boolean {
  return CAPITALIZED_RE.test(subject) && !isConventional(subject);
}

type DominantStyle = "conventional" | "capitalized" | null;

function dominantStyle(commits: CommitRecord[]): DominantStyle {
  const eligible = commits.filter((c) => !isMergeCommit(c) && c.subject.trim() !== "");
  if (eligible.length === 0) return null;
  const conventionalShare = eligible.filter((c) => isConventional(c.subject)).length / eligible.length;
  if (conventionalShare >= 0.7) return "conventional";
  const capitalizedShare = eligible.filter((c) => isCapitalized(c.subject)).length / eligible.length;
  if (capitalizedShare >= 0.7) return "capitalized";
  return null;
}

const VAGUE_SUBJECTS = new Set([
  "wip",
  "fix",
  "fixes",
  "fix stuff",
  "update",
  "updates",
  "change",
  "changes",
  "misc",
  "temp",
  "tmp",
  "todo",
  "stuff",
  "work",
  "commit",
  "asdf",
  ".",
  "..",
]);

function isVagueSubject(subject: string): boolean {
  const trimmed = subject.trim();
  if (trimmed === "") return true;
  const lower = trimmed.toLowerCase();
  if (VAGUE_SUBJECTS.has(lower)) return true;
  // "wip." and "fix." are the same placeholders with punctuation.
  const stripped = lower.replace(/\.+$/, "");
  return stripped !== lower && VAGUE_SUBJECTS.has(stripped);
}

/* ------------------------------------------------------------------ */
/* Checks                                                              */
/* ------------------------------------------------------------------ */

/**
 * Evaluate parsed commits and build the report. Pure: no git, no I/O.
 * Findings are emitted in input order (git log order, newest first);
 * for one commit the rule order is SUBJECT-TOO-LONG, SUBJECT-VAGUE,
 * NO-SIGNOFF, CONVENTION-BREAK, MERGE-COMMIT, TRAILER-MALFORMED.
 */
export function checkCommits(commits: CommitRecord[], target = ""): Report {
  const findings: Finding[] = [];
  const style = dominantStyle(commits);
  const signed = commits.map((c) => hasValidSignoff(c));

  commits.forEach((commit, i) => {
    const evidence = commit.shortSha || commit.sha.slice(0, 7);
    const push = (rule: string, severity: Severity, message: string): void => {
      findings.push({ rule, severity, message, evidence });
    };

    if (commit.subject.length > SUBJECT_LIMIT) {
      push(
        "SUBJECT-TOO-LONG",
        "medium",
        `Subject is ${commit.subject.length} chars, over the ${SUBJECT_LIMIT} char limit: "${commit.subject}"`,
      );
    }

    if (isVagueSubject(commit.subject)) {
      push(
        "SUBJECT-VAGUE",
        "low",
        commit.subject.trim() === ""
          ? "Subject is empty; a commit message needs a subject line that says what changed."
          : `Subject "${commit.subject}" is a placeholder that says nothing about what changed.`,
      );
    }

    // Adaptive DCO rule: flag a missing sign-off only when at least
    // half of the OTHER commits in the range carry a well-formed one.
    // A repo that does not use sign-off is never flagged for it.
    if (!signed[i]) {
      const others = signed.filter((_, j) => j !== i);
      if (others.length > 0) {
        const signedOthers = others.filter(Boolean).length;
        if (signedOthers / others.length >= 0.5) {
          push(
            "NO-SIGNOFF",
            "medium",
            `No Signed-off-by trailer, but ${signedOthers} of ${others.length} other commits in the range carry one, so this repo follows the DCO convention.`,
          );
        }
      }
    }

    if (style !== null && !isMergeCommit(commit) && commit.subject.trim() !== "") {
      const follows = style === "conventional" ? isConventional(commit.subject) : isCapitalized(commit.subject);
      if (!follows) {
        push(
          "CONVENTION-BREAK",
          "low",
          style === "conventional"
            ? `Subject "${commit.subject}" breaks the dominant conventional style (type: prefix) used by at least 70 percent of this range.`
            : `Subject "${commit.subject}" breaks the dominant capitalized imperative style used by at least 70 percent of this range.`,
        );
      }
    }

    if (isMergeCommit(commit)) {
      push("MERGE-COMMIT", "info", `Merge commit: "${commit.subject}". Reported for context; merge commits are never a finding above info.`);
    }

    for (const value of malformedSignoffs(commit)) {
      push(
        "TRAILER-MALFORMED",
        "low",
        `Signed-off-by trailer has no email shape (expected "Name <name@example.com>"): "Signed-off-by: ${value}"`,
      );
    }
  });

  const counts: Record<string, number> = { commits: commits.length, findings: findings.length };
  let medium = 0;
  let low = 0;
  let info = 0;
  for (const f of findings) {
    counts[f.rule] = (counts[f.rule] ?? 0) + 1;
    if (f.severity === "medium") medium += 1;
    else if (f.severity === "low") low += 1;
    else if (f.severity === "info") info += 1;
  }
  counts["medium"] = medium;
  counts["low"] = low;
  counts["info"] = info;

  const verdict = medium > 0 ? FINDINGS_VERDICT : CLEAN_VERDICT;
  const summary =
    commits.length === 0
      ? "Checked 0 commits: the range is empty."
      : `Checked ${commits.length} commit${commits.length === 1 ? "" : "s"}: ${findings.length} finding${findings.length === 1 ? "" : "s"} (${medium} medium, ${low} low, ${info} info). Verdict ${verdict}.`;

  return {
    tool: "commitcheck",
    version: VERSION,
    target,
    verdict,
    counts,
    findings,
    summary,
  };
}

/* ------------------------------------------------------------------ */
/* Running against a repo                                              */
/* ------------------------------------------------------------------ */

export function runCheck(target: string): Report {
  let text: string;
  try {
    text = execFileSync("git", ["-C", target, "log", "-n", String(MAX_COMMITS), "--format=%H%x00%B%x1e"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message.split("\n")[0] : String(err);
    throw new Error(
      `commitcheck: could not read git history for "${target}" (${detail}). Make sure the target is a git repository with at least one commit and that git is on PATH.`,
    );
  }
  return checkCommits(parseCommits(text), target);
}

/* ------------------------------------------------------------------ */
/* Rendering                                                           */
/* ------------------------------------------------------------------ */

export function renderReport(report: Report): string {
  const out: string[] = [];
  out.push(`commitcheck check ${report.target}: ${report.verdict}`);
  out.push(
    `  commits: ${report.counts["commits"] ?? 0}, findings: ${report.counts["findings"] ?? 0} (medium: ${report.counts["medium"] ?? 0}, low: ${report.counts["low"] ?? 0}, info: ${report.counts["info"] ?? 0})`,
  );
  for (const f of report.findings) {
    out.push(`  [${f.severity.toUpperCase()}] ${f.rule}${f.evidence ? ` ${f.evidence}` : ""} ${f.message}`);
  }
  out.push(`  ${report.summary}`);
  if (report.verdict === CLEAN_VERDICT) {
    out.push("CLEAN: no medium findings in the checked range.");
  } else {
    out.push("FINDINGS: at least one medium finding needs attention.");
  }
  return out.join("\n");
}
