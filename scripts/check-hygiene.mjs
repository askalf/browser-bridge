#!/usr/bin/env node
// Checks for what the repo's review gate blocks as generated or attributed
// text, so it fails here and in CI before a reviewer has to say it:
//   - an em dash (U+2014) on any added line of a text file
//   - a commit authored or committed by a model identity, or a message
//     carrying a model attribution trailer
//
// Existing text is not checked, only what a change adds.
//
//   node scripts/check-hygiene.mjs --range origin/master..HEAD   (CI, pre-push)
//   node scripts/check-hygiene.mjs --staged                      (pre-commit)
//   node scripts/check-hygiene.mjs --commit-msg <file>           (commit-msg)
//   PR_BODY=... node scripts/check-hygiene.mjs --pr-body          (CI)
//
// When the gate blocks on something new, add it here with a test in
// test/check-hygiene.test.mjs, and a line to CONTRIBUTING.md.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const EM_DASH = '\u2014';

// Lockfiles and vendored bytes are machine-written; nobody reviews their prose.
const SKIP_FILE = /(^|\/)(package-lock\.json|[^/]+\.(png|jpe?g|gif|webp|ico|pdf|woff2?))$/;

// Coding models and agents from any vendor, by commit name or email. After
// the vendor word, a name may carry only product or model words and version
// numbers, and a noreply login only a known agent suffix, so a person named
// Claude Dupont or a login like claudette passes. Bots that are not models
// (dependabot, github-actions) do not match.
const MODEL_NAMES = 'claude|anthropic|gpt|chatgpt|openai|codex|copilot|gemini';
const MODEL_WORDS = 'code|opus|sonnet|haiku|fable|codex|swe-agent|code-assist|agent';
const MODEL_IDENTITY = [
  /@(anthropic|openai)\.com$/i,
  new RegExp(`^(${MODEL_NAMES})([ -](${MODEL_WORDS}|[\\d.]+))*(\\[bot\\])?$`, 'i'),
  new RegExp(`\\+(${MODEL_NAMES})(-(${MODEL_WORDS}))?(\\[bot\\])?@users\\.noreply\\.github\\.com$`, 'i'),
];
const isModel = (name, email) => MODEL_IDENTITY.some((re) => re.test(name) || re.test(email));
const ATTRIBUTION = [
  /^claude-session:/im,
  /claude\.ai\/code\/session_[\w-]+/i,
  /generated (with|by) \[?(claude code|chatgpt|codex|copilot|gemini)/i,
  /\bclaude-(opus|sonnet|haiku|fable)-\d/i,
  /\bgpt-\d(\.\d+)?(-[a-z]+)?\b/i,
  /\bgemini-\d(\.\d+)?-(pro|flash)/i,
];

// Parses `git diff --unified=0` output into added lines containing an em dash.
// Counting is per hunk. Rewording a line that already had one passes.
export function findEmDashes(diff) {
  const hits = [];
  let file = null;
  let line = 0;
  let hunk = null;
  // `--- ` and `+++ ` are file headers only between `diff --git` and the first
  // hunk; inside a hunk they are a removed `-- ` or an added `++ ` line.
  let inHeader = true;
  const count = (t) => t.split(EM_DASH).length - 1;
  const flush = () => {
    if (hunk && hunk.added > hunk.removed) hits.push(...hunk.lines);
    hunk = null;
  };
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) { flush(); file = null; inHeader = true; continue; }
    if (inHeader && raw.startsWith('+++ ')) {
      file = raw === '+++ /dev/null' ? null : raw.slice(4).replace(/^b\//, '');
      continue;
    }
    if (inHeader && raw.startsWith('--- ')) continue;
    const h = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (h) { flush(); inHeader = false; line = Number(h[1]); hunk = { added: 0, removed: 0, lines: [] }; continue; }
    if (!file || !hunk || SKIP_FILE.test(file)) continue;
    if (raw.startsWith('-')) {
      hunk.removed += count(raw);
    } else if (raw.startsWith('+')) {
      const n = count(raw);
      if (n) { hunk.added += n; hunk.lines.push({ file, line, text: raw.slice(1).trim() }); }
      line++;
    } else if (raw.startsWith(' ')) {
      line++;
    }
  }
  flush();
  return hits;
}

