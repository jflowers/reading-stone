import type { Stats } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type { Writable } from "node:stream";
import { TextDecoder } from "node:util";

/**
 * Shared safe file reader for every file-touching analysis (FR-017, FR-018;
 * research R4, R5 — Constitution Principle V).
 *
 * Analyzed trees are untrusted input, so no caller reads files under its own
 * discipline: all reading funnels through `readBounded`, one guarded
 * sequence whose order is load-bearing:
 *
 * 1. **Containment** (FR-018, research R5) runs before any filesystem
 *    access — the candidate is the resolved root joined with the walk-built
 *    relative path, and `path.relative(root, candidate)` must stay
 *    non-absolute and must not begin with `..`, or the path is rejected
 *    unread. The walk can never produce an escape (walked segments contain
 *    no `..` and symlinks are never followed); the independent check is
 *    defense in depth protecting future callers that receive paths from
 *    other sources (research R5).
 * 2. **`lstat` — never `stat`** so the final symlink is not followed: a
 *    symlink is skipped as itself, and non-regular files (FIFOs, devices,
 *    sockets) are skipped before `open` is attempted. The pre-open
 *    regular-file check is the FIFO DoS defense — opening a FIFO for
 *    reading blocks until a writer appears (research R4).
 * 3. **Size cap**: the lstat size is checked against `MAX_FILE_BYTES`
 *    before open, so an oversized file is never opened at all.
 * 4. **Bounded read**: only then does the file open, and the read length is
 *    clamped by the caller's `budget`.
 *
 * Every skip writes exactly one diagnostic line — `reading-stone: skipping
 * <relPath>: <reason>` — to the injected stderr sink and resolves `null`;
 * a skip never throws and never aborts the enclosing request, and stdout is
 * never touched (it is reserved for JSON-RPC responses, FR-017). Reason
 * strings are short and stable, so stderr output is deterministic for the
 * same tree (Constitution Principle I).
 */

/**
 * The hard per-file byte cap (FR-017): a candidate whose lstat size exceeds
 * 16 MiB is skipped before it is ever opened. Fixed, not
 * caller-configurable — the bound mirrors the reference analyzer's
 * `MAX_FILE_BYTES` and the server's `MAX_LINE_CHARS` precedent; no single
 * file may dominate the analyzer's memory.
 */
export const MAX_FILE_BYTES = 16 * 1024 * 1024;

/**
 * Strict UTF-8 decoder shared by every read. `fatal: true` turns invalid
 * byte sequences into a thrown `TypeError`, which `readBounded` maps to a
 * `decode error` skip — never the silent U+FFFD replacement that
 * `Buffer.prototype.toString` would apply (a mojibake source file must be
 * signaled, not silently mangled). One-shot `decode()` calls carry no state
 * between invocations, so a single shared instance is safe. A leading UTF-8
 * BOM is consumed (stripped from the decoded string), which the
 * generated-marker scanner relies on (research R6).
 */
const UTF_8_DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * Reads at most `budget` bytes of one candidate file beneath the analysis
 * root, running the full safe-read sequence (FR-017, FR-018; research R4,
 * R5): containment, `lstat`, regular-file check, size cap, open,
 * budget-clamped read, strict UTF-8 decode.
 *
 * The caller (the tree walk, or a later analysis method) supplies paths
 * relative to a resolved root; `readBounded` never reads a path that
 * escapes it. `MAX_FILE_BYTES` is the hard cap on the lstat size; `budget`
 * additionally clamps how many bytes are actually read (a 64 KiB marker
 * prefix, a whole-file 16 MiB read). A non-positive budget reads nothing
 * and resolves to the empty string. A budget that splits a multi-byte
 * UTF-8 sequence yields a `decode error` skip — the truncated prefix is
 * not valid standalone UTF-8, and signaling the loss beats silently
 * dropping the partial character.
 *
 * Every skip resolves `null` after writing exactly one diagnostic line to
 * `stderr`; `readBounded` never throws for skip conditions and never aborts
 * the enclosing request (FR-017).
 *
 * @param root Resolved absolute analysis root; containment is enforced
 * against this root (the caller resolves a symlinked root once at the
 * boundary, before walking).
 * @param relPath Walk-built root-relative POSIX path, echoed verbatim in
 * diagnostics.
 * @param budget Maximum number of bytes to read from the file.
 * @param stderr Injected diagnostic sink (Testability principle — the
 * Server passes its own `stderr`); stdout is never touched.
 * @returns The decoded file content, or `null` when the file was skipped.
 */
