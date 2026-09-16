'use strict';

// ChatGPT / OpenAI 平台额度采集器
//
// OpenAI 平台 API 是按量计费（pay-as-you-go），没有 5 小时/每周这种滚动窗口，
// 所以这张卡片组合三个接口，能拿到什么就展示什么：
//
//   GET /v1/organization/costs?start_time=&end_time=&limit=1
//       Costs API —— 本月已用金额（USD）。
//   GET /v1/dashboard/billing/subscription
//       老版账单接口 —— 月度消费上限 hard_limit_usd（部分账号/密钥已不可用，失败就放弃）。
//   GET /v1/dashboard/billing/credit_grants
//       老版账单接口 —— 剩余赠送额度 total_available（同上，失败就放弃）。
//
// 展示规则（能组合出什么就显示什么）：
//   本月已用 + 上限（hard_limit 或配置的 monthlyBudgetUsd）→ “本月”窗口 + 进度条
//   剩余赠送额度                                          → 余额（balance 卡片）
//   只有本月已用                                          → 卡片正文显示“本月已用 $x.xx”
//
// 网络：api.openai.com 在国内通常无法直连，而 Node 的 fetch/undici 不会自动使用
// 系统代理（NODE_USE_ENV_PROXY 还必须在进程启动前就存在于真实环境里）。
// 所以这里对 HTTPS 请求自己实现 HTTP CONNECT 隧道，代理解析顺序：
//   config.proxy > HTTPS_PROXY / HTTP_PROXY 环境变量 > Windows 系统代理（注册表）

const { spawnSync } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const {
  clampPct,
  failedWindows,
  fetchJson,
  isoBeijing,
  safeError,
} = require('../lib/common.cjs');

const DEFAULT_BASE_URL = 'https://api.openai.com';
const REQUEST_TIMEOUT_MS = 15_000;

// ---------------------------------------------------------------- 代理

function normalizeProxyUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  try {
    return /^https?:$/.test(new URL(withScheme).protocol) ? withScheme : '';
  } catch {
    return '';
  }
}

function windowsSystemProxy() {
  if (process.platform !== 'win32') return '';
  try {
    const result = spawnSync('reg', [
      'query',
      'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings',
    ], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    const output = String(result.stdout || '');
    if (!/ProxyEnable\s+REG_DWORD\s+0x1\b/i.test(output)) return '';
    const match = output.match(/ProxyServer\s+REG_SZ\s+(\S+)/i);
    return match ? normalizeProxyUrl(match[1]) : '';
  } catch {
    return '';
  }
}

function resolveProxy(config = {}) {
  return normalizeProxyUrl(config.proxy) ||
    normalizeProxyUrl(process.env.HTTPS_PROXY || process.env.https_proxy) ||
    normalizeProxyUrl(process.env.HTTP_PROXY || process.env.http_proxy) ||
    windowsSystemProxy();
}

function createTunnelAgent(proxyUrl) {
  const proxy = new URL(proxyUrl);
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = function tunnelCreateConnection(options, callback) {
    const host = options.hostname || options.host;
    const port = options.port || 443;
    const authority = `${host}:${port}`;
    const request = http.request({
      host: proxy.hostname,
      port: Number(proxy.port) || 80,
      method: 'CONNECT',
      path: authority,
      headers: { Host: authority },
      timeout: REQUEST_TIMEOUT_MS,
    });
    request.on('connect', (response, socket) => {
      if (response.statusCode !== 200) {
        socket.destroy();
        callback(new Error(`代理 CONNECT 失败：HTTP ${response.statusCode}`));
        return;
      }
      const secure = tls.connect({ socket, servername: host });
      secure.once('secureConnect', () => callback(null, secure));
      secure.once('error', (error) => callback(error));
    });
    request.on('timeout', () => request.destroy(new Error('代理连接超时')));
    request.on('error', (error) => callback(error));
    request.end();
  };
  return agent;
}

function getJson(url, { headers = {}, proxyUrl = '', timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  if (!proxyUrl) return fetchJson(url, { headers, timeoutMs });
  return new Promise((resolve, reject) => {
    const request = https.get(url, {
      headers,
      agent: createTunnelAgent(proxyUrl),
      timeout: timeoutMs,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let payload = null;
        if (text) {
          try {
            payload = JSON.parse(text);
          } catch {
            reject(new Error(`HTTP ${response.statusCode} 返回了非 JSON 数据`));
            return;
          }
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          const message = payload && (payload.message || payload.error && payload.error.message);
          reject(new Error(`HTTP ${response.statusCode}${message ? `：${safeError(message)}` : ''}`));
          return;
        }
        resolve(payload);
      });
    });
    request.on('timeout', () => request.destroy(new Error('请求超时')));
    request.on('error', (error) => reject(error));
  });
}

// ---------------------------------------------------------------- 解析

