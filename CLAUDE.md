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
