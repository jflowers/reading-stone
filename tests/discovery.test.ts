import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { discover, InvalidRootPathError } from "../src/discovery.js";
import { serialize } from "../src/protocol.js";
import { createFixtureTree } from "./helpers/fixtures.js";

// Fixture trees and scratch directories register their cleanup here so every
// test body can stay linear; afterEach drains the queue in creation order.
const pendingCleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  // The US4 diagnostic cases spy on process.stdout (the sink + stdout-spy
  // pattern from tests/safeio.test.ts); restoring here keeps every case
  // independent and is a no-op for the spy-free cases.
  vi.restoreAllMocks();
  const cleanups = pendingCleanups.splice(0, pendingCleanups.length);
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

async function makeTree(files: Readonly<Record<string, string>>): Promise<string> {
  const tree = await createFixtureTree(files);
  pendingCleanups.push(tree.cleanup);
  return tree.root;
}

async function makeScratchDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "reading-stone-scratch-"));
  pendingCleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// chmod-based inaccessibility is meaningless for root, where mode bits do not
// restrict the owner.
const runningAsRoot = typeof process.getuid === "function" && process.getuid() === 0;

// mkfifo ships with macOS and every Linux CI image; the PATH scan keeps the
// FIFO fixture honest on a platform without it (skipped, never failed).
const mkfifoAvailable = (process.env.PATH ?? "")
  .split(delimiter)
  .some((directory) => existsSync(join(directory, "mkfifo")));

