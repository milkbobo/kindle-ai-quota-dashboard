'use strict';

// 把仪表盘站点发布到 GitHub Pages：
//
//   node scripts/deploy-pages.cjs     （或 npm run deploy）
//
// 做三件事：
//   1. 重新构建 dist/（web 页面 + 最新 state/data.js，保证与本地采集一致）
//   2. 在 dist 里做一次孤儿提交，强推到 origin 的 gh-pages 分支
//      （每次都是单提交的干净历史，data 每隔几分钟更新也不会撑爆仓库体积）
//   3. 如果装了 gh CLI，顺手确认仓库 Pages 已指向 gh-pages 分支
//
// 前提：origin 远程指向你的 GitHub 仓库，且本机能推送（SSH key 或 gh 登录）。
// 发布出去的数据只有额度百分比和时间，不含任何密钥（见 docs/privacy.md）。

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

function run(cmd, args, cwd) {
  const result = spawnSync(cmd, args, { cwd: cwd || ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} 失败：${(result.stderr || result.stdout || '').slice(0, 400)}`);
  }
  return result;
}

function repoSlug(remoteUrl) {
  const match = String(remoteUrl).match(/[/:]([^/:]+\/[^/.]+)(?:\.git)?$/);
  if (!match) throw new Error(`无法从远程地址解析仓库名：${remoteUrl}`);
  return match[1];
}

function main() {
  run(process.execPath, ['scripts/build-site.cjs']);

  fs.rmSync(path.join(DIST, '.git'), { recursive: true, force: true });
  run('git', ['init', '--quiet', '-b', 'gh-pages'], DIST);
  run('git', ['add', '-A'], DIST);
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16);
  run('git', [
    '-c', 'user.name=quota-deploy',
    '-c', 'user.email=deploy@localhost',
    'commit', '--quiet', '-m', `deploy ${stamp}`,
  ], DIST);
  const remote = run('git', ['remote', 'get-url', 'origin']).stdout.trim();
  run('git', ['push', '--force', remote, 'gh-pages'], DIST);
  process.stdout.write(`已推送 gh-pages → ${remote}\n`);

  const slug = repoSlug(remote);
  const pages = spawnSync('gh', ['api', `repos/${slug}/pages`, '-X', 'POST',
    '-f', 'source[branch]=gh-pages', '-f', 'source[path]='], { encoding: 'utf8' });
  if (pages.status === 0) {
    process.stdout.write('GitHub Pages 已开启\n');
  } else if (/Conflict|already/i.test(`${pages.stderr}`)) {
    process.stdout.write('GitHub Pages 已存在（保持原配置）\n');
  } else {
    process.stdout.write('提示：没能自动配置 Pages，请到仓库 Settings → Pages 手动选择 gh-pages 分支\n');
  }
  process.stdout.write(`页面地址：https://${slug.split('/')[0]}.github.io/${slug.split('/')[1]}/\n`);

  // KOReader 插件的备用镜像走 jsDelivr 的 GitHub 缓存（长 TTL），
  // 推送后主动 purge 一次，尽量让镜像和 Pages 保持同步；失败不影响发布。
  const mirrors = [
    `https://purge.jsdelivr.net/gh/${slug}@gh-pages/kindle.json`,
    `https://purge.jsdelivr.net/gh/${slug}@gh-pages/dashboard-gray.png`,
  ];
  for (const url of mirrors) {
    const purged = spawnSync(process.execPath, ['-e',
      `fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(8000)}).then(()=>0,()=>1)`,
    ], { encoding: 'utf8', timeout: 12000 });
    process.stdout.write(purged.status === 0 ? `镜像缓存已刷新 ${url}\n` : `镜像刷新跳过 ${url}\n`);
  }
}

main();
