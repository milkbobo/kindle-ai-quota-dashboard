'use strict';

// 把额度数据导出成 KOReader 插件（aiquota.koplugin）要的格式。
//
// 用法：
//   1. 先按 config.example.json 建好 config.json，打开 codex / zai 两个数据源
//   2. 设置环境变量：ZAI_API_KEY（z.ai 的 key）。（CODEX_CLI_PATH 只在想固定某个 CLI 时才填，
//      默认由采集器自动发现 Codex 桌面版的 CLI）
//   3. node scripts/export-kindle.cjs
//   4. 把生成的 state/kindle.json 拷到 Kindle 的 /mnt/us/aiquota/data.json
//
// 为什么单独写这个脚本：项目原本的产物（state/data.json）是给 web 前端用的，
// 里面有 4 个固定卡片；这个脚本直接产出插件要的扁平结构，
// 因此**不需要改动项目里任何现有文件**。

const path = require('node:path');
const { collectCodex } = require('../src/collectors/codex.cjs');
const { collectZai } = require('../src/collectors/zai.cjs');
const { ROOT, loadConfig } = require('../src/lib/config.cjs');
const { isoBeijing, writeAtomic } = require('../src/lib/common.cjs');

function shortTime(iso) {
  const match = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  if (!match) return '';
  return `${match[2]}-${match[3]} ${match[4]}:${match[5]}`;
}

function remainingText(usedPct) {
  const used = Math.max(0, Math.min(100, Math.round(Number(usedPct) || 0)));
  return `剩余 ${100 - used}%`;
}

function itemsFromSource(source) {
  if (!source) return [];
  const label = String(source.label || '未知');

  if (source.disabled) {
    return [{ name: label, text: '未启用' }];
  }
  if (!source.ok) {
    return [{ name: label, text: `失败：${source.error || '未知错误'}` }];
  }

  const windows = Array.isArray(source.windows) ? source.windows : [];
  if (!windows.length) return [{ name: label, text: '没有数据' }];

  return windows.map((window) => {
    const used = Math.max(0, Math.min(100, Math.round(Number(window.usedPct) || 0)));
    const parts = [remainingText(window.usedPct)];
    if (window.detail) parts.push(String(window.detail));
    const reset = shortTime(window.resetAt);
    if (reset) parts.push(`${reset} 重置`);
    if (window.stale) parts.push('（缓存）');
    return {
      name: `${label} · ${String(window.name || '额度')}`,
      used,
      detail: parts.join('  '),
    };
  });
}

async function main() {
  const config = loadConfig();
  const providers = config.providers || {};

  const [codex, zai] = await Promise.all([
    collectCodex(providers.codex),
    collectZai(providers.zai),
  ]);

  // 卡片顺序由 config.displayProviders 决定（与网页版同一处配置）：
  // 想换顺序/换展示项只改 config.json，不用动代码。默认 codex → zai。
  const collected = { codex, zai };
  const preferred = (Array.isArray(config.displayProviders) && config.displayProviders.length
    ? config.displayProviders
    : ['codex', 'zai']
  ).filter((name) => collected[name]);
  const order = preferred.length ? preferred : ['codex', 'zai'];
  const items = order.flatMap((name) => itemsFromSource(collected[name]));

  const snapshot = {
    updated: Math.floor(Date.now() / 1000),
    updatedText: isoBeijing().slice(5, 16).replace('T', ' '),
    source: 'export-kindle',
    items,
    quote: '来自电脑端 scripts/export-kindle.cjs',
  };
  delete snapshot.weather;

  // 节假日表（含调休）：插件据此判断"工作日"，决定每天定时开屏要不要触发。
  // 顺手在缓存过期/缺今年数据时补一次（联网失败也不影响发布，插件会退化成"周一~周五"）。
  try {
    const { ensureHolidays, loadHolidayTable } = require('../src/lib/holidays.cjs');
    await ensureHolidays();
    const holidays = loadHolidayTable();
    if (holidays && Object.keys(holidays).length) {
      snapshot.holidays = holidays;
      process.stdout.write(`节假日表已随快照发布（${Object.keys(holidays).length} 条）\n`);
    }
  } catch (error) {
    process.stdout.write(`节假日表暂不可用（用周一~周五兜底）：${error && error.message}\n`);
  }

  const outputDir = config.outputDir || path.join(ROOT, 'state');
  const outFile = path.join(outputDir, 'kindle.json');
  writeAtomic(outFile, `${JSON.stringify(snapshot, null, 2)}\n`);

  const summary = [codex, zai]
    .map((source) => {
      if (!source) return 'unknown';
      if (source.disabled) return `${source.label}:off`;
      return `${source.label}:${source.ok ? 'ok' : 'fail'}`;
    })
    .join(' ');

  process.stdout.write(`updated ${isoBeijing()} ${summary}\n`);
  process.stdout.write(`wrote ${outFile}\n`);
  process.stdout.write('下一步：把该文件拷贝到 Kindle 的 /mnt/us/aiquota/data.json\n');
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error && error.message ? error.message : error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { itemsFromSource };
