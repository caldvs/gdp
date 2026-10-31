#!/usr/bin/env node
// commit-msg hook: removes AI attribution lines (Co-Authored-By: Claude…,
// Claude-Session:, "Generated with Claude Code", claude.ai session links)
// from the commit message so they never land in history. See CLAUDE.md.
//
//   node scripts/strip-ai-attribution.mjs <path-to-COMMIT_EDITMSG>
//   node scripts/strip-ai-attribution.mjs --check <file>   exit 1 if any found
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const check = args[0] === '--check';
const file = check ? args[1] : args[0];
if (!file) {
  console.error('usage: strip-ai-attribution.mjs [--check] <message-file>');
  process.exit(2);
}

const AI = /claude|anthropic|copilot|chatgpt|openai|cursor|gemini|codeium|devin/i;
const patterns = [
  (l) => /^\s*co-authored-by:/i.test(l) && AI.test(l),
  (l) => /^\s*claude-session:/i.test(l),
  (l) => /generated (with|by) \[?claude code/i.test(l),
  (l) => /claude\.(ai|com)\/(code|chat)\//i.test(l),
];

const original = readFileSync(file, 'utf8');
const lines = original.split('\n');
const removed = lines.filter((l) => patterns.some((p) => p(l)));

if (check) {
  if (removed.length) {
    console.error(`AI attribution found:\n${removed.map((l) => `  ${l}`).join('\n')}`);
    process.exit(1);
  }
  process.exit(0);
}

if (removed.length) {
  const kept = lines.filter((l) => !patterns.some((p) => p(l)));
  // Drop the blank lines a removed trailer block leaves at the end.
  while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
  writeFileSync(file, `${kept.join('\n')}\n`);
  console.error(`commit-msg: removed ${removed.length} AI attribution line(s) (see CLAUDE.md)`);
}
