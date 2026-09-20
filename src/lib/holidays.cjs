'use strict';
// 中国法定节假日 / 调休数据。
//
// 为什么需要它：Kindle 面板的「每天定时开屏（工作日）」如果只按"周一~周五"判断就会错——
// 调休时周末要上班（例如 2026-09-20 周日、2026-10-10 周六），法定假日又可能落在周中。
//
// 数据来自国务院办公厅每年发布的节假日安排（由 NateScarlet/holiday-cn 项目整理成 JSON），
// 取回后归一化缓存到 data/holidays.json：
//   { "_source": "...", "_generatedAt": "...", "days": { "2026-10-01": true, "2026-09-20": false } }
//   days[日期] === true  → 放假（不唤醒）
//   days[日期] === false → 调休上班（照常唤醒）
// 表里没覆盖到的日期由插件按"周一~周五"兜底。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const CACHE_FILE = path.join(ROOT, 'data', 'holidays.json');
const STALE_DAYS = 30; // 缓存多久算过期（过期才去联网取）

const SOURCES = [
  (year) => `https://raw.githubusercontent.com/NateScarlet/holiday-cn/master/${year}.json`,
  (year) => `https://cdn.jsdelivr.net/gh/NateScarlet/holiday-cn@master/${year}.json`,
];

function readCache() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.days === 'object' && parsed.days) return parsed;
  } catch (error) {
    // 缓存不存在或坏了都当没有
  }
  return null;
}

function cacheCoversYears(cache, years) {
  if (!cache) return false;
  const covered = new Set(
    Object.keys(cache.days).map((day) => Number(String(day).slice(0, 4))).filter(Boolean),
  );
  return years.every((year) => covered.has(year));
}

function cacheAgeDays(cache) {
  if (!cache || !cache._generatedAt) return Infinity;
  const at = Date.parse(cache._generatedAt);
  if (Number.isNaN(at)) return Infinity;
  return (Date.now() - at) / 86400000;
}

async function fetchYear(year) {
  let lastError;
  for (const build of SOURCES) {
    const url = build(year);
    try {
      const response = await fetch(url, { headers: { 'User-Agent': 'aiquota-holidays' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (!Array.isArray(payload.days)) throw new Error('数据格式不符（没有 days 数组）');
      return { url, days: payload.days };
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`${year} 年节假日数据获取失败：${lastError && lastError.message}`);
}

// 取回并写入缓存；years 默认"今年 + 明年"
async function fetchHolidays(years) {
  const now = new Date();
  const list = years && years.length ? years : [now.getFullYear()];
  const days = {};
  const sources = [];
  for (const year of list) {
    const { url, days: entries } = await fetchYear(year);
    sources.push(url);
    for (const entry of entries) {
      if (!entry || typeof entry.date !== 'string') continue;
      days[entry.date] = entry.isOffDay === true;
    }
  }
  const payload = {
    _source: sources.join(' , '),
    _generatedAt: new Date().toISOString(),
    _note: 'days[YYYY-MM-DD]=true 表示放假；false 表示调休上班。未列出的日期按周一~周五。',
    days,
  };
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, `${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

// 导出/发布用：今年有数据且缓存不旧就直接用，否则联网补一次（失败也不影响主流程）
async function ensureHolidays(years) {
  const now = new Date();
  const list = years && years.length ? years : [now.getFullYear()];
  const cache = readCache();
  if (cache && cacheCoversYears(cache, list) && cacheAgeDays(cache) < STALE_DAYS) return cache;
  return fetchHolidays(list);
}

// 同步版：只读缓存（导出流程里不想因为网络卡住时用）
function loadHolidayTable() {
  const cache = readCache();
  return cache ? cache.days : {};
}

module.exports = { CACHE_FILE, fetchHolidays, ensureHolidays, loadHolidayTable, readCache };
