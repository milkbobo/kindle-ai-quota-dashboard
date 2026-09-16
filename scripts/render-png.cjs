'use strict';

// 用电脑上的 Chrome / Edge，把 web/ 前端渲染成 Kindle 尺寸的 PNG。
//
//   node scripts/render-png.cjs
//   node scripts/render-png.cjs --width 1072 --height 1448 --no-gray
//
// 产出：
//   state/dashboard.png        彩色
//   state/dashboard-gray.png   8bit 灰阶 + 256 级灰阶调色板（eips 认的格式）
//
// 实现说明：
//   不用 `--screenshot` 那个命令行开关，因为它和页面的异步 fetch 抢时间 ——
//   前端是 fetch('data.js') 之后才渲染的，命令行截图往往只拿到一张白图。
//   改成用 CDP：等 load 事件 + 固定等待渲染，再 Page.captureScreenshot，
//   结果确定、也快（约 5 秒）。
//
// 不黑闪的关键不在渲染，在**显示**：
//   eips -g <png>       -> update_mode=PARTIAL  不黑闪
//   eips -f -g <png>    -> update_mode=FULL     黑闪一次

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function argValue(name, fallback) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const WIDTH = Number(argValue('--width', '1072'));
const HEIGHT = Number(argValue('--height', '1448'));
// Layout follows the viewport at both native resolution and scaled CSS pixels.
const DPR = Number(argValue('--dpr', '1.5'));
const OUT = path.resolve(ROOT, argValue('--out', path.join('state', 'dashboard.png')));
const GRAY_OUT = path.resolve(ROOT, argValue('--gray-out', path.join('state', 'dashboard-gray.png')));
const DO_GRAY = !process.argv.includes('--no-gray');
const RENDER_SETTLE_MS = Number(argValue('--settle', '3000'));

const BROWSERS = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
  for (const candidate of BROWSERS) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function buildSiteDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiquota-site-'));
  fs.cpSync(path.join(ROOT, 'web'), dir, { recursive: true });
  for (const name of ['data.js', 'data.json']) {
    const from = path.join(ROOT, 'state', name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(dir, name));
  }
  return dir;
}

function startServer(dir) {
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'index.html';
    const target = path.join(dir, rel);
    if (!target.startsWith(dir) || !fs.existsSync(target) || fs.statSync(target).isDirectory()) {
      res.writeHead(404).end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream' });
    res.end(fs.readFileSync(target));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

// ------------------------------------------------------------------ CDP
async function waitForDevToolsPort(profileDir, timeoutMs = 25000) {
  const file = path.join(profileDir, 'DevToolsActivePort');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (fs.existsSync(file)) {
      const port = Number(fs.readFileSync(file, 'utf8').split('\n')[0]);
      if (port) return port;
    }
    await sleep(120);
  }
  throw new Error('浏览器没起来（DevToolsActivePort 未生成）');
}

function openCdp(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    let nextId = 1;
    const pending = new Map();
    const listeners = [];
    ws.addEventListener('open', () => {
      resolve({
        send(method, params) {
          const id = nextId++;
          return new Promise((res, rej) => {
            pending.set(id, { res, rej });
            ws.send(JSON.stringify({ id, method, params: params || {} }));
          });
        },
        on(fn) { listeners.push(fn); },
        close() { try { ws.close(); } catch { /* ignore */ } },
      });
    });
    ws.addEventListener('error', (e) => reject(new Error(`CDP 连接失败: ${e.message || e.type}`)));
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(msg.error.message));
        else res(msg.result);
      } else if (msg.method) {
        for (const fn of listeners) fn(msg);
      }
    });
  });
}

