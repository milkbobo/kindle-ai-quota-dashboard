'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  demoSnapshot,
  preserveLastKnownGood,
  validateSnapshot,
  writeSnapshot,
} = require('../src/collect.cjs');
const { safeError } = require('../src/lib/common.cjs');
const { buildOpenAiResult, collectOpenAI } = require('../src/collectors/openai.cjs');
const { ROOT, validateConfig } = require('../src/lib/config.cjs');
const { collectProblems } = require('../scripts/check-public.cjs');

test('demo snapshot passes the public schema', () => {
  const snapshot = demoSnapshot();
  assert.doesNotThrow(() => validateSnapshot(snapshot));
  assert.equal(snapshot.weather.place, '示例城市');
  assert.equal(snapshot.sources.deepseek.balance, 12.34);
});

test('last known good data is preserved only for enabled failing providers', () => {
  const previous = demoSnapshot();
  const next = demoSnapshot();
  next.sources.claude = {
    ok: false,
    label: 'Claude',
    windows: [],
    fetchedAt: next.updatedAt,
    error: '临时失败',
  };
  next.sources.kimi = {
    ok: false,
    label: 'Kimi',
    windows: [],
    fetchedAt: next.updatedAt,
    error: '未启用',
    disabled: true,
  };
  preserveLastKnownGood(next, previous);
  assert.equal(next.sources.claude.ok, true);
  assert.equal(next.sources.claude.stale, true);
  assert.equal(next.sources.claude.error, '临时失败');
  assert.equal(next.sources.kimi.ok, false);
  assert.equal(next.sources.kimi.disabled, true);
});

test('safeError removes obvious credential material', () => {
  const secret = 'A'.repeat(90);
  const output = safeError(`authorization: bearer ${secret}`);
  assert.doesNotMatch(output, new RegExp(secret));
  assert.match(output, /已隐藏/);
});

