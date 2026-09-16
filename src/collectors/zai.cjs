'use strict';

// Z.ai / 智谱 GLM Coding Plan 额度采集器
//
// 官方额度接口（就是 z.ai 订阅页自己用的那两个）：
//   国际版  GET https://api.z.ai/api/monitor/usage/quota/limit
//   国内版  GET https://open.bigmodel.cn/api/monitor/usage/quota/limit
//   认证    Authorization: <API_KEY>
//
// 响应形如：
//   { "code":200, "success":true, "data": {
//       "level": "pro",
//       "limits": [
//         { "type":"TOKENS_LIMIT", "percentage":44, "nextResetTime":1774967594803 },
//         { "type":"TOKENS_LIMIT", "percentage":53, "nextResetTime":1776664808974 },
//         { "type":"TIME_LIMIT", "usage":1000, "currentValue":72, "remaining":928 }
//       ] } }
//
// 说明：
//  - TOKENS_LIMIT 是百分比额度窗口，新套餐有两个（5 小时 + 每周），老套餐只有一个。
//    按 nextResetTime 升序排列后，第一个是 5 小时窗口，第二个（若有）是每周窗口。
//  - TIME_LIMIT 是按次数的每月配额（MCP / 联网搜索 / Zread）。
//  - nextResetTime 是**毫秒**时间戳。

const {
  clampPct,
  failedWindows,
  fetchJson,
  isoBeijing,
} = require('../lib/common.cjs');

const DEFAULT_BASE_URL = 'https://api.z.ai';
const QUOTA_PATH = '/api/monitor/usage/quota/limit';

function planPrefix(level) {
  const value = String(level || '').trim();
  return value ? `${value.toUpperCase()} · ` : '';
}

function resetAtFrom(ms) {
  const value = Number(ms);
  return Number.isFinite(value) && value > 0 ? isoBeijing(value) : null;
}

// 官方没有公开这两种 Authorization 形式到底哪个对，社区两种都有在用，
// 所以先试裸 token，遇到 401/403 再换 Bearer 重试一次。
async function requestQuota(baseUrl, key) {
  const url = `${String(baseUrl).replace(/\/+$/, '')}${QUOTA_PATH}`;
  const attempts = [
    { Authorization: key },
    { Authorization: `Bearer ${key}` },
  ];
  let lastError = null;
  for (const auth of attempts) {
    try {
      return await fetchJson(url, {
        headers: { ...auth, Accept: 'application/json' },
      });
    } catch (error) {
      lastError = error;
      if (!/HTTP (401|403)/.test(String(error && error.message))) throw error;
    }
  }
  throw lastError || new Error('额度接口不可用');
}

async function collectZai(config = {}) {
  const fetchedAt = isoBeijing();
  if (!config.enabled) {
    return { ...failedWindows('Z.ai', '未启用', fetchedAt), disabled: true };
  }
  const envName = String(config.apiKeyEnv || 'ZAI_API_KEY');
  const key = String(process.env[envName] || '').trim();
  if (!key) return failedWindows('Z.ai', `没有设置环境变量 ${envName}`, fetchedAt);

  try {
    const baseUrl = String(config.baseUrl || DEFAULT_BASE_URL);
    const payload = await requestQuota(baseUrl, key);
    if (payload && payload.success === false) {
      throw new Error(String(payload.msg || '额度接口返回失败'));
    }
    const data = payload && payload.data;
    const limits = Array.isArray(data && data.limits) ? data.limits.slice() : [];
    if (!limits.length) throw new Error('额度响应中没有 limits');

    const prefix = planPrefix(data && data.level);

    const tokenLimits = limits
      .filter((item) => item && String(item.type) === 'TOKENS_LIMIT')
      .sort((a, b) => Number(a.nextResetTime || 0) - Number(b.nextResetTime || 0));

    const windows = [];
    if (tokenLimits[0]) {
      windows.push({
        name: `${prefix}5小时`,
        usedPct: clampPct(Number(tokenLimits[0].percentage) || 0),
        resetAt: resetAtFrom(tokenLimits[0].nextResetTime),
      });
    }
    if (tokenLimits[1]) {
      windows.push({
        name: `${prefix}每周`,
        usedPct: clampPct(Number(tokenLimits[1].percentage) || 0),
        resetAt: resetAtFrom(tokenLimits[1].nextResetTime),
      });
    }

    const countLimit = limits.find((item) => item && String(item.type) === 'TIME_LIMIT');
    if (countLimit) {
      const total = Number(countLimit.usage);
      const used = Number(countLimit.currentValue);
      if (Number.isFinite(total) && total > 0 && Number.isFinite(used)) {
        windows.push({
          name: `${prefix}每月次数`,
          usedPct: clampPct((used / total) * 100),
          resetAt: resetAtFrom(countLimit.nextResetTime),
          detail: `${used}/${total}`,
        });
      }
    }

    if (!windows.length) throw new Error('额度响应中没有可识别的时间窗口');
    return { ok: true, label: 'Z.ai', windows, fetchedAt, error: null };
  } catch (error) {
    return failedWindows('Z.ai', error, fetchedAt);
  }
}

module.exports = { collectZai, requestQuota };