async function renderWithCdp(browser, url, profileDir) {
  const child = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--remote-debugging-port=0',
    `--user-data-dir=${profileDir}`,
    `--window-size=${Math.round(WIDTH / DPR)},${Math.round(HEIGHT / DPR)}`,
    'about:blank',
  ], { stdio: 'ignore' });

  try {
    const port = await waitForDevToolsPort(profileDir);
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((t) => t.type === 'page');
    if (!page) throw new Error('没有可用的 page target');

    const client = await openCdp(page.webSocketDebuggerUrl);
    let loaded = false;
    client.on((msg) => { if (msg.method === 'Page.loadEventFired') loaded = true; });

    await client.send('Page.enable');
    // 强制亮色主题：Chrome 无头模式会自作主张套"强制暗色"，把 #f3f3ef 的浅底翻成黑底。
    try {
      await client.send('Emulation.setAutoDarkModeOverride', { enabled: false });
    } catch { /* 老版本不支持，忽略 */ }
    try {
      await client.send('Emulation.setEmulatedMedia', {
        media: 'screen',
        features: [{ name: 'prefers-color-scheme', value: 'light' }],
      });
    } catch { /* 同上 */ }
    const cssWidth = Math.round(WIDTH / DPR);
    const cssHeight = Math.round(HEIGHT / DPR);
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: cssWidth, height: cssHeight, deviceScaleFactor: DPR, mobile: false,
    });
    await client.send('Page.navigate', { url });

    const started = Date.now();
    while (!loaded && Date.now() - started < 15000) await sleep(100);
    await sleep(RENDER_SETTLE_MS);      // 等前端把异步拉到的数据画上去

    if (process.argv.includes('--verify-layout')) {
      const checked = await client.send('Runtime.evaluate', { returnByValue: true, expression: `(() => {
        const errors = [];
        const verify = () => {
          if (document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth) errors.push('document overflow');
          for (const el of document.querySelectorAll('.dashboard, .q-card, .q-head, .q-row, .q-label, .q-bar, .q-refresh, .pagination, .footer')) {
            if (!el.getClientRects().length) continue;
            const r = el.getBoundingClientRect();
            if (r.left < -1 || r.top < -1 || r.right > innerWidth + 1 || r.bottom > innerHeight + 1) errors.push(el.className + ' outside viewport');
            const card = el.closest('.q-card');
            if (card && el !== card) { const c = card.getBoundingClientRect(); if (r.bottom > c.bottom + 1 || r.right > c.right + 1) errors.push(el.className + ' outside card'); }
          }
        };
        verify();
        const grid = document.getElementById('quotaGrid');
        const saved = grid.innerHTML;
        const sample = grid.querySelector('.q-card');
        if (sample && sample.querySelector('.q-row')) {
          grid.innerHTML = '';
          const card = sample.cloneNode(true);
          const row = card.querySelector('.q-row').cloneNode(true);
          card.querySelectorAll('.q-row').forEach(el => el.remove());
          for (let i = 0; i < 9; i++) { const r = row.cloneNode(true); r.querySelector('.q-refresh').textContent = '很长的额度说明'.repeat(80); card.appendChild(r); }
          grid.appendChild(card); window.layoutQuotaPages();
          if (grid.children.length !== 5) errors.push('quota windows lost');
          for (let i = 0; i < 3; i++) { verify(); document.getElementById('nextPage').click(); }
          if (document.getElementById('pageLabel').textContent !== '3 / 3') errors.push('pagination failed');
        }
        grid.innerHTML = saved; window.layoutQuotaPages();
        while (!document.getElementById('prevPage').disabled) document.getElementById('prevPage').click();
        return errors;
      })()` });
      const errors = checked.result.value;
      if (!Array.isArray(errors) || errors.length) throw new Error('Layout verification failed: ' + JSON.stringify(checked));
      process.stdout.write('布局检查通过：屏幕边界、卡片边界、9 个窗口分页、超长文本\n');
    }
    const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
    client.close();
    return { loaded, bytes: fs.statSync(OUT).size };
  } finally {
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  }
}

// ------------------------------------------------------------------ 灰阶
function toGrayscalePng(input, output) {
  const script = `
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile('${input.replace(/'/g, "''")}')
$bmp = New-Object System.Drawing.Bitmap $src.Width, $src.Height, ([System.Drawing.Imaging.PixelFormat]::Format8bppIndexed)
$pal = $bmp.Palette
for ($i = 0; $i -lt 256; $i++) { $pal.Entries[$i] = [System.Drawing.Color]::FromArgb(255, $i, $i, $i) }
$bmp.Palette = $pal
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.DrawImage($src, 0, 0, $src.Width, $src.Height)
$bmp.Save('${output.replace(/'/g, "''")}', [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose(); $src.Dispose()
`;
  const tmp = path.join(os.tmpdir(), `aiquota-gray-${process.pid}.ps1`);
  fs.writeFileSync(tmp, script, 'utf8');
  const result = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tmp], {
    encoding: 'utf8', windowsHide: true,
  });
  fs.rmSync(tmp, { force: true });
  if (result.status !== 0) throw new Error(`灰阶转换失败：${result.stderr || result.stdout || result.status}`);
}

// ------------------------------------------------------------------ main
async function main() {
  const browser = findBrowser();
  if (!browser) throw new Error('没找到 Chrome 或 Edge');
  if (typeof WebSocket === 'undefined') throw new Error('当前 Node 没有内置 WebSocket，请用 Node 22+');

  const siteDir = buildSiteDir();
  const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiquota-profile-'));
  const { server, port } = await startServer(siteDir);
  const url = `http://127.0.0.1:${port}/`;
  process.stdout.write(`浏览器 ${path.basename(browser)}  尺寸 ${WIDTH}x${HEIGHT}\n`);

  const t0 = Date.now();
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    const result = await renderWithCdp(browser, url, profileDir);
    process.stdout.write(`彩色图 ${OUT}  ${(result.bytes / 1024).toFixed(1)} KB  load=${result.loaded}  ${Date.now() - t0}ms\n`);
    if (DO_GRAY) {
      toGrayscalePng(OUT, GRAY_OUT);
      process.stdout.write(`灰阶图 ${GRAY_OUT}  ${(fs.statSync(GRAY_OUT).size / 1024).toFixed(1)} KB\n`);
    }
  } finally {
    server.close();
    // 临时目录清理失败（比如 Chrome 的 Crashpad 文件还锁着）不该让整个命令失败
    for (const dir of [siteDir, profileDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      } catch { /* 留给系统清理 */ }
    }
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${(error && error.message) || error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { toGrayscalePng };
