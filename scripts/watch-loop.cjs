'use strict';
// 常驻数据采集器（给"开机自动运行"用）。
//
// 它做的事：
//   1. 启动先自检：state/kindle.json 若在 5 分钟内更新过，说明已经有一个 watch 在跑 → 直接退出，
//      避免开机后又起第二个（两个实例会重复采集、并发推送 gh-pages）。
//   2. 否则就用 `npm run watch` 常驻跑；万一它崩了/被关掉，等 30 秒自动重启。
//   3. 所有输出追加到 logs/refresh-watch.log（logs/ 已在 .gitignore 里）。
//
// 由开机启动项 scripts/start-watch.vbs 静默调用（不弹黑窗）；
// 手动运行也可以：node scripts/watch-loop.cjs
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');
const LOG_FILE = path.join(LOG_DIR, 'refresh-watch.log');
const FRESH_MS = 5 * 60 * 1000; // 快照多久算"刚更新过"→ 说明已有实例
const RETRY_MS = Number(process.env.WATCH_RETRY_MS || 30 * 1000);

function log(message) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
  const stamp = new Date().toLocaleString('zh-CN', { hour12: false });
  fs.appendFileSync(LOG_FILE, `[${stamp}] ${message}\n`);
}

function snapshotIsFresh() {
  try {
    const stat = fs.statSync(path.join(ROOT, 'state', 'kindle.json'));
    return Date.now() - stat.mtimeMs < FRESH_MS;
  } catch (error) {
    return false;
  }
}

if (snapshotIsFresh()) {
  log('检测到 state/kindle.json 刚更新过（5 分钟内）→ 已有 refresh:watch 在跑，本次退出');
  process.exit(0);
}

function runWatcher() {
  return new Promise((resolve) => {
    // Windows 上 npm 是 npm.cmd，交给 shell 解析；输出原样追加到日志
    const child = spawn('npm run watch', { cwd: ROOT, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const append = (chunk) => fs.appendFileSync(LOG_FILE, chunk);
    if (child.stdout) child.stdout.on('data', append);
    if (child.stderr) child.stderr.on('data', append);
    child.on('error', (error) => {
      log(`启动失败：${error.message}`);
      resolve(-1);
    });
    child.on('close', (code) => resolve(code));
  });
}

(async () => {
  log(`=== 常驻采集器启动（本进程 pid ${process.pid}）===`);
  for (;;) {
    const code = await runWatcher();
    log(`npm run watch 已退出（代码 ${code}），${Math.round(RETRY_MS / 1000)} 秒后重启`);
    await new Promise((resolve) => setTimeout(resolve, RETRY_MS));
  }
})();