export async function readBounded(
  root: string,
  relPath: string,
  budget: number,
  stderr: Writable,
): Promise<string | null> {
  const skip = (reason: string): null => {
    stderr.write(`reading-stone: skipping ${relPath}: ${reason}\n`);
    return null;
  };

  // (1) Containment (FR-018, research R5) — before any filesystem access.
  // The "begins with `..`" test is deliberately literal: as defense in
  // depth it errs toward rejecting, so even a pathological in-root sibling
  // such as `..hidden.ts` is refused unread rather than risk an escape.
  const candidate = join(root, relPath);
  const relativeToRoot = relative(root, candidate);
  if (isAbsolute(relativeToRoot) || relativeToRoot.startsWith("..")) {
    return skip("path escapes root");
  }

  // (2) lstat — never stat, so the final symlink is not followed. A file
  // that vanished between the walk and this read (ENOENT), or that cannot
  // be stat'd (EACCES on a parent directory), is a skip like any other.
  let stats: Stats;
  try {
    stats = await lstat(candidate);
  } catch {
    return skip("unreadable");
  }
  if (stats.isSymbolicLink()) {
    return skip("symlink");
  }
  if (!stats.isFile()) {
    return skip("not a regular file");
  }

  // (3) Size cap (FR-017) — from the lstat result, before open: an
  // oversized file is never opened.
  if (stats.size > MAX_FILE_BYTES) {
    return skip("exceeds 16 MiB size limit");
  }

  // The read length is clamped by both the caller's budget and the lstat
  // size (itself capped at MAX_FILE_BYTES), so the buffer allocation is
  // bounded by the smaller of the two; a non-positive budget or size
  // reads nothing.
  const readLength = Math.max(0, Math.min(budget, stats.size));

  // (4) Open + bounded read. Any filesystem failure here — including the
  // permission-denied open of a chmod-000 file — is the same skip.
  let bytes: Buffer;
  try {
    bytes = await readPrefix(candidate, readLength);
  } catch {
    return skip("unreadable");
  }

  try {
    return UTF_8_DECODER.decode(bytes);
  } catch {
    return skip("decode error");
  }
}

/**
 * Opens `candidate` and reads at most `readLength` bytes from its start
 * into a fresh `Buffer`, closing the handle before resolving.
 *
 * The read loop advances by explicit position and stops at EOF, so a file
 * that changed size after its lstat is still read deterministically:
 * exactly the bytes present, never more than `readLength`.
 *
 * @param candidate Absolute candidate path already proven contained and
 * within the size cap by `readBounded`'s guards.
 * @param readLength Maximum number of bytes to read; never negative.
 * @returns The bytes actually read (a view of length at most `readLength`).
 */
async function readPrefix(candidate: string, readLength: number): Promise<Buffer> {
  // TOCTOU residual (research R4, spec US3): between readBounded's lstat
  // and this open, the path can be swapped — regular file to FIFO,
  // truncated, or removed. The accepted mitigation is this open in "r"
  // mode plus the guarded read below: if a swap made the target blocking
  // or non-regular, the open or the read errors and flows through the
  // same skip path rather than hanging the request. The pre-open lstat
  // remains the actual FIFO DoS defense; the TOCTOU-free alternative
  // (open + fstat on the handle) was rejected because the open itself
  // blocks on a FIFO before fstat can run, and O_NONBLOCK is not portable
  // through Node's open flags (research R4).
  const handle = await open(candidate, "r");
  try {
    const buffer = Buffer.alloc(readLength);
    let bytesRead = 0;
    while (bytesRead < readLength) {
      const { bytesRead: chunkBytes } = await handle.read(
        buffer,
        bytesRead,
        readLength - bytesRead,
        bytesRead,
      );
      if (chunkBytes === 0) {
        break; // EOF before readLength: the file shrank since lstat.
      }
      bytesRead += chunkBytes;
    }
    return buffer.subarray(0, bytesRead);
  } finally {
    try {
      await handle.close();
    } catch {
      // A close failure after the bytes were read does not invalidate
      // them; swallowing it keeps this helper's failure surface limited
      // to the open and the read (both mapped to skips by the caller).
    }
  }
}
