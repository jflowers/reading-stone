---
description: >
  Finalize a branch: commit, push, create PR, watch CI
  checks, and return to main. The PR stays open for
  review. One command to wrap up any feature, OpenSpec,
  or quick branch.
---
<!-- scaffolded by uf vdev -->

# Command: /uf.finale

## User Input

```text
$ARGUMENTS
```

## Description

Automate the end-of-branch workflow. Stages, commits,
pushes, creates a PR, watches CI, and returns to `main`.

## Usage

```
/uf.finale                    # auto-detect everything
/uf.finale fix the typo       # use as commit message hint
```

## Instructions

<protect>

**Session-resume guard**: If resumed from compressed
context, re-read this template, call `get_progress` with
`command: "uf.finale"` to recover state, and re-confirm
any pending gates via the **question tool**. Do NOT rely
on compressed gate confirmations. When in doubt,
re-confirm — false re-confirmation is harmless; executing
without consent is a violation.

**Progress tracking**: Call `get_progress` with
`command: "uf.finale"` on startup. Resume from the first
incomplete step using `completed_steps` and `data`. After
each step, call `checkpoint` with `command: "uf.finale"`,
`step: "<name>"`, and relevant state in `data`. Use
TodoWrite alongside for live visibility.

### 1. Branch Safety Gate

Call `uf_finale_startup` → `{branch, branchType, isMain,
hasChanges, secretCandidates, unpushedCommits}`.

If `isMain`: **STOP** — "Cannot run /uf.finale on main.
Switch to a feature branch first."

### 2. Check for Changes

**No changes** (`!hasChanges`): if `unpushedCommits` is
non-empty, skip to step 4. Else check step 5 for
existing PR. If no PR either, report "Nothing to
finalize" and stop.

**Changes exist** with `secretCandidates` non-empty:

>>> MANDATORY GATE <<<

Print secret candidates. Use **question tool**:
`["Yes -- stage all files and continue",
"No -- stop here"]`.
- **Yes**: Call `uf_finale_stage` → `{fileCount, files}`.
- **No**: **STOP**.

>>> END GATE <<<

If no secret candidates, call `uf_finale_stage` directly.

**Checkpoint**: `step: "check-changes"`.

### 3. Commit Message

Call `uf_finale_commit_context` with your raw model ID
→ `{diffStat, recentLog, normalizedModel}`.

Generate a conventional commit: type (`feat:` / `fix:` /
`docs:` / `chore:` / `refactor:` / `test:`), concise
summary focusing on "why", body with bullets if multiple
changes. Use `$ARGUMENTS` as hint if non-empty. Append:
`Assisted-by: <normalizedModel>`
`Generated with AI assistance (<normalizedModel>)`

>>> MANDATORY GATE <<<

- **Stage Dewey knowledge artifacts**: Dewey learnings and
  compiled articles produced during this change are knowledge
  artifacts that belong in the feature PR. They capture
  patterns, decisions, and gotchas discovered during the
  workflow and are essential for team knowledge continuity.

  ```bash
  git add .uf/dewey/learnings/ .uf/dewey/compiled/ 2>/dev/null
  ```

  Do NOT skip this step. Even though `git add .` may have
  already staged these files, this explicit step ensures
  Dewey artifacts are never accidentally excluded from the
  commit.

**Session-resume guard**: Re-present and re-confirm if
resumed.

**VISIBILITY DIRECTIVE**: Print the full proposed commit
message as plain output before invoking the question tool.

Use **question tool**: `["Approve and commit",
"Edit commit message", "Provide my own message"]`.
- **Approve**: Commit with displayed message.
- **Edit**: Let user modify, re-confirm.
- **Own**: Accept user's replacement.

User MAY edit or remove attribution. NEVER commit without
explicit confirmation.

>>> END GATE <<<

**Checkpoint**: `step: "commit"`,
`data: '{"commit": "<hash>"}'`.

### 4. Push

Call `uf_finale_push_state` → `{upstreamExists, diverged,
aheadBy, behindBy}`.

>>> MANDATORY GATE <<<

**Session-resume guard**: Re-present and re-confirm if
resumed. Warn if `diverged` is true.

Use **question tool**: `["Push to remote",
"Abort -- keep commits local"]`.
- **Push**: Call `git_push` (with
  `{setUpstream: true, branch}` if `!upstreamExists`).
  If fails, **STOP**.
- **Abort**: **STOP**.

NEVER push without explicit confirmation.

>>> END GATE <<<

**Checkpoint**: `step: "push"`.

### 5. Create or Find PR

Call `uf_finale_pr_context` → `{existingPr, isFork,
forkParent, templateSections, commitLog, diffStat,
originatingIssue, unleashSummary}`.

**If `existingPr`**: use its number/URL, skip creation.

**If no PR**:

a. If `isFork`, ask user where to target (upstream
parent or fork origin) via **question tool**.

b. Synthesize PR title from `commitLog`.

c. Generate PR body sections:
- `## Summary` — from `commitLog`; prefer
  `unleashSummary.whatWasBuilt` if available.
  If `originatingIssue` (tier-routing route decision or
  `.openspec.yaml`), insert `Closes #<N>` after
  Summary. Soft-warn if opsx branch lacks it.
- `## How to Test` — prefer `unleashSummary.howToVerify`;
  else read spec artifacts or synthesize from diff.