function monthCostFrom(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const total = Number(payload.total_cost);
  if (Number.isFinite(total)) return total;
  const items = Array.isArray(payload.data) ? payload.data : [];
  if (!items.length) return null;
  return items.reduce((sum, item) => sum + (Number(item && item.total_usage) || 0), 0);
}

function hardLimitFrom(payload) {
  const value = Number(payload && payload.hard_limit_usd);
  return Number.isFinite(value) && value > 0 ? value : null;
}

function availableFrom(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const value = Number(payload.total_available);
  return Number.isFinite(value) ? value : null;
}

function buildOpenAiResult({ costs, subscription, grants, monthlyBudgetUsd, now = new Date() }) {
  const monthCost = monthCostFrom(costs);
  const budget = Number(monthlyBudgetUsd) > 0 ? Number(monthlyBudgetUsd) : hardLimitFrom(subscription);
  const available = availableFrom(grants);

  const windows = [];
  if (Number.isFinite(monthCost) && budget) {
    const nextMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    windows.push({
      name: '本月',
      usedPct: clampPct((monthCost / budget) * 100),
      resetAt: isoBeijing(nextMonth),
      detail: `$${monthCost.toFixed(2)} / $${budget.toFixed(2)}`,
    });
  }
  if (!windows.length && !Number.isFinite(monthCost) && !Number.isFinite(available)) {
    throw new Error('额度响应中没有可识别的字段');
  }

  const result = {
    ok: true,
    label: 'ChatGPT',
    windows,
    fetchedAt: isoBeijing(now),
    error: null,
  };
  if (Number.isFinite(available)) {
    result.balance = Math.round(available * 100) / 100;
    result.currency = 'USD';
    result.detail = Number.isFinite(monthCost)
      ? `本月已用 $${monthCost.toFixed(2)}`
      : '剩余赠送额度';
  } else if (Number.isFinite(monthCost)) {
    result.detail = `本月已用 $${monthCost.toFixed(2)}`;
  }
  return result;
}

// ---------------------------------------------------------------- 采集

async function collectOpenAI(config = {}) {
  const fetchedAt = isoBeijing();
  if (!config.enabled) {
    return { ...failedWindows('ChatGPT', '未启用', fetchedAt), disabled: true };
  }
  const envName = String(config.apiKeyEnv || 'OPENAI_API_KEY');
  const key = String(process.env[envName] || '').trim();
  if (!key) return failedWindows('ChatGPT', `没有设置环境变量 ${envName}`, fetchedAt);

  try {
    const baseUrl = String(config.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
    const proxyUrl = resolveProxy(config);
    const headers = { Authorization: `Bearer ${key}`, Accept: 'application/json' };
    const startEpoch = Math.floor(Date.UTC(
      new Date().getUTCFullYear(),
      new Date().getUTCMonth(),
      1,
    ) / 1000);
    const endEpoch = Math.floor(Date.now() / 1000);

    const costsUrl = `${baseUrl}/v1/organization/costs?start_time=${startEpoch}&end_time=${endEpoch}&limit=1&group_by[]=line_item`;
    const settled = await Promise.allSettled([
      getJson(costsUrl, { headers, proxyUrl }),
      getJson(`${baseUrl}/v1/dashboard/billing/subscription`, { headers, proxyUrl }),
      getJson(`${baseUrl}/v1/dashboard/billing/credit_grants`, { headers, proxyUrl }),
    ]);
    const value = (item) => (item && item.status === 'fulfilled' ? item.value : null);
    const costs = value(settled[0]);
    const subscription = value(settled[1]);
    const grants = value(settled[2]);

    try {
      return buildOpenAiResult({ costs, subscription, grants, monthlyBudgetUsd: config.monthlyBudgetUsd });
    } catch (error) {
      // 三个接口都没给出可识别字段。用量接口(api.usage.read)只授予组织 Owner/自定义角色，
      // 普通用户 key 和项目内服务账号 key 都读不了 —— 这时用 /v1/models 验一下密钥本身，
      // 密钥有效就如实显示"无法读取用量"，密钥无效才报采集失败。
      const allRejected = settled.every((item) => item.status === 'rejected');
      if (!allRejected) throw error;
      const firstReason = settled.find((item) => item.status === 'rejected');
      try {
        await getJson(`${baseUrl}/v1/models`, { headers, proxyUrl });
      } catch {
        throw firstReason ? firstReason.reason : error;
      }
      return {
        ok: true,
        label: 'ChatGPT',
        windows: [],
        fetchedAt: isoBeijing(),
        error: null,
        detail: '密钥有效 · 用量读取需组织 Owner 权限',
      };
    }
  } catch (error) {
    return failedWindows('ChatGPT', error, isoBeijing());
  }
}

module.exports = { buildOpenAiResult, collectOpenAI, resolveProxy };
