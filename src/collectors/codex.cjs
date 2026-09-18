'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  clampPct,
  failedWindows,
  isoBeijing,
} = require('../lib/common.cjs');

// 只有"这个文件根本跑不起来"才值得换下一个候选。跑起来之后报的错
// （网络不通、鉴权失效）是真实的业务错误，换多少个 CLI 都一样。
const UNUSABLE_BINARY_CODES = new Set(['ENOENT', 'EPERM', 'EACCES']);

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function existingFiles(candidates) {
  return candidates.filter((file) => {
    try {
      return fs.statSync(file).isFile();
    } catch {
      return false;
    }
  });
}

function newestFirst(files) {
  return files
    .map((file) => {
      try {
        return { file, mtime: fs.statSync(file).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => right.mtime - left.mtime)
    .map((item) => item.file);
}

// Codex 桌面版每次升级都会换掉 exe 所在目录：内置包带版本号
// （WindowsApps/OpenAI.Codex_<版本>_...）、它自己下载的 CLI 带哈希，
// 所以这里不写死任何路径，只按"能执行的概率"给出候选，由调用方逐个尝试。
function discoverCodexExecutables() {
  const home = os.homedir();
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';

  // 桌面版下载的 CLI：<LocalAppData>\OpenAI\Codex\bin\<哈希>\codex.exe
  const binRoot = path.join(localAppData, 'OpenAI', 'Codex', 'bin');
  const downloaded = [];
  for (const entry of safeReaddir(binRoot)) {
    downloaded.push(path.join(binRoot, entry, 'codex.exe'));
  }

  // 桌面版内置的 exe。WindowsApps 的 ACL 通常直接拒绝第三方进程执行，
  // 所以即使它是版本最新的，也排到最后再试。
  const packagesRoot = path.join(programFiles, 'WindowsApps');
  const bundled = [];
  for (const entry of safeReaddir(packagesRoot)) {
    if (/^OpenAI\.Codex_/i.test(entry)) {
      bundled.push(path.join(packagesRoot, entry, 'app', 'resources', 'codex.exe'));
    }
  }

  // 桌面版留给沙箱用的固定名字副本（路径稳定，但可能会停在旧版本）。
  const sandboxCopy = existingFiles([
    path.join(home, '.codex', '.sandbox-bin', 'codex.exe'),
  ]);

  return [
    ...newestFirst(existingFiles(downloaded)),
    ...sandboxCopy,
    ...newestFirst(existingFiles(bundled)),
  ];
}

// 显式指定优先（config.json 的 executable、环境变量），其次自动发现，最后交给 PATH。
function resolveCodexCandidates(config = {}) {
  const envName = String(config.executableEnv || 'CODEX_CLI_PATH');
  const ordered = [
    process.env[envName],
    config.executable,
    ...discoverCodexExecutables(),
    'codex',
  ];
  const candidates = [];
  for (const value of ordered) {
    const item = String(value || '').trim();
    if (item && !candidates.includes(item)) candidates.push(item);
  }
  return candidates;
}

function readCodexRateLimits(executable, timeoutMs = 20_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['app-server', '--listen', 'stdio://'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeout = setTimeout(() => finish(new Error('Codex app-server 查询超时')), timeoutMs);

    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { child.kill(); } catch {}
      if (error) reject(error);
      else resolve(value);
    }

    function send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }

    child.on('error', finish);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-1200); });
    child.on('exit', (code) => {
      if (!settled) finish(new Error(stderr.trim() || `Codex app-server 提前退出（${code}）`));
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      while (stdout.includes('\n')) {
        const end = stdout.indexOf('\n');
        const line = stdout.slice(0, end).trim();
        stdout = stdout.slice(end + 1);
        if (!line) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) return finish(new Error(message.error.message || 'Codex 初始化失败'));
          send({ method: 'initialized', params: {} });
          send({ method: 'account/rateLimits/read', id: 2, params: null });
        } else if (message.id === 2) {
          if (message.error) return finish(new Error(message.error.message || 'Codex 额度查询失败'));
          return finish(null, message.result || {});
        }
      }
    });
    send({
      method: 'initialize',
      id: 1,
      params: {
        clientInfo: {
          name: 'kindle-ai-quota-dashboard',
          title: 'Kindle AI 额度中控台',
          version: '0.1.0',
        },
        capabilities: null,
      },
    });
  });
}

function durationName(minutes, fallback) {
  const value = Number(minutes);
  if (value === 300) return '5小时';
  if (value === 10_080) return '周';
  if (value > 0 && value % 10_080 === 0) return `${value / 10_080}周`;
  if (value > 0 && value % 1_440 === 0) return `${value / 1_440}天`;
  if (value > 0 && value % 60 === 0) return `${value / 60}小时`;
  return fallback;
}

function formatCodexWindows(payload, fetchedAt) {
  const byId = payload && payload.rateLimitsByLimitId;
  const bucket = byId && (byId.codex || Object.values(byId)[0]) || payload.rateLimits;
  if (!bucket) throw new Error('Codex 响应中没有 rateLimits');
  const windows = [];
  for (const [key, fallback] of [['primary', '5小时'], ['secondary', '周']]) {
    const item = bucket[key];
    if (!item) continue;
    const used = Number(item.usedPercent);
    if (!Number.isFinite(used)) continue;
    windows.push({
      name: durationName(item.windowDurationMins, fallback),
      usedPct: clampPct(used),
      resetAt: item.resetsAt ? isoBeijing(Number(item.resetsAt) * 1000) : null,
    });
  }
  if (!windows.length) throw new Error('Codex 响应中没有可识别的额度窗口');
  return { ok: true, label: 'Codex', windows, fetchedAt, error: null };
}

async function collectCodex(config = {}) {
  const fetchedAt = isoBeijing();
  if (!config.enabled) {
    return { ...failedWindows('Codex', '未启用', fetchedAt), disabled: true };
  }
  if (config.experimental !== true) {
    return failedWindows('Codex', '必须显式开启 experimental', fetchedAt);
  }
  const timeoutMs = Number(config.timeoutMs || 20_000);
  const candidates = resolveCodexCandidates(config);
  let unusable = 0;
  for (const executable of candidates) {
    try {
      const payload = await readCodexRateLimits(executable, timeoutMs);
      return formatCodexWindows(payload, fetchedAt);
    } catch (error) {
      // 候选压根起不来（不存在 / 被 ACL 拒绝）就试下一个；
      // 能起来说明 CLI 找对了，此时的错误直接上报，不再继续换。
      if (!UNUSABLE_BINARY_CODES.has(error && error.code)) {
        return failedWindows('Codex', error, fetchedAt);
      }
      unusable += 1;
      process.stderr.write(`codex: 跳过不可用的 CLI ${executable}（${error.code}）\n`);
    }
  }
  // 错误信息会进公开的看板快照，所以只说"试了几个位置"，具体路径只写本地 stderr。
  return failedWindows('Codex', `找不到可用的 Codex CLI（已尝试 ${unusable} 个位置）`, fetchedAt);
}

module.exports = {
  collectCodex,
  discoverCodexExecutables,
  durationName,
  formatCodexWindows,
  readCodexRateLimits,
  resolveCodexCandidates,
};