- `## How to Demo` — walkthrough or "Trivial fix —
  no demo required."
- `## Key Files Changed` — from `diffStat`.
- `## Known Issues` — unresolved `/uf.review-council`
  findings (severity + description). Omit if none.
- Footer: `_This PR was generated by /uf.finale
  (AI-assisted)._`

**Template mapping**: If `templateSections` non-empty,
map to template headings (case-insensitive substring):
Summary→Description/Summary/Overview/What;
How to Test→Testing/Test/Test Plan/Verification;
How to Demo→Demo; Key Files→Files Changed/Changes.
Preserve unmatched sections. Fall back to default if
no `##` headings found.

>>> MANDATORY GATE <<<

**Session-resume guard**: Re-present and re-confirm if
resumed.

**VISIBILITY DIRECTIVE**: Print the full PR title and
body as plain output before invoking the question tool.

Use **question tool**: `["Approve — create PR",
"Edit title or body", "Provide my own title and body",
"Abort — do not create PR"]`.

>>> END GATE <<<

Call `uf_finale_create_pr` with `{title, body,
targetRepo?}` → `{number, url}`. Report PR URL.

**Checkpoint**: `step: "create-pr"`,
`data: '{"pr_number": <N>, "pr_url": "<url>"}'`.

### 6. Watch CI Checks

Call `uf_finale_ci_poll` with `{prNumber}` → `{status,
failedChecks, mergeable, workflowsConfigured}`.

**`"pass"`**: Proceed to step 7.

**`"fail"`**:

>>> MANDATORY GATE <<<

Print `failedChecks` (name, conclusion, url). Explain
what likely went wrong. Use **question tool**:
`["Investigate the failure", "Re-run the checks",
"Stop here and fix manually"]`.

>>> END GATE <<<

**`"conflict"`**: Proceed to 6b.

**`"no-checks-workflows-exist"`**: Use **question tool**:
`["Proceed without CI checks", "Stop and investigate"]`.

**`"no-checks-no-workflows"`**: Report "No CI workflows
configured" and proceed to step 7.

#### 6b. Conflict Recovery

Determine target remote (upstream if fork, else origin)
and base branch.

>>> MANDATORY GATE <<<

Use **question tool**: `["Merge target branch (no force
push needed)", "Rebase onto target (requires force push)",
"Stop and resolve manually", "Continue anyway (CI will
not run)", "Spawn sub-agent to resolve (AI-assisted)"]`.

Checkpoint `step: "conflict-option"`,
`data: '{"conflict_option": <N>}'`.

>>> END GATE <<<

**Option 1 — Merge**: `git_fetch` → `git_merge`. If no
conflict: `git_push`, then `uf_finale_ci_poll`. If
conflicted: `git_merge_abort`, report files, **STOP**.

**Option 2 — Rebase**: Warn force push may be blocked.
`git_fetch` → `git_rebase`. If no conflict:
`git_push_force_with_lease` (if fails, suggest Option 1,
**STOP**); on success, `uf_finale_ci_poll`. If
conflicted: `git_rebase_abort`, report files, **STOP**.

**Option 3 — Stop**: Report conflict, **STOP**.

**Option 4 — Continue**: Proceed to step 7 with CI
skipped warning flag.

**Option 5 — Sub-agent**: `git_fetch` → `git_merge`
(creates markers) → `git_conflict_files` for file list.
Spawn `cobalt-crush-dev` with: file list, target branch,
resolve-by-integration instructions (not choose-one-side).
Sub-agent MUST NOT receive full `/uf.finale` context.

After return, `git_conflict_files` again. If unresolved:
`git_merge_abort`, return to 5-option menu. If resolved,
show staged diff. Use **question tool**:
`["Approve, commit, and push", "Request edits",
"Abort (discard resolution)"]`.
- **Approve**: `git_commit_no_edit` → `git_push` →
  `uf_finale_ci_poll`.
- **Edits**: User edits, re-show diff, re-present menu.
- **Abort**: `git_merge_abort`, return to 5-option menu.

**POST-CI MOMENTUM**: After Step 6, proceed immediately
to Step 7 without CI output. Defer to Step 8.

**Checkpoint**: `step: "watch-ci"`.

### 7. Return to Main

Call `uf_finale_return_to_main` → `{success}`.
**Checkpoint**: `step: "return-to-main"`.

### 8. Summary

```
## Finale Complete

**Branch:** <branch> (pushed)
**Commit:** <summary>
**PR:** #<N> — <status>, ready for review
**Checks:** passed
**Status:** on main, up to date

Next: gh pr merge --rebase --delete-branch
```

If CI skipped (Option 4): `**Checks:** CI checks did
not run due to merge conflict`.

**Checkpoint**: `step: "summary"`. Call `clear_progress`
with `command: "uf.finale"`.

## Guardrails

- **NEVER run on `main`** — feature branches only
- **NEVER merge the PR** — creates PRs for review only
- **NEVER stage secrets without warning**
- **NEVER commit without user approval**
- **NEVER create PR without user approval**
- **ALWAYS report the PR URL**
- **If any step fails**, stop with context and options
- **NEVER `git push --force`** — use
  `git_push_force_with_lease`
- **NEVER rebase/force-push without confirmation**
- **NEVER commit sub-agent resolutions without approval**

## Branch Safety

- All changes committed before any branch switch
- Remote branch NOT deleted — stays open with PR

</protect>
