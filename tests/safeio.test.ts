// Safety fixtures for the shared safe reader, src/safeio.ts (T019; spec US3
// scenarios 1-6, SC-002; research R4, R11; Constitution Principle V).
//
// Every skip fixture asserts the full skip contract at once: readBounded
// resolves null (skip-and-continue — never a thrown error, never an aborted
// request), exactly one newline-terminated diagnostic line —
// `reading-stone: skipping <relPath>: <reason>` — reaches the injected
// stderr sink with the relPath echoed verbatim, and nothing is written to
// stdout (FR-017 reserves stdout for JSON-RPC responses). Reason strings
// are asserted verbatim from src/safeio.ts, so changing a diagnostic is a
// visible, deliberate contract change.
//
// The readBoundedSync suites (T004) assert the same skip contract through
// the synchronous entry point that serves the TypeScript CompilerHost
// `readFile` contract: `undefined` on skip (the absent-file signal, never
// a throw), exactly one diagnostic naming the absolute path verbatim,
// stdout untouched.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_FILE_BYTES, readBounded, readBoundedSync } from "../src/safeio.js";
import {
  createFixtureTree,
  drainCleanups,
  memorySink,
  registerCleanup,
} from "./helpers/fixtures.js";

// Fixture trees and scratch directories register their cleanup with the
// shared helpers so every test body can stay linear; afterEach drains the
// queue in creation order.
afterEach(async () => {
  vi.restoreAllMocks();
  await drainCleanups();
});

async function makeTree(files: Readonly<Record<string, string>>): Promise<string> {
  const tree = await createFixtureTree(files);
  registerCleanup(tree.cleanup);
  return tree.root;
}

