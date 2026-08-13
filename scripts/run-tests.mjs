import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const testsDir = join(root, 'tests');

function collect(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collect(full));
    else if (entry.isFile() && entry.name.endsWith('.test.mjs')) out.push(full);
  }
  return out;
}

const files = collect(testsDir).sort();
if (!files.length) {
  console.error('No test files found under tests/.');
  process.exit(1);
}

const verbose = process.argv.includes('--verbose');
const args = ['--test'];
if (verbose) args.push('--test-reporter=spec');
args.push(...files);

const result = spawnSync(process.execPath, args, {
  stdio: 'inherit',
  cwd: root,
  shell: false,
});

if (result.error) {
  console.error(result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