// Returns what in a PR description the gate would block: attribution lines
// (a tool can append a generator footer on its own) and em dashes.
export function findBodyProblems(body) {
  const problems = findAttribution({ message: body });
  if (body.includes(EM_DASH)) problems.push('contains an em dash');
  return problems;
}

// Returns the reasons a commit is attributed to a model; empty when it is clean.
export function findAttribution({ authorName = '', authorEmail = '', committerName = '', committerEmail = '', message = '' }) {
  const reasons = [];
  for (const [role, name, email] of [['author', authorName, authorEmail], ['committer', committerName, committerEmail]]) {
    if (isModel(name, email)) {
      reasons.push(`${role} is ${name} <${email}>`);
    }
  }
  for (const m of message.matchAll(/^co-authored-by:\s*(.*?)\s*<([^>]*)>/gim)) {
    if (isModel(m[1], m[2])) reasons.push(`message contains "${m[0].trim()}"`);
  }
  for (const re of ATTRIBUTION) {
    const m = message.match(re);
    if (m) reasons.push(`message contains "${m[0].trim()}"`);
  }
  return reasons;
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function commitsIn(range) {
  const SEP = '\x1f';
  const END = '\x1e';
  const out = git('log', `--format=%H${SEP}%an${SEP}%ae${SEP}%cn${SEP}%ce${SEP}%B${END}`, range);
  return out.split(END).map((s) => s.replace(/^\n/, '')).filter(Boolean).map((rec) => {
    const [sha, authorName, authorEmail, committerName, committerEmail, message] = rec.split(SEP);
    return { sha, authorName, authorEmail, committerName, committerEmail, message };
  });
}

function identity(kind) {
  // `git var` prints "Name <email> timestamp tz" for the identity git would use now.
  const m = git('var', kind).match(/^(.*) <(.*)> \d+ [+-]\d{4}$/m);
  return m ? { name: m[1], email: m[2] } : { name: '', email: '' };
}

function report(problems) {
  if (problems.length === 0) return 0;
  for (const p of problems) console.error(p);
  console.error(`\n${problems.length} problem(s). See CONTRIBUTING.md.`);
  return 1;
}

function dashProblems(diff) {
  return findEmDashes(diff).map((h) => `${h.file}:${h.line}: em dash in added text: ${h.text}`);
}

export function main(argv) {
  const [mode, arg] = argv;
  if (mode === '--range' && arg) {
    const [base, head = 'HEAD'] = arg.split('..');
    const problems = dashProblems(git('diff', '--unified=0', '--no-color', `${base}...${head}`));
    for (const c of commitsIn(arg)) {
      for (const r of findAttribution(c)) problems.push(`${c.sha.slice(0, 7)}: ${r}`);
    }
    return report(problems);
  }
  if (mode === '--staged') {
    return report(dashProblems(git('diff', '--cached', '--unified=0', '--no-color')));
  }
  if (mode === '--commit-msg' && arg) {
    const author = identity('GIT_AUTHOR_IDENT');
    const committer = identity('GIT_COMMITTER_IDENT');
    // git hands the hook the raw file: with commit -v it ends in a scissors
    // line and the staged diff, which is not part of the message.
    const message = readFileSync(arg, 'utf8')
      .replace(/^# -+ >8 -+$[\s\S]*/m, '')
      .replace(/^#.*$/gm, '');
    const problems = findAttribution({
      authorName: author.name, authorEmail: author.email,
      committerName: committer.name, committerEmail: committer.email,
      message,
    });
    if (message.includes(EM_DASH)) problems.push('message contains an em dash');
    return report(problems.map((r) => `commit message: ${r}`));
  }
  if (mode === '--pr-body') {
    return report(findBodyProblems(process.env.PR_BODY || '').map((r) => `PR description: ${r}`));
  }
  console.error('usage: check-hygiene.mjs --range <base>..<head> | --staged | --commit-msg <file> | --pr-body');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
