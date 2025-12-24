const fs = require('fs');
const path = require('path');
const BASE = process.env.TEST_BASE_URL || 'http://localhost:3000';
let fetch;
let API;

async function loadTestCases() {
  const md = fs.readFileSync(path.join(__dirname, '..', 'TEST_CASES.md'), 'utf8');
  const jsonBlock = md.match(/```json\r?\n([\s\S]*?)\r?\n```/);
  if (!jsonBlock) throw new Error('JSON test block not found in TEST_CASES.md');
  const arr = JSON.parse(jsonBlock[1]);
  return arr;
}

async function checkNoFrontendKeys() {
  // Scan front-end files in this TruthGazette folder for literal API keys or provider key patterns
  const scanDir = path.join(__dirname, '..');
  const patterns = [ /AIza[0-9A-Za-z_\-]{7,}/g, /['\"]sk-[A-Za-z0-9_\-]{20,}['\"]/g, /GEMINI_API_KEY/g ];
  const badFiles = [];

  function walk(dir) {
    const items = fs.readdirSync(dir);
    for (const it of items) {
      const full = path.join(dir, it);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        if (it === 'node_modules' || it === '.git' || it === 'test') continue;
        walk(full);
      } else if (/\.(html|js|jsx|ts|tsx)$/.test(it)) {
        const txt = fs.readFileSync(full, 'utf8');
        for (const p of patterns) {
          if (p.test(txt)) {
            badFiles.push({ file: full, pattern: p.toString() });
          }
        }
      }
    }
  }

  walk(scanDir);
  if (badFiles.length) {
    console.error('Security check failed: Found possible API keys or secret patterns in front-end files:');
    badFiles.forEach(b => console.error(` - ${b.file}  matches ${b.pattern}`));
    console.error('\nPlease remove keys and ensure all provider keys are stored in server environment variables (Vercel).');
    process.exit(2);
  }
  console.log('Security check passed: no literal keys found in front-end files.');
}

function checkUiText() {
  // Static UI checks: ensure required UX text is present and search mechanisms aren't exposed
  const uiFile = path.join(__dirname, '..', 'new.html');
  const txt = fs.readFileSync(uiFile, 'utf8');
  if (!txt.includes('Confidence is derived from source credibility')) {
    console.error('UI check failed: confidence explanation text missing in new.html');
    process.exit(2);
  }
  if (!/Primary & Secondary Sources Reviewed|Referenced Sources/.test(txt)) {
    console.error('UI check failed: sources header not updated in new.html');
    process.exit(2);
  }
  if (/Google Search/.test(txt)) {
    console.error('UI check failed: frontend should not mention Google Search.');
    process.exit(2);
  }
  console.log('UI static checks passed.');
}

async function run() {
  await checkNoFrontendKeys();

  // lazy-load fetch so the security check runs even if deps are missing
  fetch = fetch || require('node-fetch');
  API = `${BASE.replace(/\/$/, '')}/api/investigate`;

  // If REQUIRE_SESSION_ID is set, ensure server rejects requests without session header
  if (process.env.REQUIRE_SESSION_ID === '1') {
    console.log('Testing: REQUIRE_SESSION_ID is enabled — verifying missing session behavior');
    // lazy-load fetch
    fetch = fetch || require('node-fetch');
    API = `${BASE.replace(/\/$/, '')}/api/investigate`;
    const resNoSid = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'test' }) });
    console.log('Missing-session status:', resNoSid.status);
    if (resNoSid.status !== 401) {
      console.error('Server should require session id (401) when REQUIRE_SESSION_ID=1');
      process.exit(2);
    }
    console.log('Session enforcement test passed.');
  }

  // Optional rate-limit test (only run when RUN_RATE_LIMIT_TEST=1)
  if (process.env.RUN_RATE_LIMIT_TEST === '1') {
    console.log('Running rate-limit test against API');
    fetch = fetch || require('node-fetch');
    API = `${BASE.replace(/\/$/, '')}/api/investigate`;
    const limit = 5; // small number for test
    let got429 = false;
    for (let i=0;i<limit+3;i++) {
      const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-TEST-RL-LIMIT': String(limit) }, body: JSON.stringify({ text: 'test', sessionId: 'rate-test' }) });
      console.log('Request', i+1, 'status', r.status);
      if (r.status === 429) { got429 = true; break; }
    }
    if (!got429) {
      console.error('Rate-limit test failed: did not receive 429 after exceeding test limit');
      process.exit(2);
    }
    console.log('Rate-limit test passed.');
  }

  const cases = await loadTestCases();
  let passed = 0;
  for (const c of cases) {
    console.log('---');
    console.log(`Case ${c.id} (${c.type}) - ${c.input}`);
    const body = {
      text: c.input === 'text' ? c.text : '',
      url: c.input === 'url' ? c.url : '',
      image: null,
      sessionId: 'test-runner'
    };
    try {
      const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      console.log('Status:', res.status);
      if (!res.ok) {
        console.log('Error response:', data);
        continue;
      }

      const outVerdict = (data.result?.verdict || '').toUpperCase();
      console.log('Model verdict:', outVerdict, '| Expected:', c.type);
      const pass = (outVerdict === c.type) || (c.type === 'UNCERTAIN' && outVerdict === 'UNCERTAIN');
      console.log('Pass:', pass);
      if (pass) passed++;
    } catch (e) {
      console.error('Request failed:', e.message);
    }
  }

  console.log('---');
  console.log(`Passed ${passed} / ${cases.length}`);
  process.exit(passed === cases.length ? 0 : 2);
}

run();
