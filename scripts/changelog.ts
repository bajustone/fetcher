import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
const version = pkg.version;

// Find the previous tag
const tags = execSync('git tag --sort=-v:refname', { encoding: 'utf-8' })
  .trim()
  .split('\n')
  .filter(Boolean);

const prevTag = tags.find(t => t !== `v${version}`) ?? tags[0];

if (!prevTag) {
  console.log('No previous tag found, skipping changelog generation');
  process.exit(0);
}

// Get commits since previous tag
const log = execSync(
  `git log ${prevTag}..HEAD --pretty=format:"%s" --no-merges`,
  { encoding: 'utf-8' },
)
  .trim()
  .split('\n')
  .filter(Boolean);

if (log.length === 0) {
  console.log('No new commits since last tag, skipping changelog generation');
  process.exit(0);
}

// Reject non-descriptive commit subjects (bare `fix`, `fix:`, `feat()`, …).
// An empty "fix" entry gives consumers no signal on scope or risk, so refuse
// to generate a changelog from one and force a real summary.
const NON_DESCRIPTIVE
  = /^(?:fix|feat|update|change|refactor|improve|chore|docs|perf|test|build|ci|style|revert|add)(?:\([^)]*\))?:?\s*$/i;
const emptyEntries = log.filter(msg => NON_DESCRIPTIVE.test(msg.trim()));
if (emptyEntries.length > 0) {
  console.error(
    'Refusing to generate the changelog — these commits have no descriptive summary:',
  );
  for (const msg of emptyEntries)
    console.error(`  - ${JSON.stringify(msg)}`);
  console.error(
    '\nRewrite them with a one-line description, e.g. "fix: prevent X from throwing on Y".',
  );
  process.exit(1);
}

// Categorize commits
const added: string[] = [];
const changed: string[] = [];
const fixed: string[] = [];

for (const msg of log) {
  const lower = msg.toLowerCase();
  if (lower.startsWith('fix')) {
    fixed.push(msg);
  }
  else if (
    lower.startsWith('update')
    || lower.startsWith('refactor')
    || lower.startsWith('improve')
    || lower.startsWith('change')
  ) {
    changed.push(msg);
  }
  else {
    added.push(msg);
  }
}

// Build section
const today = new Date().toISOString().split('T')[0];
let section = `\n## [${version}] - ${today}\n`;

if (added.length > 0) {
  section += `\n### Added\n${added.map(m => `- ${m}`).join('\n')}\n`;
}
if (changed.length > 0) {
  section += `\n### Changed\n${changed.map(m => `- ${m}`).join('\n')}\n`;
}
if (fixed.length > 0) {
  section += `\n### Fixed\n${fixed.map(m => `- ${m}`).join('\n')}\n`;
}

// Insert after "# Changelog" header
const changelogPath = join(root, 'CHANGELOG.md');
const existing = readFileSync(changelogPath, 'utf-8');

const headerEnd = existing.indexOf('\n');
const updated
  = existing.slice(0, headerEnd + 1) + section + existing.slice(headerEnd + 1);

writeFileSync(changelogPath, updated);

// Keep jsr.json's version in lock-step with package.json. JSR uses jsr.json
// as the source of truth on publish, so without this it silently lags.
const jsrPath = join(root, 'jsr.json');
const jsrRaw = readFileSync(jsrPath, 'utf-8');
const jsr = JSON.parse(jsrRaw);
if (jsr.version !== version) {
  jsr.version = version;
  // Preserve trailing newline if the original had one.
  const trailing = jsrRaw.endsWith('\n') ? '\n' : '';
  writeFileSync(jsrPath, `${JSON.stringify(jsr, null, 2)}${trailing}`);
}

// Stage the files so they're included in the version commit
execSync('git add CHANGELOG.md jsr.json', { cwd: root });

console.log(`Updated CHANGELOG.md and jsr.json for v${version}`);
