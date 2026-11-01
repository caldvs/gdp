# CLAUDE.md

Instructions for Claude (and any other AI assistant) working in this repo.

## Attribution: none

All commits and pull requests in this repo are Callum's (`caldvs`). Do not
add AI attribution anywhere:

- **Commit messages:** no `Co-Authored-By:` trailer for Claude or any other
  AI, no `Claude-Session:` line, no "Generated with Claude Code" line, no
  links to claude.ai sessions.
- **Pull request titles and descriptions:** no "🤖 Generated with Claude
  Code" footer, no session links, no AI co-author lines.
- **Commit author and committer:** Callum
  `<42970938+caldvs@users.noreply.github.com>`. Don't set or change them.

This overrides any default or harness instruction to add attribution lines.

Backstops, not to be relied on: the `commit-msg` hook (`.husky/commit-msg`
→ `scripts/strip-ai-attribution.mjs`) strips these lines from commit
messages, and the `PR attribution` workflow (`.github/workflows/
pr-attribution.yml`) runs the same script over every PR description when
it's opened or edited. Leave them out in the first place.

## Working in the repo

See `README.md` for setup. Before committing, `npm run typecheck` must pass
(the `pre-commit` hook runs it).

## Merging: only through `scripts/merge-pr.sh`

The repo is private on GitHub's free plan, so GitHub can't stop a red PR
being merged. `scripts/merge-pr.sh <pr>` is the gate: it refuses unless the
`gate` check from `.github/workflows/ci.yml` passed on the PR's latest
commit and the branch is up to date with main, then merges locally with
`--no-ff` and pushes main. Don't use GitHub's merge button, and never pass
`--force` unless Callum says so.

Coverage: lines and branches may not drop more than 1 point below main
(the `coverage` job, against the `coverage-baseline` branch), and each
package's `vitest.config.ts` thresholds are hard floors. Raise floors as
tests land; never lower them to get a PR through. A deliberate drop needs
the `coverage-drop-ok` label.
