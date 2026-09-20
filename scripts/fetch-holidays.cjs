'use strict';
// 手动刷新节假日数据：npm run holidays [年份...]
// 数据写到 data/holidays.json，随 npm run refresh 一起发布给 Kindle（快照里的 holidays 字段）。
const { fetchHolidays, CACHE_FILE } = require('../src/lib/holidays.cjs');

function parseYears(argv) {
  const years = argv.map((v) => Number(v)).filter((v) => Number.isInteger(v) && v > 2000);
  return years.length ? years : undefined;
}

async function main() {
  const years = parseYears(process.argv.slice(2));
  const payload = await fetchHolidays(years);
  const entries = Object.entries(payload.days);
  const off = entries.filter(([, isOff]) => isOff);
  const work = entries.filter(([, isOff]) => !isOff);
  process.stdout.write(`已写入 ${CACHE_FILE}\n`);
  process.stdout.write(`  覆盖年份: ${[...new Set(entries.map(([d]) => d.slice(0, 4)))].sort().join(', ')}\n`);
  process.stdout.write(`  放假 ${off.length} 天 / 调休上班 ${work.length} 天\n`);
  process.stdout.write(`  调休上班（周末要上班的日子）: ${work.map(([d]) => d).join(' ') || '（无）'}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error && error.message ? error.message : error}\n`);
  process.exitCode = 1;
});
