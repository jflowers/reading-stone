# Tasks

## 1. Versioning

- [x] 1.1 Bump version to `0.2.0` in `package.json`/`package-lock.json` (`npm version 0.2.0 --no-git-tag-version`) and `VERSION` in `src/index.ts`; update the `tests/cli.test.ts` version pins

## 2. Packaging

- [x] 2.1 `package.json`: `files` → `["dist", "!dist/**/*.map", "NOTICE"]`; add `homepage`, `bugs`, `keywords`, and the `exports` map; extend the package-metadata test to pin them
- [x] 2.2 Add a tarball-contents test (`npm pack --dry-run --json`) pinning NOTICE/LICENSE/README/package.json present and no `.map` files

## 3. End-to-end conformance

- [x] 3.1 Add the full-lifecycle stdio smoke test against `dist/main.js` (all 10 methods, one session, non-empty rows per analysis method, exit 0)

## 4. Documentation

- [x] 4.1 Add `CHANGELOG.md` with the v0.2.0 entry
- [x] 4.2 README: v0.2.0 status heading, npm install path, exact `typescript` pin note; AGENTS.md: correct the "v0.1.0 shipped" claim

## 5. OpenSpec hygiene and gates

- [x] 5.1 Archive `align-protocol-v1-2-0` with `--skip-specs`
- [x] 5.2 Run the CI parity gates — `npx biome check src/ tests/`, `npm run build`, `npx vitest run --coverage` — all pass at ≥85%
