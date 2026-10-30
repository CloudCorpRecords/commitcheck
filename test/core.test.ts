/**
 * Core tests for commitcheck. The unit under test is parseCommits over
 * recorded git log output (fixture files under test/fixtures, written
 * with the real NUL and record separator control characters), plus
 * checkCommits over the parsed records. No git is needed here; the
 * git-backed path is covered by test/pipe.test.ts.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VERSION,
  CLEAN_VERDICT,
  parseCommits,
  checkCommits,
  runCheck,
  renderReport,
  type CommitRecord,
} from "../src/core.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), "utf8");
}

function checkFixture(name: string) {
  return checkCommits(parseCommits(fixture(name)), name);
}

function rules(report: ReturnType<typeof checkCommits>, rule: string): number {
  return report.counts[rule] ?? 0;
}

describe("parseCommits", () => {
  it("parses sha, subject, body, and trailers from the git format", () => {
    const commits = parseCommits(fixture("clean.txt"));
    assert.equal(commits.length, 4);
    const first = commits[0] as CommitRecord;
    assert.equal(first.sha, `0000001${"0".repeat(33)}`);
    assert.equal(first.shortSha, "0000001");
    assert.equal(first.subject, "feat: add commit parser");
    assert.match(first.body, /Parses the git log stream\./);
    assert.equal(first.trailers.length, 1);
    assert.equal(first.trailers[0]?.key, "Signed-off-by");
    assert.equal(first.trailers[0]?.value, "Jane Dev <jane@example.com>");
  });

  it("keeps git log order (newest first) untouched", () => {
    const commits = parseCommits(fixture("clean.txt"));
    assert.deepEqual(
      commits.map((c) => c.subject),
      [
        "feat: add commit parser",
        "fix: handle empty ranges",
        "docs: document the adaptive DCO rule",
        "test: cover the trailer parser",
      ],
    );
  });

  it("parses empty input and control character escapes built inline", () => {
    assert.deepEqual(parseCommits(""), []);
    const text = `${"a".repeat(40)}\u0000feat: inline record\n\nSigned-off-by: A U Thor <a@example.com>\u001e`;
    const commits = parseCommits(text);
    assert.equal(commits.length, 1);
    assert.equal(commits[0]?.subject, "feat: inline record");
    assert.equal(commits[0]?.trailers[0]?.key, "Signed-off-by");
  });

  it("parses an empty message as an empty subject", () => {
    const commits = parseCommits(fixture("vague.txt"));
    const last = commits[commits.length - 1];
    assert.equal(last?.subject, "");
  });
});

describe("checkCommits verdicts", () => {
  it("exports the pinned version and clean verdict", () => {
    assert.equal(VERSION, "0.1.0");
    assert.equal(CLEAN_VERDICT, "CLEAN");
  });

  it("a clean conventional repo with sign-offs is CLEAN with no findings", () => {
    const report = checkFixture("clean.txt");
    assert.equal(report.verdict, "CLEAN");
    assert.equal(report.counts["commits"], 4);
    assert.equal(report.findings.length, 0);
    assert.equal(report.tool, "commitcheck");
    assert.equal(report.version, "0.1.0");
  });

  it("missing sign-offs in a DCO repo produce NO-SIGNOFF medium findings", () => {
    const report = checkFixture("dco-missing.txt");
    assert.equal(report.verdict, "FINDINGS");
    assert.equal(rules(report, "NO-SIGNOFF"), 1);
    const finding = report.findings.find((f) => f.rule === "NO-SIGNOFF");
    assert.equal(finding?.severity, "medium");
    // Evidence carries the short sha of the unsigned commit (record 12).
    assert.equal(finding?.evidence, "000000c");
    assert.ok(report.findings.every((f) => typeof f.evidence === "string" && f.evidence.length === 7));
  });

  it("a non-DCO repo gets no sign-off flags at all", () => {
    const report = checkFixture("non-dco.txt");
    assert.equal(rules(report, "NO-SIGNOFF"), 0);
    assert.equal(report.verdict, "CLEAN");
    assert.equal(report.findings.length, 0);
  });

  it("vague and empty subjects are flagged SUBJECT-VAGUE at low severity", () => {
    const report = checkFixture("vague.txt");
    assert.equal(report.counts["commits"], 6);
    assert.equal(rules(report, "SUBJECT-VAGUE"), 6);
    assert.ok(report.findings.every((f) => f.severity === "low"));
    // Low findings alone do not change the verdict: CLEAN is defined as
    // no medium findings.
    assert.equal(report.verdict, "CLEAN");
  });

  it("an overlong subject is a medium SUBJECT-TOO-LONG finding", () => {
    const report = checkFixture("overlong.txt");
    assert.equal(report.verdict, "FINDINGS");
    assert.equal(rules(report, "SUBJECT-TOO-LONG"), 1);
    const finding = report.findings[0];
    assert.equal(finding?.severity, "medium");
    assert.match(finding?.message ?? "", /84 chars/);
  });

  it("a commit breaking the dominant convention is flagged CONVENTION-BREAK", () => {
    const report = checkFixture("convention.txt");
    assert.equal(rules(report, "CONVENTION-BREAK"), 1);
    const finding = report.findings.find((f) => f.rule === "CONVENTION-BREAK");
    assert.equal(finding?.severity, "low");
    assert.match(finding?.message ?? "", /Add a one-off change/);
    assert.equal(report.findings.length, 1);
  });

  it("a Signed-off-by line without an email shape is TRAILER-MALFORMED", () => {
    const report = checkFixture("malformed.txt");
    assert.equal(rules(report, "TRAILER-MALFORMED"), 1);
    assert.equal(rules(report, "NO-SIGNOFF"), 0);
    const finding = report.findings.find((f) => f.rule === "TRAILER-MALFORMED");
    assert.equal(finding?.severity, "low");
  });

  it("merge commits are reported at info and never above it", () => {
    const report = checkFixture("merge.txt");
    assert.equal(rules(report, "MERGE-COMMIT"), 1);
    const finding = report.findings.find((f) => f.rule === "MERGE-COMMIT");
    assert.equal(finding?.severity, "info");
    assert.equal(rules(report, "CONVENTION-BREAK"), 0);
    assert.equal(report.verdict, "CLEAN");
  });

  it("an empty range is CLEAN", () => {
    const report = checkCommits([], "empty");
    assert.equal(report.verdict, "CLEAN");
    assert.equal(report.counts["commits"], 0);
    assert.equal(report.findings.length, 0);
  });

  it("findings stay in git log order, newest first", () => {
    const report = checkFixture("dco-missing.txt");
    const subjects = parseCommits(fixture("dco-missing.txt")).map((c) => c.shortSha);
    const evidenceOrder = report.findings.map((f) => f.evidence);
    const indices = evidenceOrder.map((e) => subjects.indexOf(e ?? ""));
    assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
  });
});

describe("runCheck and renderReport", () => {
  it("runCheck throws a clear error for a target that is not a git repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "commitcheck-notrepo-"));
    try {
      assert.throws(() => runCheck(dir), /could not read git history/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renderReport names the verdict, the counts, and each rule", () => {
    const report = checkFixture("dco-missing.txt");
    const text = renderReport(report);
    assert.match(text, /commitcheck check dco-missing\.txt: FINDINGS/);
    assert.match(text, /commits: 5, findings: 1/);
    assert.match(text, /NO-SIGNOFF/);
    assert.match(text, /\[MEDIUM\]/);
  });
});