test('config rejects inline secrets but accepts environment variable names', () => {
  assert.doesNotThrow(() => validateConfig({
    providers: { deepseek: { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
  }));
  assert.throws(() => validateConfig({
    providers: { demo: { token: 'this-should-never-be-here' } },
  }), /不允许保存密钥值/);
});

test('snapshot writer emits JSON and old-browser JavaScript', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kindle-quota-test-'));
  try {
    writeSnapshot(demoSnapshot(), dir, false);
    const json = JSON.parse(fs.readFileSync(path.join(dir, 'data.json'), 'utf8'));
    const javascript = fs.readFileSync(path.join(dir, 'data.js'), 'utf8');
    assert.equal(json.sources.codex.ok, true);
    assert.match(javascript, /^window\.DASH_DATA = /);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('browser runtime is valid JavaScript', () => {
  for (const name of ['dashboard-runtime.js', 'pagination.js']) {
    const result = spawnSync(process.execPath, ['--check', path.join(ROOT, 'web', name)], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `${name}: ${result.stderr}`);
  }
});

function runBrowserRuntime(snapshot, storage) {
  const nodes = new Map();
  function node() {
    return {
      textContent: '',
      innerHTML: '',
      className: '',
      style: {},
      getAttribute() { return null; },
      setAttribute() {},
      querySelector() { return node(); },
      querySelectorAll() { return []; },
    };
  }
  function namedNode(name) {
    if (!nodes.has(name)) nodes.set(name, node());
    return nodes.get(name);
  }
  const head = node();
  head.appendChild = (child) => { child.parentNode = head; };
  head.removeChild = (child) => { child.parentNode = null; };
  const document = {
    createElement: () => node(),
    getElementById: (id) => namedNode(`#${id}`),
    getElementsByTagName: () => [head],
    querySelector: (selector) => namedNode(selector),
  };
  const localStorage = {
    getItem: (key) => storage.has(key) ? storage.get(key) : null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  };
  const window = { DASH_DATA: snapshot, localStorage };
  const source = fs.readFileSync(path.join(ROOT, 'web', 'dashboard-runtime.js'), 'utf8');
  vm.runInNewContext(source, {
    window,
    document,
    location: { search: '' },
    setTimeout: () => 1,
  });
  return { nodes, window };
}

test('browser runtime restores a valid cache and rejects older replacement data', () => {
  const storage = new Map();
  const fresh = demoSnapshot();
  runBrowserRuntime(fresh, storage);
  const cacheKey = 'kindle_ai_quota_cache_v1';
  const cached = storage.get(cacheKey);
  assert.ok(cached, 'fresh data should be cached');

  const restored = runBrowserRuntime(null, storage);
  assert.equal(restored.nodes.get('#deepSeekBalance').textContent, '¥ 12.34');

  const older = demoSnapshot();
  older.updatedAt = '2025-01-01T00:00:00+08:00';
  runBrowserRuntime(older, storage);
  assert.equal(storage.get(cacheKey), cached, 'older data must not replace a newer cache');
});

test('dashboard accepts only Codex and Z.ai and renders every quota window', () => {
  const snapshot = demoSnapshot();
  snapshot.sources = { codex: snapshot.sources.codex, zai: snapshot.sources.zai };
  delete snapshot.weather;
  const { nodes } = runBrowserRuntime(snapshot, new Map());
  const html = nodes.get('#quotaGrid').innerHTML;
  assert.match(html, /Codex/);
  assert.match(html, /Z.ai/);
  assert.match(html, /每月工具调用/);
  assert.match(html, /120\/1000 次/);
  assert.equal((html.match(/role="meter"/g) || []).length, 5);
  assert.doesNotMatch(html, /Claude|DeepSeek|Kimi/);
});

test('dashboard distinguishes missing, stale, exhausted and malformed quota data', () => {
  const snapshot = demoSnapshot();
  delete snapshot.sources.zai;
  snapshot.sources.codex.stale = true;
  snapshot.sources.codex.windows[0].usedPct = 100;
  let result = runBrowserRuntime(snapshot, new Map());
  let html = result.nodes.get('#quotaGrid').innerHTML;
  assert.match(html, /未接入/);
  assert.match(html, /旧数据/);
  assert.match(html, /剩余 0%/);
  snapshot.sources.codex.stale = false;
  snapshot.sources.codex.windows[0].detailText = '<script>alert(1)</script>';
  result = runBrowserRuntime(snapshot, new Map());
  html = result.nodes.get('#quotaGrid').innerHTML;
  assert.match(html, /额度紧张/);
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  snapshot.sources.codex.windows[0].usedPct = 101;
  const storage = new Map();
  runBrowserRuntime(snapshot, storage);
  assert.equal(storage.size, 0, 'invalid percentage must not enter the cache');
});

test('displayProviders enables additional services and Z.ai retains last known good quotas', () => {
  const previous = demoSnapshot();
  const snapshot = demoSnapshot();
  snapshot.displayProviders = ['zai', 'codex', 'kimi'];
  snapshot.sources.zai = { ok: false, label: 'Z.ai', windows: [], fetchedAt: snapshot.updatedAt, error: 'timeout' };
  preserveLastKnownGood(snapshot, previous);
  assert.equal(snapshot.sources.zai.stale, true);
  const html = runBrowserRuntime(snapshot, new Map()).nodes.get('#quotaGrid').innerHTML;
  assert.ok(html.indexOf('Z.ai') < html.indexOf('Codex'));
  assert.match(html, /Kimi/);
  assert.throws(() => validateConfig({ displayProviders: 'codex' }), /displayProviders/);
});

test('openai collector reports disabled and missing key without touching the network', async () => {
  const disabled = await collectOpenAI({ enabled: false });
  assert.equal(disabled.ok, false);
  assert.equal(disabled.disabled, true);
  const missing = await collectOpenAI({ enabled: true, apiKeyEnv: 'OPENAI_API_KEY_TEST_MISSING' });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /OPENAI_API_KEY_TEST_MISSING/);
});

test('openai result prefers monthly window, then balance, then usage detail', () => {
  const costs = { total_cost: 3.5 };
  const withLimit = buildOpenAiResult({
    costs,
    subscription: { hard_limit_usd: 50 },
    grants: null,
    now: new Date('2026-09-14T00:00:00Z'),
  });
  assert.equal(withLimit.windows.length, 1);
  assert.equal(withLimit.windows[0].name, '本月');
  assert.equal(withLimit.windows[0].usedPct, 7);
  assert.match(withLimit.windows[0].detail, /\$3\.50 \/ \$50\.00/);

  const withBudget = buildOpenAiResult({ costs, monthlyBudgetUsd: 10 });
  assert.equal(withBudget.windows[0].usedPct, 35);

  const grantsOnly = buildOpenAiResult({ costs: null, grants: { total_available: 6.254 } });
  assert.equal(grantsOnly.ok, true);
  assert.equal(grantsOnly.balance, 6.25);
  assert.equal(grantsOnly.windows.length, 0);

  const costsOnly = buildOpenAiResult({ costs });
  assert.equal(costsOnly.windows.length, 0);
  assert.equal(costsOnly.balance, undefined);
  assert.match(costsOnly.detail, /本月已用 \$3\.50/);

  assert.throws(
    () => buildOpenAiResult({ costs: null, subscription: null, grants: null }),
    /可识别/,
  );
});

test('dashboard renders the ChatGPT card from displayProviders', () => {
  const snapshot = demoSnapshot();
  snapshot.displayProviders = ['openai'];
  const html = runBrowserRuntime(snapshot, new Map()).nodes.get('#quotaGrid').innerHTML;
  assert.match(html, /ChatGPT/);
  assert.match(html, /本月/);
  assert.doesNotMatch(html, /Codex|Z\.ai/);
});

test('public checker skips ignored files on Windows paths but rejects exposed data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kindle-public-check-'));
  try {
    const initialized = spawnSync('git', ['init', '--quiet'], { cwd: dir, encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    fs.writeFileSync(path.join(dir, '.gitignore'), 'config.json\nprivate/\n.env\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'config.json'), '{"providers":{}}\n', 'utf8');
    fs.mkdirSync(path.join(dir, 'private'));
    fs.writeFileSync(path.join(dir, 'private', 'config.json'), '{"private":true}\n', 'utf8');
    const localSecret = ['API', '_KEY=', '"', 'this-is-a-local-secret', '"\n'].join('');
    fs.writeFileSync(path.join(dir, '.env'), localSecret, 'utf8');
    assert.deepEqual(collectProblems(dir), []);

    fs.writeFileSync(path.join(dir, 'data.json'), '{"public":true}\n', 'utf8');
    assert.ok(
      collectProblems(dir).some((problem) => problem.includes('data.json')),
      'unignored runtime data should be rejected',
    );

    const exposedSecret = ['API', '_KEY=', '"', 'this-is-an-exposed-secret', '"\n'].join('');
    fs.writeFileSync(path.join(dir, 'credentials.txt'), exposedSecret, 'utf8');
    assert.ok(
      collectProblems(dir).some((problem) => problem.includes('credentials.txt')),
      'unignored secrets should still be rejected',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
