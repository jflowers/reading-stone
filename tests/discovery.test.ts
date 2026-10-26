import { chmod, mkdir, mkdtemp, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discover, InvalidRootPathError } from "../src/discovery.js";
import { serialize } from "../src/protocol.js";
import { createFixtureTree } from "./helpers/fixtures.js";

// Fixture trees and scratch directories register their cleanup here so every
// test body can stay linear; afterEach drains the queue in creation order.
const pendingCleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
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
