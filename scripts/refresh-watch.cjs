'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const args = process.argv.slice(2);
// Also accept a separator passed directly by an npm script or IDE.
if (args[0] === '--') args.shift();
if (args.length === 1 && args[0] === '--help') {
  console.log('用法：npm run refresh:watch -- [间隔分钟数]（默认 10 分钟）');
  process.exit(0);
}
const minutes = args.length ? Number(args[0]) : 10;
if (args.length > 1 || !Number.isFinite(minutes) || minutes <= 0 || minutes * 60000 > 2147483647) {
  console.error('间隔必须是大于 0、不超过 35791 分钟的数字。');
  process.exit(1);
}

const root = path.resolve(__dirname, '..');
let stopping = false;
let timer;
let active = false;
function log(message) {
  console.log(`[${new Date().toLocaleString('zh-CN', { hour12: false })}] ${message}`);
}

function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  log(active ? '停止定时任务，等待当前刷新结束。' : '已停止定时任务。');
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

async function refresh() {
  active = true;
  log('开始采集并上传');
  const ok = await new Promise((resolve) => {
    // npm_execpath lets Node invoke npm on Windows without quoting npm.cmd.
    const npm = process.env.npm_execpath;
    const child = npm
      ? spawn(process.execPath, [npm, 'run', 'refresh'], { cwd: root, stdio: 'inherit' })
      : null;
    if (!child) {
      console.error('请通过 npm run refresh:watch 启动。');
      stopping = true;
      process.exitCode = 1;
      resolve(false);
      return;
    }
    child.on('error', (error) => {
      console.error(`无法启动刷新：${error.message}`);
      resolve(false);
    });
    child.on('close', (code) => resolve(code === 0));
  });
  active = false;
  log(ok ? '本轮刷新上传完成' : '本轮失败，请检查上方日志');
  if (stopping) return;
  log(`${minutes} 分钟后再次刷新（Ctrl+C 停止）`);
  timer = setTimeout(refresh, minutes * 60000);
}

log(`持续刷新已启动，每轮结束后间隔 ${minutes} 分钟`);
refresh();
