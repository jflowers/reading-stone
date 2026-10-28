import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Writable } from "node:stream";

export interface FixtureTree {
  root: string;
  cleanup: () => Promise<void>;
}

export async function createFixtureTree(
  files: Readonly<Record<string, string>>,
): Promise<FixtureTree> {
  const root = await mkdtemp(join(tmpdir(), "reading-stone-"));
  await Promise.all(
    Object.entries(files).map(async ([relPath, contents]) => {
      const target = join(root, relPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, contents, "utf8");
    }),
  );
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/**
 * In-memory stand-in for the Server's stderr diagnostics channel (the
 * established sink pattern, formerly copied per-file — consolidated here
 * by the review council's test-conventions finding, dispatch 44e85014):
 * collects exactly what the code under test writes, so suites can assert
 * the diagnostics contract precisely. A fresh sink per call makes the
 * first write observable as soon as the caller resolves.
 */
export function memorySink(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    decodeStrings: false,
    write(
      chunk: string | Uint8Array,
      _encoding: string,
      callback: (error?: Error | null) => void,
    ): void {
      const decoded =
        typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      chunks.push(decoded);
      callback();
    },
  });
  return { stream, text: () => chunks.join("") };
}

// The per-file cleanup queue: fixture trees and scratch directories
// register their cleanup here so every test body stays linear; the file's
// afterEach drains the queue in creation order. Module state is safe to
// share this way because vitest isolates each test file's module graph.
const pendingCleanups: Array<() => Promise<void>> = [];

/** Registers one cleanup to run at the file's next afterEach drain. */
export function registerCleanup(cleanup: () => Promise<void>): void {
  pendingCleanups.push(cleanup);
}

/** Drains the cleanup queue in creation order; call from afterEach. */
export async function drainCleanups(): Promise<void> {
  const cleanups = pendingCleanups.splice(0, pendingCleanups.length);
  for (const cleanup of cleanups) {
    await cleanup();
  }
}
