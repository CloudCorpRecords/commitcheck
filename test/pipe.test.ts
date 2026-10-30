/**
 * Pipe regression tests, following the fleet emit contract
 * (FACTORY-NOTES.md). Node stdout attached to a pipe is asynchronous:
 * console.log followed by process.exit discards whatever the pipe has
 * not drained, truncating at one 64 KiB pipe buffer while the exit
 * code still reports success. These tests spawn the real CLI with
 * piped stdio and push a report past 200 KiB through the pipe.
 *
 * The report comes from a real git repo generated in setup: 600
 * --allow-empty commits, most with overlong conventional subjects and
 * valid sign-offs, every tenth one a style-breaking unsigned commit
 * with a malformed trailer, so the JSON carries hundreds of findings.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execFileSync } from "node:child_process";
import { runCheck, renderReport } from "../src/core.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const COMMIT_COUNT = 600;
const SIGN = "Signed-off-by: Jane Dev <jane@example.com>";

let gitAvailable = true;
try {
  execFileSync("git", ["--version"], { stdio: "pipe" });
} catch {
  gitAvailable = false;
}

const skipOpts = gitAvailable ? {} : { skip: "git is not available" };

let dir = "";
if (gitAvailable) {
  dir = mkdtempSync(join(tmpdir(), "commitcheck-pipe-"));
  const git = (args: string[]): void => {
    execFileSync("git", ["-C", dir, ...args], { stdio: "pipe" });
  };
  git(["init", "-q"]);
  git(["config", "user.email", "pipe@example.com"]);
  git(["config", "user.name", "Pipe Test"]);
  git(["config", "commit.gpgsign", "false"]);
  for (let i = 0; i < COMMIT_COUNT; i++) {
    if (i % 10 === 9) {
      // Style breaker: capitalized, overlong, unsigned, malformed trailer.
      git(["commit", "-q", "--allow-empty", "-m", `Break style ${i} ${"y".repeat(5000)}`, "-m", "Signed-off-by: No Email Here"]);
    } else {
      // The subject itself is the bulk: checkCommits quotes the full
      // subject in the overlong finding, so 5000 char subjects carry
      // the report past 200 KiB inside the 50 commit window.
      git(["commit", "-q", "--allow-empty", "-m", `feat: change number ${i} ${"x".repeat(5000)}`, "-m", SIGN]);
    }
  }
}

after(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

interface CliResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], opts: { destroyStdoutOnFirstChunk?: boolean } = {}): Promise<CliResult> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, ["--import", "tsx", "src/cli.ts", ...args], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error("CLI timed out"));
    }, 90000);
    if (opts.destroyStdoutOnFirstChunk) {
      child.stdout.destroy();
    }
    child.stdout.on("data", (c: Buffer) => {
      out += c.toString("utf8");
      if (opts.destroyStdoutOnFirstChunk) child.stdout.destroy();
    });
    child.stderr.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      rejectPromise(e);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout: out, stderr: err });
    });
  });
}

describe("emit contract: piped output is delivered whole", () => {
  it("the generated repo only exposes the last 50 commits, all with findings", { ...skipOpts, timeout: 120000 }, () => {
    const direct = runCheck(dir);
    assert.equal(direct.counts["commits"], 50);
    assert.ok((direct.counts["findings"] ?? 0) >= 50, "every commit in range should carry at least the overlong finding");
    assert.equal(direct.verdict, "FINDINGS");
  });

  it("piped --json over 200 KiB parses and matches the in-process report", { ...skipOpts, timeout: 120000 }, async () => {
    const direct = runCheck(dir);
    const directJson = JSON.stringify(direct, null, 2);
    assert.ok(directJson.length > 200_000, `fixture must exceed 200 KiB of JSON, got ${directJson.length}`);
    const res = await runCli(["check", dir, "--json"]);
    assert.equal(res.code, 1, `expected exit 1 (FINDINGS), got ${res.code} (stderr: ${res.stderr.slice(0, 200)})`);
    assert.equal(res.stdout.length, directJson.length + 1, "piped bytes must equal the full report plus the trailing newline");
    const parsed = JSON.parse(res.stdout) as { counts: Record<string, number>; verdict: string };
    assert.equal(parsed.counts["findings"], direct.counts["findings"]);
    assert.equal(parsed.verdict, direct.verdict);
  });

  it("piped human output is byte-identical to the in-process render", { ...skipOpts, timeout: 120000 }, async () => {
    const expected = renderReport(runCheck(dir)) + "\n";
    assert.ok(expected.length > 65_536, `human fixture must exceed one pipe buffer, got ${expected.length}`);
    const res = await runCli(["check", dir]);
    assert.equal(res.code, 1);
    assert.equal(res.stdout, expected);
  });

  it("a reader that closes the pipe early never sees a success exit", { ...skipOpts, timeout: 120000 }, async () => {
    const res = await runCli(["check", dir, "--json"], { destroyStdoutOnFirstChunk: true });
    assert.notEqual(res.code, 0, "exit 0 would report success for output that was never delivered");
    assert.ok(res.signal === "SIGPIPE" || res.code === 141, `expected SIGPIPE or exit 141, got code ${res.code} signal ${res.signal}`);
  });
});
