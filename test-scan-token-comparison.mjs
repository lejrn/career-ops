#!/usr/bin/env node

/**
 * Benchmark: local parser (0 LLM) vs agent-equivalent scrape payloads (Playwright + API).
 *
 * Token counts use tiktoken `cl100k_base` as a proxy for Claude/GPT-class models.
 * "Simulated" tokens = size of text that would enter the model during agent scan.
 *
 * Requires: python3, network, `npx playwright install chromium`
 *
 * Usage:
 *   npm run test:scan-tokens
 */

import { execFileSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';
import tiktoken from 'tiktoken';

const getEncoding = tiktoken.get_encoding;

const ROOT = dirname(fileURLToPath(import.meta.url));
const ENCODING = 'cl100k_base';
const WEBSEARCH_FIXTURE = join(ROOT, 'test/fixtures/websearch-nivel3-sample.txt');

/** @typedef {{ company: string, method: string, jobs: number | string, input_tokens: number, llm_in_loop: boolean | string, payload_if_pasted?: number, notes?: string }} Row */

const COMPANIES = [
  {
    name: 'Cohere',
    careersUrl: 'https://jobs.ashbyhq.com/cohere',
    parserScript: 'test/fixtures/parsers/cohere_jobs.py',
    parserArgs: ['--stdout-jobs', '--no-output'],
    ashbyApiUrl: 'https://api.ashbyhq.com/posting-api/job-board/cohere?includeCompensation=true',
    websearchFixture: WEBSEARCH_FIXTURE,
  },
  {
    name: 'Mobileye',
    careersUrl: 'https://careers.mobileye.com/jobs',
    parserScript: 'test/fixtures/parsers/mobileye_nuxt_jobs.py',
    parserArgs: ['--url', 'https://careers.mobileye.com/jobs', '--stdout-jobs', '--no-output'],
    ashbyApiUrl: null,
    websearchFixture: null,
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

function countTokens(text, enc) {
  if (!text) return 0;
  return enc.encode(text).length;
}

function hasPython3() {
  try {
    execFileSync('python3', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {typeof COMPANIES[0]} company
 * @param {import('tiktoken').Tiktoken} enc
 */
function runLocalParser(company, enc) {
  const scriptPath = join(ROOT, company.parserScript);
  if (!existsSync(scriptPath)) {
    throw new Error(`parser script missing: ${scriptPath}`);
  }

  const stdout = execFileSync('python3', [scriptPath, ...company.parserArgs], {
    cwd: ROOT,
    encoding: 'utf-8',
    maxBuffer: 10_000_000,
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const jobs = JSON.parse(stdout.trim());
  const payloadIfPasted = countTokens(stdout, enc);

  return {
    jobs: jobs.length,
    input_tokens: 0,
    llm_in_loop: false,
    payload_if_pasted: payloadIfPasted,
    notes: `${stdout.length} chars stdout`,
  };
}

/**
 * @param {typeof COMPANIES[0]} company
 * @param {import('tiktoken').Tiktoken} enc
 */
async function runPlaywright(company, enc) {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(company.careersUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForTimeout(3000);

    const { text, jobLinkCount } = await page.evaluate(() => {
      const bodyText = document.body?.innerText || '';
      const links = [...document.querySelectorAll('a[href]')].filter(a => {
        const href = a.getAttribute('href') || '';
        return /job|career|position|opening/i.test(href);
      });
      return { text: bodyText, jobLinkCount: links.length };
    });

    return {
      jobs: jobLinkCount,
      input_tokens: countTokens(text, enc),
      llm_in_loop: 'simulated',
      notes: `${text.length} chars body innerText`,
    };
  } finally {
    await browser.close();
  }
}

/**
 * @param {typeof COMPANIES[0]} company
 * @param {import('tiktoken').Tiktoken} enc
 */
async function runAshbyApi(company, enc) {
  const res = await fetch(company.ashbyApiUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (career-ops token benchmark)' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`Ashby API HTTP ${res.status}`);
  }
  const body = await res.text();
  const json = JSON.parse(body);
  const jobs = Array.isArray(json.jobs) ? json.jobs.length : 0;

  return {
    jobs,
    input_tokens: countTokens(body, enc),
    llm_in_loop: 'simulated',
    notes: `${body.length} chars JSON`,
  };
}

function runWebsearchFixtureSync(fixturePath, enc) {
  if (!existsSync(fixturePath)) {
    return null;
  }
  const text = readFileSync(fixturePath, 'utf-8');
  return {
    jobs: 'n/a',
    input_tokens: countTokens(text, enc),
    llm_in_loop: 'simulated',
    notes: 'fixture SERP snippets (nivel 3 sample)',
  };
}

/**
 * @param {Row[]} rows
 */
function printTable(rows) {
  const headers = ['Company', 'Method', 'Jobs', 'Input tokens', 'LLM in loop', 'Notes'];
  const colWidths = [10, 22, 6, 14, 12, 36];

  const line = (cols) =>
    cols.map((c, i) => String(c).padEnd(colWidths[i])).join('  ');

  console.log('\n' + line(headers));
  console.log(line(headers.map(() => '-'.repeat(12))));

  for (const row of rows) {
    console.log(
      line([
        row.company,
        row.method,
        row.jobs,
        row.input_tokens.toLocaleString(),
        String(row.llm_in_loop),
        (row.notes || '').slice(0, 40),
      ]),
    );
  }
}

/**
 * @param {Row[]} rows
 */
function printSavings(rows) {
  console.log('\n--- Savings (local parser vs agent-simulated total) ---\n');

  for (const name of [...new Set(rows.map(r => r.company))]) {
    const companyRows = rows.filter(r => r.company === name && !r.method.startsWith('agent_'));
    const parser = companyRows.find(r => r.method === 'local_parser');
    const playwright = companyRows.find(r => r.method === 'playwright_nivel_1');
    const api = companyRows.find(r => r.method === 'api_nivel_2');
    const web = companyRows.find(r => r.method === 'websearch_nivel_3');

    const agentTotal =
      (playwright?.input_tokens || 0) +
      (api?.input_tokens || 0) +
      (web?.input_tokens || 0);

    const saved = agentTotal - (parser?.input_tokens || 0);
    const pct = agentTotal > 0 ? ((saved / agentTotal) * 100).toFixed(1) : 'n/a';

    console.log(`  ${name}:`);
    console.log(`    local_parser LLM tokens:     ${parser?.input_tokens ?? 0}`);
    console.log(`    agent-simulated (1+2+3):     ${agentTotal.toLocaleString()}`);
    if (parser?.payload_if_pasted != null) {
      console.log(`    parser stdout if pasted:     ${parser.payload_if_pasted.toLocaleString()} (not used in scan.mjs)`);
    }
    console.log(`    tokens avoided:              ${saved.toLocaleString()} (${pct}%)`);
    console.log('');
  }
}

console.log(`\n📊 Scan token comparison (${ENCODING})\n`);

if (!hasPython3()) {
  fail('python3 not found');
  process.exit(1);
}
pass('python3 available');

const enc = getEncoding(ENCODING);
/** @type {Row[]} */
const rows = [];

try {
  for (const company of COMPANIES) {
    console.log(`\n  ${company.name}...\n`);

    try {
      const parser = runLocalParser(company, enc);
      rows.push({
        company: company.name,
        method: 'local_parser',
        ...parser,
      });
      pass(`${company.name} local_parser: ${parser.jobs} jobs, 0 LLM tokens`);
    } catch (err) {
      fail(`${company.name} local_parser: ${err.message}`);
    }

    try {
      const pw = await runPlaywright(company, enc);
      rows.push({
        company: company.name,
        method: 'playwright_nivel_1',
        ...pw,
      });
      pass(`${company.name} playwright: ~${pw.input_tokens.toLocaleString()} simulated tokens`);
    } catch (err) {
      fail(`${company.name} playwright: ${err.message}`);
    }

    if (company.ashbyApiUrl) {
      try {
        const api = await runAshbyApi(company, enc);
        rows.push({
          company: company.name,
          method: 'api_nivel_2',
          ...api,
        });
        pass(`${company.name} API: ~${api.input_tokens.toLocaleString()} simulated tokens`);
      } catch (err) {
        fail(`${company.name} API: ${err.message}`);
      }
    }

    if (company.websearchFixture) {
      const web = runWebsearchFixtureSync(company.websearchFixture, enc);
      if (web) {
        rows.push({
          company: company.name,
          method: 'websearch_nivel_3',
          ...web,
        });
        pass(`${company.name} websearch fixture: ~${web.input_tokens.toLocaleString()} simulated tokens`);
      }
    }

    const nivelRows = rows.filter(
      r =>
        r.company === company.name &&
        ['playwright_nivel_1', 'api_nivel_2', 'websearch_nivel_3'].includes(r.method),
    );
    const agentSum = nivelRows.reduce((n, r) => n + r.input_tokens, 0);
    const parserRow = rows.find(r => r.company === company.name && r.method === 'local_parser');
    rows.push({
      company: company.name,
      method: 'agent_total_simulated',
      jobs: parserRow?.jobs ?? 'n/a',
      input_tokens: agentSum,
      llm_in_loop: 'simulated',
      notes: 'sum niveles 1+2+3 (no parser)',
    });
  }

  printTable(rows);
  printSavings(rows);

  console.log('='.repeat(52));
  if (failed > 0) {
    console.log(`🔴 ${failed} step(s) failed\n`);
    process.exit(1);
  }
  console.log('🟢 Scan token comparison completed\n');
} finally {
  enc.free();
}
