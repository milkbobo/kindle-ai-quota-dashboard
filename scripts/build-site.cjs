'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { ROOT } = require('../src/lib/config.cjs');

const webDir = path.join(ROOT, 'web');
const stateDir = path.join(ROOT, 'state');
const distDir = path.join(ROOT, 'dist');
const required = ['index.html', 'dashboard-runtime.js', 'pagination.js', 'style.css'];

for (const name of required) {
  const source = path.join(webDir, name);
  if (!fs.existsSync(source)) throw new Error(`缺少网页文件：${source}`);
}
for (const name of ['data.js']) {
  const source = path.join(stateDir, name);
  if (!fs.existsSync(source)) {
    throw new Error(`缺少 ${source}。先运行 npm run demo 或 npm run collect`);
  }
}

fs.mkdirSync(distDir, { recursive: true });
// 保留目录本身，避免 Windows 中终端占用 dist 时无法删除目录。
for (const name of fs.readdirSync(distDir)) {
  fs.rmSync(path.join(distDir, name), { recursive: true, force: true });
}
for (const name of required) {
  fs.copyFileSync(path.join(webDir, name), path.join(distDir, name));
}
for (const name of ['data.js']) {
  fs.copyFileSync(path.join(stateDir, name), path.join(distDir, name));
}
// 仅发布展示所需文件；原始 data.json 和彩色 dashboard.png 留在 state/。
// 保留插件同步 JSON 和灰阶图片入口。
for (const name of ['kindle.json', 'dashboard-gray.png']) {
  const source = path.join(stateDir, name);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(distDir, name));
}
const endpoint = process.env.DASHBOARD_URL
  ? process.env.DASHBOARD_URL.replace(/\/+$/, '') + '/data.js'
  : 'data.js';
fs.writeFileSync(path.join(distDir, 'live-endpoint.js'),
  `window.DASH_LIVE_ENDPOINT = '${endpoint}';\n`, 'utf8');
fs.writeFileSync(path.join(distDir, '.nojekyll'), '', 'utf8');
process.stdout.write(`built ${distDir}\n`);
