# Claude development handoff

This repository is connected to `tnaks6325-web/review-web-system`.
Use the remote `main` branch as the source of truth. The continuation branch
was created from `6cffa3093eb0fb48186aa12cf94ffb933639aec8` (the latest `main`
commit when this handoff was prepared).

## Safe working agreement

1. Before starting a new task, fetch `origin` and compare against
   `origin/main`. Start from the current remote `main`, not from a local copy
   or an older Claude branch.
2. Work in a dedicated `claude/<task>` branch. Never commit or push directly
   to `main`.
3. Keep the task diff scoped. Inspect `git status -sb` and `git diff` before
   staging; do not stage unrelated user changes.
4. Push the task branch and open a draft pull request to `main`. Review the
   PR diff and required checks before merging.
5. Never use force-push, history rewrites, reset/checkout of another
   contributor's work, or a merge that replaces newer `main` changes with an
   older branch snapshot.
6. If `main` advances while work is in progress, fetch it and rebase or merge
   the current `origin/main` into the task branch, resolve conflicts against
   the newer code, then re-run the relevant checks.

## Starting a task

```powershell
git fetch origin --prune
git switch main
git pull --ff-only origin main
git switch -c claude/<task-name>
```

If the working tree contains someone else's changes, do not switch, reset, or
clean it. Ask for the intended scope or use a separate worktree instead.

## Pull request checklist

- Base branch: `main`
- Head branch: the task-specific `claude/<task>` branch
- Confirm the PR diff does not remove or revert unrelated recent work
- Run focused tests/checks for the changed area
- Merge only through the PR after review

The repository's root `CLAUDE.md` and `.claude/` workflows remain the primary
project instructions; this document only records the Git handoff and
non-overwrite guardrails.
