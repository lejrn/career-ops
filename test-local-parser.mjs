#!/usr/bin/env node

/**
 * Integration test: local-parser provider + scan.mjs (Cohere + Mobileye fixtures).
 *
 * Requires: python3, network access to api.ashbyhq.com and careers.mobileye.com
 *
 * Usage:
 *   node test-local-parser.mjs
 */

import { execFileSync, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import localParser from './providers/local-parser.mjs';

const ROOT = dirname(fileURLToPath(import.meta.url));
const MULTI_PORTALS = join(ROOT, 'test/fixtures/portals-local-parsers.yml');

const FIXTURES = [
  {
    label: 'Cohere',
    script: join(ROOT, 'test/fixtures/parsers/cohere_jobs.py'),
    entry: {
      name: 'Cohere',
      careers_url: 'https://jobs.ashbyhq.com/cohere',
      enabled: true,
      parser: {
        command: 'python3',
        script: 'test/fixtures/parsers/cohere_jobs.py',
        args: ['--stdout-jobs', '--no-output'],
        timeout_ms: 45000,
      },
    },
  },
  {
    label: 'Mobileye',
    script: join(ROOT, 'test/fixtures/parsers/mobileye_nuxt_jobs.py'),
    entry: {
      name: 'Mobileye',
      careers_url: 'https://careers.mobileye.com/jobs',
      enabled: true,
      parser: {
        command: 'python3',
        script: 'test/fixtures/parsers/mobileye_nuxt_jobs.py',
        args: ['--url', 'https://careers.mobileye.com/jobs', '--stdout-jobs', '--no-output'],
        timeout_ms: 45000,
      },
    },
  },
];

let failed = 0;

function pass(msg) {
  console.log(`  ✅ ${msg}`);
}

function fail(msg) {
  console.log(`  ❌ ${msg}`);
  failed++;
}

function hasPython3() {
  try {
    execFileSync('python3', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

async function testFixture({ label, script, entry }) {
  console.log(`\n  --- ${label} ---\n`);

  if (!existsSync(script)) {
    fail(`${label}: fixture script missing: ${script}`);
    return;
  }
  pass(`${label}: fixture script exists`);

  const detectHit = localParser.detect(entry);
  if (detectHit) {
    pass(`${label}: local-parser detect() matched`);
  } else {
    fail(`${label}: local-parser detect() did not match`);
    return;
  }

  let lastErr;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const jobs = await localParser.fetch(entry);
      if (!Array.isArray(jobs) || jobs.length === 0) {
        fail(`${label}: fetch() returned no jobs`);
        return;
      }
      pass(`${label}: fetch() returned ${jobs.length} jobs`);

      const sample = jobs[0];
      if (sample?.title && sample?.url && sample?.company) {
        pass(`${label}: sample job: ${sample.title}`);
      } else {
        fail(`${label}: sample missing fields: ${JSON.stringify(sample)}`);
      }
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 1500));
      }
    }
  }
  fail(`${label}: fetch() failed: ${lastErr?.message || lastErr}`);
}

console.log('\n🧪 local-parser integration (Cohere + Mobileye fixtures)\n');

if (!hasPython3()) {
  fail('python3 not found — install Python 3 to run this test');
  process.exit(1);
}
pass('python3 is available');

for (const fixture of FIXTURES) {
  await testFixture(fixture);
}

console.log('\n  Running scan.mjs --dry-run (Cohere + Mobileye + Cato API)...\n');

const scan = spawnSync(
  process.execPath,
  ['scan.mjs', '--dry-run'],
  {
    cwd: ROOT,
    env: { ...process.env, CAREER_OPS_PORTALS: MULTI_PORTALS },
    encoding: 'utf-8',
    timeout: 180_000,
  },
);

if (scan.status !== 0) {
  fail(`scan.mjs exited with code ${scan.status}`);
  if (scan.stderr) console.log(scan.stderr);
  if (scan.stdout) console.log(scan.stdout);
} else {
  const out = `${scan.stdout}\n${scan.stderr}`;
  if (out.includes('2 local parser') && out.includes('Total jobs found:')) {
    pass('scan.mjs dry-run: 2 local parsers reported');
  } else if (out.includes('local parser') && out.includes('Total jobs found:')) {
    pass('scan.mjs dry-run completed with local parser summary');
  } else {
    fail('scan.mjs dry-run output missing expected summary');
    console.log(out);
  }
  for (const name of ['Cohere', 'Mobileye', 'Cato']) {
    if (out.includes(name)) {
      pass(`scan.mjs output references ${name}`);
    } else {
      fail(`scan.mjs output missing ${name}`);
    }
  }
}

console.log('\n' + '='.repeat(50));
if (failed > 0) {
  console.log(`🔴 ${failed} check(s) failed\n`);
  process.exit(1);
}
console.log('🟢 local-parser integration passed\n');
