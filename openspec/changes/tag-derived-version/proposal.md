# Proposal

## Why

The dispatched `release` workflow asks for the tag, creates it, and stages the package, but it also requires the `package.json` version on `main` to already equal the tag. That makes every release two steps: a bump PR, then the dispatch. The first dispatch (`v0.2.1`, run 45274541637) failed because the bump had not landed. npm publishes whatever `package.json` says, so the version has to live somewhere; the question is where it is typed.

unbound-force's Go releases take the version from the tag alone. The npm equivalent is the semantic-release convention: `main` carries the placeholder `0.0.0-development` and CI writes the real version just before publishing, without committing it back. The tag becomes the only place a version is typed, so the tag and the package cannot disagree.

## What Changes

- `release.yml`: drop the tag-equals-`package.json` check from the verify job (it keeps the main-only check). The stage job runs the CI gates on the tag as committed, then `npm version <tag without v> --no-git-tag-version`, then `npm stage publish` (whose `prepublishOnly` rebuilds), so the tarball carries the tag's version. The `next` dist-tag decision reads the tag.
- `package.json` / `package-lock.json` on `main`: version `0.0.0-development`.
- `src/index.ts`: `VERSION` is read from the package's own `package.json` at load time instead of being a hard-coded literal, so the version is written in one place.
- `tests/cli.test.ts`: pin `VERSION` to the `package.json` version and `package.json` to the placeholder.
- README "Releasing" and status heading, `CHANGELOG.md` Unreleased note.

Out of scope: generating the CHANGELOG; the GitHub release is still created by hand with generated notes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `release`: "Dispatched staged npm release" is replaced by "Tag-versioned dispatched npm release": the same workflow, except the version comes from the `tag` input, so the tag/`package.json` mismatch scenario becomes a scenario that the staged version equals the tag.
- `cli`: `package.json` on `main` declares `0.0.0-development`; `VERSION` equals the `package.json` version.

## Impact

- `.github/workflows/release.yml`, `package.json`, `package-lock.json`, `src/index.ts`, `tests/cli.test.ts`, `README.md`, `CHANGELOG.md`.
- `src/index.ts` gains a synchronous read of `../package.json` relative to the module (`node:fs`), present in both the source tree and the published tarball (`package.json` always ships; it is also exported as `./package.json`).
- Gaze protocol contract: unchanged; `initialize` does not report the package version.
- npm trust relationship: unchanged (same workflow file, environment, and `npm stage publish`).

## Constitution Alignment

- **I. Protocol Fidelity — PASS**: no protocol change.
- **II. Detection Accuracy — N/A**: no detection code changes.
- **III. TypeScript-Native Analysis — N/A**: no analysis code changes.
- **IV. Testability — PASS**: `tests/cli.test.ts` pins `VERSION` to `package.json`; the 85% gate is unchanged. The workflow change is checked by `actionlint` and exercised by the first dispatch.
- **V. Analysis Safety — PASS**: no new dependencies; the only read is the package's own manifest, never analyzed source.