async function makeScratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "reading-stone-safeio-"));
  registerCleanup(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// chmod-based inaccessibility is meaningless for root, where mode bits do
// not restrict the owner (same guard as tests/discovery.test.ts).
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

// mkfifo ships with macOS and every Linux CI image; the PATH scan keeps the
// FIFO fixture honest on a platform without it (skipped, never failed).
const mkfifoAvailable = (process.env.PATH ?? "")
  .split(delimiter)
  .some((directory) => existsSync(join(directory, "mkfifo")));

// The shared skip-contract assertion (SC-002): null (skip-and-continue,
// never a throw), exactly one newline-terminated diagnostic naming the
// relPath verbatim, and a stdout that stayed untouched. The default budget
// is large enough to exercise every guard; the budget-split fixture passes
// its own.
async function expectSkip(
  root: string,
  relPath: string,
  reason: string,
  budget = 4096,
): Promise<void> {
  const sink = memorySink();
  const stdout = vi.spyOn(process.stdout, "write");
  await expect(readBounded(root, relPath, budget, sink.stream)).resolves.toBe(null);
  expect(sink.text()).toBe(`reading-stone: skipping ${relPath}: ${reason}\n`);
  expect(stdout).not.toHaveBeenCalled();
}

// The shared non-skip contract: the exact decoded content resolves, no
// diagnostic is written, and stdout stays untouched.
async function expectRead(
  root: string,
  relPath: string,
  budget: number,
  expected: string,
): Promise<void> {
  const sink = memorySink();
  const stdout = vi.spyOn(process.stdout, "write");
  await expect(readBounded(root, relPath, budget, sink.stream)).resolves.toBe(expected);
  expect(sink.text()).toBe("");
  expect(stdout).not.toHaveBeenCalled();
}

// The shared skip-contract assertion for readBoundedSync: undefined (the
// CompilerHost.readFile absent-file signal — never a throw), exactly one
// newline-terminated diagnostic naming the absolute path verbatim, and a
// stdout that stayed untouched.
function expectSkipSync(absPath: string, reason: string): void {
  const sink = memorySink();
  const stdout = vi.spyOn(process.stdout, "write");
  expect(readBoundedSync(absPath, sink.stream)).toBe(undefined);
  expect(sink.text()).toBe(`reading-stone: skipping ${absPath}: ${reason}\n`);
  expect(stdout).not.toHaveBeenCalled();
}

// The shared non-skip contract for readBoundedSync: the exact decoded
// content returns, no diagnostic is written, and stdout stays untouched.
function expectReadSync(absPath: string, expected: string): void {
  const sink = memorySink();
  const stdout = vi.spyOn(process.stdout, "write");
  expect(readBoundedSync(absPath, sink.stream)).toBe(expected);
  expect(sink.text()).toBe("");
  expect(stdout).not.toHaveBeenCalled();
}

describe("readBounded: safety fixtures (spec US3 scenarios 1-6, SC-002)", () => {
  it("skips a file over the 16 MiB cap before it is ever opened", async () => {
    const root = await makeTree({ "big.ts": "", "neighbor.ts": "neighbor" });
    // truncate grows the empty file into a sparse 16 MiB + 1 file instantly.
    await truncate(join(root, "big.ts"), MAX_FILE_BYTES + 1);
    await expectSkip(root, "big.ts", "exceeds 16 MiB size limit");
  });

  // Opening a FIFO for reading blocks until a writer appears; the pre-open
  // regular-file check is the FIFO DoS defense (research R4) — a broken
  // guard here hangs this test rather than passing it.
  it.skipIf(!mkfifoAvailable)(
    "skips a FIFO with one diagnostic instead of blocking on open",
    async () => {
      const root = await makeTree({ "neighbor.ts": "neighbor" });
      execFileSync("mkfifo", [join(root, "pipe.fifo")]);
      await expectSkip(root, "pipe.fifo", "not a regular file");
    },
  );

  it.skipIf(runningAsRoot)(
    "skips a permission-denied file with one diagnostic",
    async () => {
      const root = await makeTree({ "locked.ts": "locked-content" });
      const lockedPath = join(root, "locked.ts");
      await chmod(lockedPath, 0o000);
      try {
        await expectSkip(root, "locked.ts", "unreadable");
      } finally {
        // Restore readability so tree teardown can never be blocked by the
        // mode bits (the fixture helper's force rm also handles chmod 000).
        await chmod(lockedPath, 0o644);
      }
    },
  );

  // A candidate that disappeared between the walk and the read is a skip
  // like any other (US3 scenario 6: any skip condition).
  it("skips a file that vanished before the read (ENOENT)", async () => {
    const root = await makeTree({ "neighbor.ts": "neighbor" });
    await expectSkip(root, "vanished.ts", "unreadable");
  });

  it("skips a symlinked file pointing at a real file inside the tree", async () => {
    const root = await makeTree({ "target.ts": "target-content" });
    await symlink(join(root, "target.ts"), join(root, "inside-link.ts"));
    await expectSkip(root, "inside-link.ts", "symlink");
  });

  // lstat never follows the final path component, so the outside target is
  // never opened and its content never surfaces (SC-002 symlink escape).
  it("skips a symlinked file pointing outside the tree", async () => {
    const scratch = await makeScratchDir();
    const outside = join(scratch, "outside.txt");
    await writeFile(outside, "outside-secret", "utf8");
    const root = await makeTree({ "neighbor.ts": "neighbor" });
    await symlink(outside, join(root, "outside-link.ts"));
    await expectSkip(root, "outside-link.ts", "symlink");
  });

  // The walk never descends into a symlinked directory (research R2);
  // readBounded independently refuses the directory link itself: lstat sees
  // the final component is a symlink and skips it unread.
  it("skips a symlinked directory itself, never following it", async () => {
    const root = await makeTree({ "realdir/inner.ts": "inner-content" });
    await symlink(join(root, "realdir"), join(root, "linkdir"));
    await expectSkip(root, "linkdir", "symlink");
  });

  // readBounded receives a relPath inside the symlinked directory. lstat
  // resolves intermediate components (the kernel follows linkdir) but never
  // follows the final component, so the symlinked file is skipped unread
  // and the outside target is never opened.
  it("skips a symlinked file reached through a symlinked directory", async () => {
    const scratch = await makeScratchDir();
    const outside = join(scratch, "outside.txt");
    await writeFile(outside, "outside-secret", "utf8");
    const root = await makeTree({ "realdir/inner.ts": "inner-content" });
    await symlink(join(root, "realdir"), join(root, "linkdir"));
    await symlink(outside, join(root, "realdir", "escape-link.ts"));
    await expectSkip(root, "linkdir/escape-link.ts", "symlink");
  });

  // The tree is nested inside a scratch parent so <root>/../outside.txt is
  // a real sibling file: the candidate must be rejected unread, not merely
  // absent — containment runs before any filesystem access (FR-018).
  it("rejects a traversal-escape relPath unread", async () => {
    const parent = await makeScratchDir();
    const root = join(parent, "tree");
    await mkdir(root);
    await writeFile(join(root, "inside.ts"), "inside-content", "utf8");
    await writeFile(join(parent, "outside.txt"), "outside-secret", "utf8");
    await expectSkip(root, "../outside.txt", "path escapes root");
  });

  // 0xff is never valid UTF-8; the strict decoder signals the mojibake file
  // instead of silently mangling it (US3 scenario 6: any skip condition).
  it("skips a file with invalid UTF-8 bytes", async () => {
    const root = await makeTree({ "neighbor.ts": "neighbor" });
    await writeFile(join(root, "mojibake.ts"), Buffer.from([0x68, 0xff, 0x69]));
    await expectSkip(root, "mojibake.ts", "decode error");
  });

  // "α" is two bytes in UTF-8; a one-byte budget reads half a character,
  // which is invalid standalone UTF-8 — signaled, not silently dropped.
  it("skips when the budget splits a multi-byte UTF-8 character", async () => {
    const root = await makeTree({ "split.ts": "αβγ" });
    await expectSkip(root, "split.ts", "decode error", 1);
  });
});

describe("readBounded: positive path (the non-skip contract)", () => {
  it("returns the exact content of a normal file with no diagnostics", async () => {
    const root = await makeTree({ "plain.ts": "export const answer = 42;\n" });
    await expectRead(root, "plain.ts", 1024, "export const answer = 42;\n");
  });

  it("returns the budget-clamped prefix of a larger file", async () => {
    const root = await makeTree({ "prefix.ts": "0123456789" });
    await expectRead(root, "prefix.ts", 4, "0123");
  });

  it("returns the whole file when the budget exceeds its size", async () => {
    const root = await makeTree({ "small.ts": "tiny" });
    await expectRead(root, "small.ts", 4096, "tiny");
  });

  it("reads nothing and resolves to the empty string for a zero budget", async () => {
    const root = await makeTree({ "zero.ts": "content" });
    await expectRead(root, "zero.ts", 0, "");
  });

  it("reads a sparse file of exactly MAX_FILE_BYTES without skipping", async () => {
    const root = await makeTree({ "cap.ts": "" });
    await truncate(join(root, "cap.ts"), MAX_FILE_BYTES);
    // The cap rejects sizes strictly greater than MAX_FILE_BYTES, so a file
    // at exactly the cap reads normally; a sparse file is zeros, so the
    // first bytes decode as NUL characters.
    await expectRead(root, "cap.ts", 4, "\x00\x00\x00\x00");
  });
});

describe("readBoundedSync: safety fixtures (the CompilerHost.readFile contract)", () => {
  // Opening a FIFO for reading blocks until a writer appears; the pre-open
  // regular-file check is the FIFO DoS defense (research R4) — a broken
  // guard here hangs this test rather than passing it.
  it.skipIf(!mkfifoAvailable)(
    "skips a FIFO with one diagnostic instead of blocking on open",
    async () => {
      const root = await makeTree({ "neighbor.ts": "neighbor" });
      execFileSync("mkfifo", [join(root, "pipe.fifo")]);
      expectSkipSync(join(root, "pipe.fifo"), "not a regular file");
    },
  );

  it("skips a symlinked file pointing at a real file with one diagnostic", async () => {
    const root = await makeTree({ "target.ts": "target-content" });
    await symlink(join(root, "target.ts"), join(root, "link.ts"));
    expectSkipSync(join(root, "link.ts"), "symlink");
  });

  it("skips a directory as not a regular file", async () => {
    const root = await makeTree({ "realdir/inner.ts": "inner-content" });
    expectSkipSync(join(root, "realdir"), "not a regular file");
  });

  it("skips a file over the 16 MiB cap before it is ever opened", async () => {
    const root = await makeTree({ "big.ts": "" });
    // truncate grows the empty file into a sparse 16 MiB + 1 file instantly.
    await truncate(join(root, "big.ts"), MAX_FILE_BYTES + 1);
    expectSkipSync(join(root, "big.ts"), "exceeds 16 MiB size limit");
  });

  // A candidate that disappeared before the read is a skip like any other.
  it("skips a file that vanished before the read (ENOENT)", async () => {
    const root = await makeTree({ "neighbor.ts": "neighbor" });
    expectSkipSync(join(root, "vanished.ts"), "unreadable");
  });

  it.skipIf(runningAsRoot)(
    "skips a permission-denied file with one diagnostic",
    async () => {
      const root = await makeTree({ "locked.ts": "locked-content" });
      const lockedPath = join(root, "locked.ts");
      await chmod(lockedPath, 0o000);
      try {
        expectSkipSync(lockedPath, "unreadable");
      } finally {
        // Restore readability so tree teardown can never be blocked by the
        // mode bits (the fixture helper's force rm also handles chmod 000).
        await chmod(lockedPath, 0o644);
      }
    },
  );

  // 0xff is never valid UTF-8; the strict decoder signals the mojibake file
  // instead of silently mangling it (Constitution Principle V).
  it("skips a file with invalid UTF-8 bytes", async () => {
    const root = await makeTree({ "neighbor.ts": "neighbor" });
    await writeFile(join(root, "mojibake.ts"), Buffer.from([0x68, 0xff, 0x69]));
    expectSkipSync(join(root, "mojibake.ts"), "decode error");
  });
});

describe("readBoundedSync: positive path (the non-skip contract)", () => {
  it("returns the exact content of a normal file with no diagnostics", async () => {
    const root = await makeTree({ "plain.ts": "export const answer = 42;\n" });
    expectReadSync(join(root, "plain.ts"), "export const answer = 42;\n");
  });

  it("reads an empty file as the empty string with no diagnostics", async () => {
    const root = await makeTree({ "empty.ts": "" });
    expectReadSync(join(root, "empty.ts"), "");
  });
});
