# Design

## Context

v0.2.0 is reading-stone's first npm publication. The code is feature-complete for protocol v1.2.0; this change is packaging, versioning, and release verification only. See `proposal.md` — Why.

## Goals / Non-Goals

**Goals:**

- A publishable v0.2.0 tarball that carries `NOTICE`, no dangling source maps, and complete registry metadata.
- One end-to-end test proving the built artifact Gaze spawns serves the whole lifecycle in a single session.
- Spec and docs that match what ships.

**Non-Goals:**

- Publishing (a maintainer runs `npm publish` from a clean `main`).
- CI release automation — added after npm trusted publishing is configured, so the v0.2.0 tag push does not race a manual publish.
- Any runtime or protocol change.

## Decisions

1. **Exclude source maps via `files` negation, not `tsconfig`.** `"!dist/**/*.map"` keeps local debugging maps intact while the tarball stays free of maps pointing at unshipped `src/`. Alternative — shipping `src/` alongside — rejected: doubles the payload for a subprocess users never debug into.

2. **List `NOTICE` in `files` explicitly.** npm auto-includes `README` and `LICENSE` but not `NOTICE`; Apache-2.0 §4(d) requires redistributions to carry it. The tarball-contents test pins it so a future `files` edit cannot silently drop it.

3. **Tarball test uses `npm pack --dry-run --json`.** It reads exactly the list npm would publish (honoring `files`, negations, and auto-includes) without writing a tarball. It needs `dist/` built, so it rides the existing `describe.skipIf(!existsSync(mainJs))` subprocess guard like the other built-artifact tests.

4. **`exports` map with `"."` and `"./package.json"`.** Declares the public surface as the `src/index.ts` barrel (convention pack AP-001). Bins are unaffected (they resolve by path, not through `exports`). Deep imports of `dist/*` become unsupported — acceptable at 0.x before any consumer exists.

5. **Lifecycle fixture is minimal but non-vacuous.** One source module with a side effect, a documented export, and a branch; one vitest test file asserting on it; a `tsconfig.json` so program mode (checker-dependent signals) is exercised; and a hand-authored `coverage/coverage-final.json` so `coverage` returns rows. Every analysis method must return at least one row, so a regression that empties any method fails loudly.

6. **Archive `align-protocol-v1-2-0` with `--skip-specs`.** Its deltas were pre-synced into the main specs at merge, and 005 later flipped the capability scenarios; validating its MODIFIED block against today's spec fails by design. Skipping the spec sync archives the record without regressing main specs.

## Risks / Trade-offs

- **`exports` restricts deep imports** → no known consumers; documented in CHANGELOG.
- **Lifecycle test runtime** (each method boots a fresh compiler context) → fixture kept to two files; test timeout 120 s.