// In-memory stand-in for the Server's stderr (the established sink pattern
// from tests/safeio.test.ts): collects exactly what discover writes so the
// US4 cases can assert the one-line diagnostic contract precisely. A fresh
// sink per call makes the write observable as soon as discover resolves.
function memorySink(): { stream: Writable; text: () => string } {
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

// The discover-level skip contract (FR-017 through T024's stderr wiring):
// the whole sink text is exactly one newline-terminated
// `reading-stone: skipping <relPath>: <reason>` line. The reason string is
// owned by the not-yet-landed T022/T024 implementations, so only its
// presence is asserted here — tests/safeio.test.ts pins readBounded's own
// reasons verbatim instead.
function expectOneSkipLine(sinkText: string, relPath: string): void {
  const prefix = `reading-stone: skipping ${relPath}: `;
  expect(sinkText.endsWith("\n")).toBe(true);
  const line = sinkText.slice(0, -1);
  // Exactly one line: no embedded newline before the terminator.
  expect(line.includes("\n")).toBe(false);
  expect(line.startsWith(prefix)).toBe(true);
  // The reason is non-empty.
  expect(line.length).toBeGreaterThan(prefix.length);
}

describe("discover: canonical tree", () => {
  it("returns the exact sorted, disjoint lists for a tree with all six extensions", async () => {
    const root = await makeTree({
      "src/app.ts": "",
      "src/widget.tsx": "",
      "src/legacy.js": "",
      "src/component.jsx": "",
      "tools/cli.mjs": "",
      "config/rollup.cjs": "",
      "src/app.test.ts": "",
      // A non-walked extension: collected by neither list (FR-002).
      "README.md": "",
    });
    const result = await discover(root);
    expect(result).toEqual({
      source_files: [
        "config/rollup.cjs",
        "src/app.ts",
        "src/component.jsx",
        "src/legacy.js",
        "src/widget.tsx",
        "tools/cli.mjs",
      ],
      test_files: ["src/app.test.ts"],
      framework: "unknown",
    });
    // Both lists are sorted with the default (UTF-16 code-unit) comparator.
    expect([...result.source_files]).toEqual([...result.source_files].sort());
    expect([...result.test_files]).toEqual([...result.test_files].sort());
    // Paths are root-relative and use POSIX separators.
    for (const file of [...result.source_files, ...result.test_files]) {
      expect(file.startsWith("/")).toBe(false);
      expect(file.includes("\\")).toBe(false);
    }
    // The two lists are disjoint.
    const overlap = result.source_files.filter((file) =>
      result.test_files.includes(file),
    );
    expect(overlap).toEqual([]);
  });
});

describe("discover: pruned directories", () => {
  it("walks dot-directories while pruning the five excluded directories at any depth", async () => {
    const root = await makeTree({
      "node_modules/dep/index.ts": "",
      "packages/app/node_modules/dep/index.ts": "",
      "dist/bundle.js": "",
      "build/out.js": "",
      "coverage/report.ts": "",
      ".git/hooks/post-checkout.ts": "",
      ".github/labeler.ts": "",
      "src/main.ts": "",
    });
    const result = await discover(root);
    expect(result.source_files).toEqual([".github/labeler.ts", "src/main.ts"]);
    expect(result.test_files).toEqual([]);
  });
});

describe("discover: declaration files", () => {
  it("excludes .d.ts files from both lists", async () => {
    const root = await makeTree({
      "src/types.d.ts": "",
      "src/global.d.ts": "",
      "__tests__/fixtures.d.ts": "",
      "src/keep.ts": "",
    });
    const result = await discover(root);
    expect(result.source_files).toEqual(["src/keep.ts"]);
    expect(result.test_files).toEqual([]);
  });
});

describe("discover: test classification", () => {
  it("classifies *.test.* and *.spec.* basenames as test files", async () => {
    const root = await makeTree({
      "src/app.test.ts": "",
      "src/widget.spec.tsx": "",
      "integration.spec.mjs": "",
      "deep/nested/unit.test.cjs": "",
      "src/utils.test.ts": "",
      "src/utils.ts": "",
    });
    const result = await discover(root);
    expect(result.source_files).toEqual(["src/utils.ts"]);
    expect(result.test_files).toEqual([
      "deep/nested/unit.test.cjs",
      "integration.spec.mjs",
      "src/app.test.ts",
      "src/utils.test.ts",
      "src/widget.spec.tsx",
    ]);
  });

  it("does not treat first-segment or substring test/spec names as test signals", async () => {
    const root = await makeTree({
      "test.ts": "",
      "spec.js": "",
      "test.helper.ts": "",
      "helper.teststep.ts": "",
    });
    const result = await discover(root);
    expect(result.source_files).toEqual([
      "helper.teststep.ts",
      "spec.js",
      "test.helper.ts",
      "test.ts",
    ]);
    expect(result.test_files).toEqual([]);
  });

  it("classifies files under __tests__, tests, and test directories as test files", async () => {
    const root = await makeTree({
      "__tests__/parser.ts": "",
      "tests/helper.ts": "",
      "test/runner.ts": "",
      "src/__tests__/deep/util.ts": "",
      "src/parser.ts": "",
    });
    const result = await discover(root);
    expect(result.source_files).toEqual(["src/parser.ts"]);
    expect(result.test_files).toEqual([
      "__tests__/parser.ts",
      "src/__tests__/deep/util.ts",
      "test/runner.ts",
      "tests/helper.ts",
    ]);
  });

  it("requires exact directory-name matches for the test-directory signal", async () => {
    const root = await makeTree({
      "mytests/thing.ts": "",
      "testUtils/thing.ts": "",
      "tests.ts": "",
    });
    const result = await discover(root);
    expect(result.source_files).toEqual([
      "mytests/thing.ts",
      "testUtils/thing.ts",
      "tests.ts",
    ]);
    expect(result.test_files).toEqual([]);
  });

  it("lets any test signal win over source classification", async () => {
    const root = await makeTree({
      "src/app.ts": "",
      "src/widget.test.ts": "",
      "tests/adapter.ts": "",
      "__tests__/combined.spec.ts": "",
    });
    const result = await discover(root);
    expect(result.source_files).toEqual(["src/app.ts"]);
    expect(result.test_files).toEqual([
      "__tests__/combined.spec.ts",
      "src/widget.test.ts",
      "tests/adapter.ts",
    ]);
  });
});

describe("discover: filename fidelity", () => {
  it("preserves non-ASCII filenames verbatim", async () => {
    const root = await makeTree({
      "src/αβγ.ts": "",
      "src/日本語.ts": "",
      "方程式/solver.ts": "",
    });
    const result = await discover(root);
    expect(result.source_files).toEqual([
      "src/αβγ.ts",
      "src/日本語.ts",
      "方程式/solver.ts",
    ]);
    expect(result.test_files).toEqual([]);
  });

  it("keeps case-distinct names as distinct entries", async (context) => {
    const root = await makeTree({
      "src/Readme.ts": "",
      "src/readme.ts": "",
    });
    // A case-insensitive filesystem (default macOS APFS) collapses the pair
    // into a single directory entry, so the scenario is unrepresentable
    // there; case-sensitive filesystems (Linux CI) exercise the assertion.
    if ((await readdir(join(root, "src"))).length !== 2) {
      context.skip();
    }
    const result = await discover(root);
    expect(result.source_files).toEqual(["src/Readme.ts", "src/readme.ts"]);
    expect(result.test_files).toEqual([]);
  });
});

describe("discover: configuration files", () => {
  it("classifies a root vitest.config.ts as a source file without special casing", async () => {
    const root = await makeTree({
      "vitest.config.ts": "",
      "src/app.ts": "",
    });
    const result = await discover(root);
    expect(result.source_files).toEqual(["src/app.ts", "vitest.config.ts"]);
    expect(result.test_files).toEqual([]);
  });
});

describe("discover: empty tree and determinism", () => {
  it("returns empty lists and the unknown framework for an empty tree", async () => {
    const root = await makeTree({});
    await expect(discover(root)).resolves.toEqual({
      source_files: [],
      test_files: [],
      framework: "unknown",
    });
  });

  it("serializes two discover() calls on the same tree to identical bytes", async () => {
    const root = await makeTree({
      "src/app.ts": "",
      "src/app.test.ts": "",
      "tests/helper.ts": "",
      "src/日本語.ts": "",
    });
    const first = await discover(root);
    const second = await discover(root);
    expect(serialize(second)).toBe(serialize(first));
  });
});

describe("discover: root path resolution", () => {
  it("resolves a symlinked root_path once and still reports the tree's files", async () => {
    const root = await makeTree({
      "src/main.ts": "",
      "src/main.test.ts": "",
    });
    const scratch = await makeScratchDir();
    const link = join(scratch, "linked-root");
    await symlink(root, link);
    const viaLink = await discover(link);
    expect(viaLink.source_files).toEqual(["src/main.ts"]);
    expect(viaLink.test_files).toEqual(["src/main.test.ts"]);
    const direct = await discover(root);
    expect(viaLink).toEqual(direct);
  });

  it("rejects a nonexistent root with InvalidRootPathError", async () => {
    const scratch = await makeScratchDir();
    const missing = join(scratch, "does-not-exist");
    await expect(discover(missing)).rejects.toBeInstanceOf(InvalidRootPathError);
    await expect(discover(missing)).rejects.toMatchObject({
      rootPath: resolve(missing),
    });
    await expect(discover(missing)).rejects.toThrow("root_path is not a directory:");
  });

  it("rejects a file used as the root with InvalidRootPathError", async () => {
    const root = await makeTree({ "not-a-directory.ts": "" });
    const fileAsRoot = join(root, "not-a-directory.ts");
    await expect(discover(fileAsRoot)).rejects.toBeInstanceOf(InvalidRootPathError);
    await expect(discover(fileAsRoot)).rejects.toMatchObject({
      rootPath: resolve(fileAsRoot),
    });
  });

  // The root is made inaccessible through an unsearchable parent directory:
  // realpath/stat on the root itself succeed even at mode 000 (only readdir
  // would fail), so the locked parent is what drives validation to EACCES.
  it.skipIf(runningAsRoot)(
    "rejects an inaccessible root with InvalidRootPathError",
    async () => {
      const scratch = await makeScratchDir();
      const locked = join(scratch, "locked");
      const project = join(locked, "project");
      await mkdir(project, { recursive: true });
      await chmod(locked, 0o000);
      try {
        await expect(discover(project)).rejects.toBeInstanceOf(InvalidRootPathError);
        await expect(discover(project)).rejects.toMatchObject({
          rootPath: resolve(project),
        });
      } finally {
        await chmod(locked, 0o700);
      }
    },
  );

  // process.chdir affects the whole worker process; the cwd is restored in a
  // finally so the window is exactly one discover() call.
  it("resolves a relative root_path against process.cwd()", async () => {
    const root = await makeTree({ "app.ts": "" });
    const expected = await discover(root);
    const previousCwd = process.cwd();
    process.chdir(root);
    try {
      await expect(discover(".")).resolves.toEqual(expected);
    } finally {
      process.chdir(previousCwd);
    }
  });
});

// ---------------------------------------------------------------------------
// US4 (T021) — framework detection (FR-006), generated-file markers
// (FR-007), and the discover-level safety-sink wiring (FR-017), written
// RED-FIRST: T022 (detectFramework), T023 (marker scanner), and T024
// (discover wiring + stderr sink) have not landed yet, so the
// config-presence, marker-exclusion, and diagnostic cases below are
// EXPECTED TO FAIL until they do — observed red now, green when US4 lands.
// The non-exclusion cases (case variants, trailing comments, string
// literals) already pass and must stay green. Calls of the form
// discover(root, sink) pass the T024 target-API stderr argument (a
// Writable); at runtime today the extra argument is ignored, which is
// exactly what keeps the diagnostic cases red.
// ---------------------------------------------------------------------------

describe("discover: framework detection", () => {
  // Config presence at the resolved root only (FR-006, research R7): the
  // files' contents are irrelevant, so every config fixture is empty.
  it('reports "vitest" for a root vitest.config.ts', async () => {
    const root = await makeTree({ "vitest.config.ts": "", "src/app.ts": "" });
    const result = await discover(root);
    expect(result.framework).toBe("vitest");
  });

  it('reports "vitest" for an alternate form (vitest.config.mjs)', async () => {
    const root = await makeTree({ "vitest.config.mjs": "", "src/app.ts": "" });
    const result = await discover(root);
    expect(result.framework).toBe("vitest");
  });

  it('reports "jest" for a root jest.config.js', async () => {
    const root = await makeTree({ "jest.config.js": "", "src/app.ts": "" });
    const result = await discover(root);
    expect(result.framework).toBe("jest");
  });

  it('reports "jest" for a root jest.config.json', async () => {
    const root = await makeTree({ "jest.config.json": "", "src/app.ts": "" });
    const result = await discover(root);
    expect(result.framework).toBe("jest");
  });

  it('reports "vitest" when both vitest and jest configs are present', async () => {
    const root = await makeTree({
      "vitest.config.ts": "",
      "jest.config.js": "",
      "src/app.ts": "",
    });
    const result = await discover(root);
    expect(result.framework).toBe("vitest");
  });

  it('reports "unknown" for a valid package.json without a jest key', async () => {
    const root = await makeTree({
      "package.json": '{"name": "fixture", "private": true}',
      "src/app.ts": "",
    });
    const result = await discover(root);
    expect(result.framework).toBe("unknown");
  });

  it('reports "jest" for a package.json jest key with no jest.config.*', async () => {
    const root = await makeTree({
      "package.json": '{"jest": {"testMatch": []}}',
      "src/app.ts": "",
    });
    const result = await discover(root);
    expect(result.framework).toBe("jest");
  });

  it("treats a malformed package.json as having no jest key", async () => {
    // Truncated JSON that visibly carries a jest key no parser can reach:
    // the apparent key must not be honored (research R7), and the parse
    // failure is a skip — one diagnostic, request completes (FR-017).
    const root = await makeTree({
      "package.json": '{"jest": {"testMatch": []}',
      "src/app.ts": "",
    });
    const sink = memorySink();
    const stdout = vi.spyOn(process.stdout, "write");
    const result = await discover(root, sink.stream);
    expect(result.framework).toBe("unknown");
    expect(result.source_files).toEqual(["src/app.ts"]);
    expectOneSkipLine(sink.text(), "package.json");
    expect(stdout).not.toHaveBeenCalled();
  });

  it.skipIf(runningAsRoot)(
    "treats an unreadable package.json as having no jest key",
    async () => {
      const root = await makeTree({
        // A real jest key that mode 0o000 makes unreachable — the strongest
        // form of "treated as having no jest key" (research R7).
        "package.json": '{"jest": {"testMatch": []}}',
        "src/app.ts": "",
      });
      const lockedPath = join(root, "package.json");
      await chmod(lockedPath, 0o000);
      try {
        const sink = memorySink();
        const stdout = vi.spyOn(process.stdout, "write");
        const result = await discover(root, sink.stream);
        expect(result.framework).toBe("unknown");
        expect(result.source_files).toEqual(["src/app.ts"]);
        expectOneSkipLine(sink.text(), "package.json");
        expect(stdout).not.toHaveBeenCalled();
      } finally {
        // Restore readability so tree teardown can never be blocked by the
        // mode bits (same belt-and-braces as tests/safeio.test.ts).
        await chmod(lockedPath, 0o644);
      }
    },
  );

  it("reports an identical framework across repeated runs", async () => {
    const root = await makeTree({
      "vitest.config.ts": "",
      "jest.config.js": "",
      "src/app.ts": "",
    });
    const first = await discover(root);
    const second = await discover(root);
    // US4 scenario 3: detection depends only on configuration presence, so
    // repeated analyses of the same tree agree.
    expect(second.framework).toBe(first.framework);
    expect(first.framework).toBe("vitest");
  });
});

describe("discover: generated-file markers", () => {
  // FR-007: exclusion is a silent documented policy (like `.d.ts`), never a
  // safety-skip diagnostic — every exclusion case proves both lists AND a
  // silent sink.
  it("excludes a leading @generated line comment from both lists, silently", async () => {
    const root = await makeTree({
      "src/generated.ts": "// @generated\nexport const value = 1;\n",
      "src/handwritten.ts": "export const other = 2;\n",
    });
    const sink = memorySink();
    const result = await discover(root, sink.stream);
    expect(result.source_files).toEqual(["src/handwritten.ts"]);
    expect(result.test_files).toEqual([]);
    expect(sink.text()).toBe("");
  });

  it("excludes a Code generated marker stacked under a license header", async () => {
    const root = await makeTree({
      "src/protobuf.ts": `// Copyright Fixture Corp.
// Code generated by protoc. DO NOT EDIT!

export const x = 1;
`,
      "src/handwritten.ts": "export const other = 2;\n",
    });
    const sink = memorySink();
    const result = await discover(root, sink.stream);
    expect(result.source_files).toEqual(["src/handwritten.ts"]);
    expect(result.test_files).toEqual([]);
    expect(sink.text()).toBe("");
  });

  it("does not match case-variant markers (@Generated, code generated)", async () => {
    const root = await makeTree({
      "src/capitalized.ts": "// @Generated by scaffolder\nexport const a = 1;\n",
      "src/lowercase.ts": "// code generated by scaffolder\nexport const b = 2;\n",
    });
    const result = await discover(root);
    expect(result.source_files).toEqual(["src/capitalized.ts", "src/lowercase.ts"]);
    expect(result.test_files).toEqual([]);
  });

  it("keeps a file whose marker text appears only after code begins", async () => {
    const root = await makeTree({
      "src/trailing.ts": "export const value = 1;\n// Code generated by tool.\n",
      "src/handwritten.ts": "export const other = 2;\n",
    });
    const result = await discover(root);
    expect(result.source_files).toEqual(["src/handwritten.ts", "src/trailing.ts"]);
    expect(result.test_files).toEqual([]);
  });

  it("keeps a file whose marker text sits inside a string literal", async () => {
    // The marker is the first code in the file, inside a string: a scanner
    // that stops at the first non-comment content never sees it (research
    // R6 rejects the regex-over-raw-prefix alternative for exactly this).
    const root = await makeTree({
      "src/banner.ts": 'export const banner = "@generated";\n',
      "src/handwritten.ts": "export const other = 2;\n",
    });
    const result = await discover(root);
    expect(result.source_files).toEqual(["src/banner.ts", "src/handwritten.ts"]);
    expect(result.test_files).toEqual([]);
  });

  it("excludes a test-named file carrying a leading marker from both lists", async () => {
    const root = await makeTree({
      "src/foo.test.ts": "// @generated\nexport const sample = 1;\n",
      "tests/real.test.ts": "export const real = 1;\n",
    });
    const sink = memorySink();
    const result = await discover(root, sink.stream);
    // Precedence: generated exclusion wins over test classification (spec
    // edge case — the file appears in neither list).
    expect(result.source_files).toEqual([]);
    expect(result.test_files).toEqual(["tests/real.test.ts"]);
    expect(sink.text()).toBe("");
  });

  it("still excludes a marker behind a UTF-8 BOM", async () => {
    const root = await makeTree({
      // The fixture helper's utf8 write encodes the U+FEFF prefix as the
      // EF BB BF byte sequence — a real BOM in the file bytes, not just in
      // the string.
      "src/bom.ts": "\u{FEFF}// @generated\nexport const value = 1;\n",
      "src/handwritten.ts": "export const other = 2;\n",
    });
    const sink = memorySink();
    const result = await discover(root, sink.stream);
    expect(result.source_files).toEqual(["src/handwritten.ts"]);
    expect(result.test_files).toEqual([]);
    expect(sink.text()).toBe("");
  });

  it("still excludes a marker behind a leading shebang line", async () => {
    const root = await makeTree({
      "src/cli.ts": "#!/usr/bin/env node\n// @generated\nexport const value = 1;\n",
      "src/handwritten.ts": "export const other = 2;\n",
    });
    const sink = memorySink();
    const result = await discover(root, sink.stream);
    expect(result.source_files).toEqual(["src/handwritten.ts"]);
    expect(result.test_files).toEqual([]);
    expect(sink.text()).toBe("");
  });

  it("excludes a marker inside a leading block comment", async () => {
    const root = await makeTree({
      "src/schema.ts": "/*\n * @generated\n */\nexport const value = 1;\n",
      "src/handwritten.ts": "export const other = 2;\n",
    });
    const sink = memorySink();
    const result = await discover(root, sink.stream);
    expect(result.source_files).toEqual(["src/handwritten.ts"]);
    expect(result.test_files).toEqual([]);
    expect(sink.text()).toBe("");
  });
});

describe("discover: safety integration", () => {
  // Spec-review advisory carried into T021/T024: the walker deliberately
  // keeps a FIFO named like a source file as a walk candidate so the safe
  // reader can diagnose it — discover must exclude it from both lists and
  // route exactly one skip diagnostic to the injected stderr sink (FR-017;
  // US3 scenario 2 at the discover level).
  it.skipIf(!mkfifoAvailable)(
    "excludes a FIFO named like a source file from both lists with one diagnostic",
    async () => {
      const root = await makeTree({ "neighbor.ts": "neighbor" });
      execFileSync("mkfifo", [join(root, "pipe.ts")]);
      const sink = memorySink();
      const stdout = vi.spyOn(process.stdout, "write");
      const result = await discover(root, sink.stream);
      expect(result.source_files).toEqual(["neighbor.ts"]);
      expect(result.test_files).toEqual([]);
      expectOneSkipLine(sink.text(), "pipe.ts");
      expect(stdout).not.toHaveBeenCalled();
    },
  );
});
