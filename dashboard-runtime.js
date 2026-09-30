(function (win, doc) {
  'use strict';

  var settings = {
    fallbackData: 'data.js',
    endpointPointer: 'live-endpoint.js',
    pollEvery: 3 * 60 * 1000,
    pollOffset: 5000,
    cacheKey: 'kindle_ai_quota_cache_v1',
    maxCacheAge: 30 * 60 * 1000,
    quietStart: 3,
    quietEnd: 8
  };
  var state = {
    endpoint: win.DASH_LIVE_ENDPOINT || settings.fallbackData,
    latest: null,
    renderedAt: '',
    usingCache: false,
    requestId: 0
  };
  var defaultProviders = ['codex', 'zai'];
  var weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

  var ui = {
    find: function (id) {
      return doc.getElementById(id);
    },
    textNode: function (node, value) {
      var next = String(value);
      if (node && node.textContent !== next) node.textContent = next;
    },
    text: function (id, value) {
      ui.textNode(ui.find(id), value);
    },
    html: function (node, value) {
      if (node && node.innerHTML !== value) node.innerHTML = value;
    },
    className: function (node, value) {
      if (node && node.className !== value) node.className = value;
    },
    style: function (node, name, value) {
      if (node && node.style[name] !== value) node.style[name] = value;
    },
    attribute: function (node, name, value) {
      var next = String(value);
      if (node && node.getAttribute(name) !== next) node.setAttribute(name, next);
    }
  };

  function twoDigits(value) {
    return value < 10 ? '0' + value : String(value);
  }

  function timestamp(value) {
    var parsed = Date.parse(value || '');
    return isNaN(parsed) ? 0 : parsed;
  }

  function finiteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  }

  function validTime(value, nullable) {
    return nullable && value == null ? true : timestamp(value) > 0;
  }

  function validWindow(value) {
    return !!value &&
      typeof value.name === 'string' &&
      finiteNumber(value.usedPct) &&
      value.usedPct >= 0 && value.usedPct <= 100 &&
      validTime(value.resetAt, true) &&
      (value.barPct == null || (
        finiteNumber(value.barPct) && value.barPct >= 0 && value.barPct <= 100
      ));
  }

  function validSource(name, source) {
    var index;
    if (!source || typeof source.ok !== 'boolean' ||
        typeof source.label !== 'string' || !validTime(source.fetchedAt, false)) return false;
    if (source.error != null && typeof source.error !== 'string') return false;
    if (source.stale != null && typeof source.stale !== 'boolean') return false;
    if (name === 'deepseek') {
      return !source.ok || finiteNumber(source.balance);
    }
    if (name === 'openai') {
      var hasContent = finiteNumber(source.balance) || typeof source.detail === 'string' ||
        (Array.isArray(source.windows) && source.windows.length > 0);
      if (source.ok && !hasContent) return false;
      if (!Array.isArray(source.windows)) return true;
      for (index = 0; index < source.windows.length; index += 1) {
        if (!validWindow(source.windows[index])) return false;
      }
      return true;
    }
    if (!Array.isArray(source.windows)) return false;
    if (source.ok && !source.windows.length) return false;
    for (index = 0; index < source.windows.length; index += 1) {
      if (!validWindow(source.windows[index])) return false;
    }
    return true;
  }

  function validWeather(weather) {
    if (!weather || typeof weather.ok !== 'boolean' || !validTime(weather.fetchedAt, false)) return false;
    if (weather.ok && !finiteNumber(weather.tempC)) return false;
    return true;
  }

  function validPayload(data) {
    var index;
    var sourceNames;
    if (!data || !validTime(data.updatedAt, false) || !data.sources) return false;
    sourceNames = Object.keys(data.sources);
    if (!sourceNames.length) return false;
    for (index = 0; index < sourceNames.length; index += 1) {
      if (!validSource(sourceNames[index], data.sources[sourceNames[index]])) return false;
    }
    return true;
  }

  function readCache() {
    var raw;
    var parsed;
    try {
      raw = win.localStorage && win.localStorage.getItem(settings.cacheKey);
      if (!raw) return null;
      parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== 1 || !validPayload(parsed.payload)) return null;
      if (Date.now() - timestamp(parsed.payload.updatedAt) > settings.maxCacheAge) {
        win.localStorage.removeItem(settings.cacheKey);
        return null;
      }
      return parsed.payload;
    } catch (error) {
      return null;
    }
  }

  function storeCache(data) {
    var cached;
    if (!validPayload(data)) return false;
    cached = readCache();
    if (cached && timestamp(data.updatedAt) < timestamp(cached.updatedAt)) return false;
    try {
      if (win.localStorage) {
        win.localStorage.setItem(settings.cacheKey, JSON.stringify({ version: 1, payload: data }));
      }
    } catch (error) {}
    return true;
  }

  function clockText(value) {
    var date = new Date(value);
    if (isNaN(date.getTime())) return '--:--';
    return twoDigits(date.getHours()) + ':' + twoDigits(date.getMinutes());
  }

  function isQuiet(date) {
    var hour = (date || new Date()).getHours();
    return hour >= settings.quietStart && hour < settings.quietEnd;
  }

  function millisecondsUntilMorning(date) {
    var now = date || new Date();
    var morning = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate(),
      settings.quietEnd,
      0,
      5,
      0
    );
    return Math.max(1000, morning.getTime() - now.getTime());
  }

  function updateFreshness() {
    var lastUpdate = state.latest && state.latest.updatedAt;
    var age = lastUpdate
      ? Math.floor((Date.now() - timestamp(lastUpdate)) / 60000)
      : 99999;
    var lastClock = clockText(lastUpdate);
    var status = ui.find('dataStatus');
    var alert = ui.find('dataAlert');

    if (state.latest) {
      ui.text('relTime', age < 1 ? '刚刚更新' : age + '分钟前更新');
    }

    if (isQuiet()) {
      ui.textNode(status, '夜间省电 · 08:00恢复');
      ui.className(status, '');
      ui.textNode(alert, '');
      ui.className(alert, 'data-alert');
      return;
    }

    if (state.latest && state.usingCache) {
      ui.textNode(status, '缓存 · ' + age + ' 分钟前');
      ui.className(status, 'warn');
      ui.textNode(alert, '网络暂时不可用 · 正在显示最近一次有效数据');
      ui.className(alert, 'data-alert on');
      return;
    }

    if (!state.latest || age > 15) {
      ui.textNode(status, '离线 · 最后 ' + lastClock);
      ui.className(status, 'warn');
      ui.textNode(alert, '电脑或数据链路已离线 · 最后在线 ' + lastClock);
      ui.className(alert, 'data-alert on');
      return;
    }

    if (age >= 7) {
      ui.textNode(status, '延迟 ' + age + ' 分钟 · ' + lastClock);
      ui.className(status, 'warn');
      ui.textNode(alert, '实时数据延迟 ' + age + ' 分钟 · 正在显示最后一次结果');
      ui.className(alert, 'data-alert on');
      return;
    }

    ui.textNode(status, (state.latest.demo ? '演示数据 · ' : '实时 · ') + lastClock);
    ui.className(status, '');
    ui.textNode(alert, '');
    ui.className(alert, 'data-alert');
  }

  function updateClock() {
    var now = new Date();
    ui.text('dtTime', twoDigits(now.getHours()) + ':' + twoDigits(now.getMinutes()));
    ui.text('dtDate', now.getFullYear() + '年' + (now.getMonth() + 1) + '月' + now.getDate() + '日');
    ui.text('dtWeek', weekdays[now.getDay()]);
    updateFreshness();
    if (state.latest) renderProviders(state.latest);
  }

  function queryValue(name) {
    var match = String(location.search || '').match(
      new RegExp('[?&]' + name + '=([^&]*)')
    );
    return match ? decodeURIComponent(match[1]) : null;
  }

  function updateBattery() {
    var percentText = queryValue('battery');
    var chargeText = queryValue('charging');
    var percent = percentText !== null ? Number(percentText) : null;
    var charging = chargeText === '1';
    var device = win.KINDLE_DEVICE;

    if (device) {
      if (typeof device.battery === 'number') percent = device.battery;
      if (typeof device.charging === 'boolean') charging = device.charging;
      if (device.charging === 0 || device.charging === 1) charging = device.charging === 1;
    }
    if (percent === null || isNaN(percent)) return;

    percent = Math.max(0, Math.min(100, percent));
    ui.text('batPct', (charging ? '⚡ ' : '') + percent + '%');
    ui.attribute(ui.find('batFill'), 'width', Math.round(18 * percent / 100));
  }

  function attachScript(url, onSuccess, onFailure) {
    var script = doc.createElement('script');
    script.async = true;
    script.src = url;
    script.onload = function () {
      if (script.parentNode) script.parentNode.removeChild(script);
      if (onSuccess) onSuccess();
    };
    script.onerror = function () {
      if (script.parentNode) script.parentNode.removeChild(script);
      if (onFailure) onFailure();
    };
    doc.getElementsByTagName('head')[0].appendChild(script);
  }

  function requestDeviceStatus() {
    attachScript('device-status.js?_=' + Date.now(), updateBattery);
  }

  function windowTitle(value) {
    var name = String(value || '');
    if (/5小时|5H/i.test(name)) return '5 小时额度';
    if (/7天|周|WEEK/i.test(name)) return '每周额度';
    if (/月|MONTH/i.test(name)) return /次数/.test(name) ? '每月工具调用' : '每月额度';
    return name || 'QUOTA';
  }

  function remainingTime(value) {
    var remaining = timestamp(value) - Date.now();
    var minutes;
    var days;
    var hours;
    if (!value || !timestamp(value)) return '未提供重置时间';
    if (remaining <= 0) return '等待额度重置';

    minutes = Math.ceil(remaining / 60000);
    days = Math.floor(minutes / 1440);
    hours = Math.floor((minutes % 1440) / 60);
    minutes %= 60;
    if (days) return days + '天' + (hours ? hours + '小时' : '') + '后重置';
    if (hours) return hours + '小时' + (minutes ? minutes + '分' : '') + '后重置';
    return minutes + '分钟后重置';
  }

  function showUnavailableQuota(rows) {
    var labels;
    if (!rows.length) return;
    ui.style(rows[0], 'display', 'block');
    labels = rows[0].querySelectorAll('.q-label span');
    if (labels.length > 1) {
      ui.textNode(labels[0], '获取失败');
      ui.textNode(labels[1], '--');
    }
    ui.style(rows[0].querySelector('.q-bar-fill'), 'width', '0%');
    ui.textNode(rows[0].querySelector('.q-refresh'), '↻ 等待下次采集');
  }

  function updateQuotaCard(cardId, source) {
    var card = ui.find(cardId);
    var rows;
    var windows;
    var index;
    if (!card) return;

    rows = card.querySelectorAll('.q-row');
    windows = source && source.ok && source.windows ? source.windows : [];
    for (index = 0; index < rows.length; index += 1) {
      var quotaWindow;
      var labels;
      var percentage;
      if (index >= windows.length) {
        ui.style(rows[index], 'display', 'none');
        continue;
      }

      quotaWindow = windows[index];
      ui.style(rows[index], 'display', 'block');
      labels = rows[index].querySelectorAll('.q-label span');
      if (labels.length > 1) {
        ui.textNode(labels[0], windowTitle(quotaWindow.name));
        ui.textNode(
          labels[1],
          quotaWindow.displayValue != null
            ? String(quotaWindow.displayValue)
            : Math.round(Number(quotaWindow.usedPct) || 0) + '%'
        );
      }

      percentage = quotaWindow.barPct != null
        ? quotaWindow.barPct
        : quotaWindow.usedPct;
      ui.style(
        rows[index].querySelector('.q-bar-fill'),
        'width',
        Math.max(0, Math.min(100, Number(percentage) || 0)) + '%'
      );
      ui.textNode(
        rows[index].querySelector('.q-refresh'),
        ((source.stale || quotaWindow.stale) ? '旧值 · ' : '') +
          (quotaWindow.detailText || remainingTime(quotaWindow.resetAt))
      );
    }
    if (!windows.length) showUnavailableQuota(rows);
  }

  function selectWeatherIcon(key, description) {
    var text = (String(key || '') + ' ' + String(description || '')).toLowerCase();
    if (/thunder|雷/.test(text)) return 'ϟ';
    if (/snow|雪/.test(text)) return '❄';
    if (/rain|wet|雨/.test(text)) return '☂';
    if (/fog|mist|haze|雾/.test(text)) return '≋';
    if (/clear|sun|晴/.test(text)) return '☀';
    return '☁';
  }

  function updateWeather(weather) {
    if (!weather || !weather.ok) return;
    ui.text('weatherTemp', Math.round(Number(weather.tempC)) + '°');
    ui.html(
      ui.find('weatherIcon'),
      '<span style="font-size:30px;line-height:1">' +
        selectWeatherIcon(weather.iconKey, weather.description) +
      '</span>'
    );
    ui.html(
      ui.find('weatherDetail'),
      String(weather.description || '天气') +
        ' · 体感 ' + Math.round(Number(weather.feelsLikeC)) +
        '° · 湿度 ' + Math.round(Number(weather.humidity)) +
        '%<br>风 ' + Math.round(Number(weather.windKph)) +
        'km/h · ' + String(weather.place || '北京') +
        (weather.stale ? '<br>旧值 · 天气源本轮失败' : '')
    );
  }

  function updateBalance(source) {
    if (source && source.ok && typeof source.balance === 'number') {
      ui.text('deepSeekBalance', '¥ ' + Number(source.balance).toFixed(2));
      ui.text('deepSeekDetail', source.stale ? '旧值 · 最近一次成功' : '实时余额 · 按量计费');
      return;
    }
    ui.text('deepSeekBalance', '¥ --');
    ui.text('deepSeekDetail', '获取失败 · 等待下次采集');
  }

  function updateQuote(quote) {
    if (!quote || !quote.text) return;
    ui.textNode(doc.querySelector('.quote-text'), quote.text);
    if (quote.source) {
      ui.textNode(doc.querySelector('.quote-src'), '— ' + quote.source);
    }
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function renderProviders(data) {
    var names = Array.isArray(data.displayProviders) && data.displayProviders.length
      ? data.displayProviders : defaultProviders;
    var labels = { codex: 'Codex', zai: 'Z.ai', claude: 'Claude', kimi: 'Kimi', deepseek: 'DeepSeek', openai: 'ChatGPT' };
    var descriptions = { codex: 'OPENAI / CODEX', zai: 'Z.AI / GLM CODING PLAN', openai: 'OPENAI / API' };
    var html = '';
    var seen = {};
    var count = 0;
    names.forEach(function (name) {
      if (typeof name !== 'string' || Object.prototype.hasOwnProperty.call(seen, name)) return;
      seen[name] = true;
      count += 1;
      var source = data.sources[name];
      var windows = source && source.ok ? source.windows || [] : [];
      var stale = source && (source.stale || Date.now() - timestamp(source.fetchedAt) > 15 * 60000);
      var high = windows.some(function (item) { return item.usedPct >= 90; });
      var status = !source || source.disabled ? '未接入' : !source.ok ? '采集失败' : stale ? '旧数据' : high ? '额度紧张' : '已同步';
      html += '<article class="q-card"><div class="q-head"><div class="q-identity">' +
        '<div class="q-name"><span class="q-number mono">' + twoDigits(count) + '</span>' +
        escapeHtml(labels[name] || (source && source.label) || name) + '</div><div class="q-provider">' +
        escapeHtml(descriptions[name] || 'AI / QUOTA') + '</div></div><div class="q-state"><span class="badge' +
        (stale || high || (source && !source.ok && !source.disabled) ? ' attention' : '') + '">' + status + '</span></div></div>';
      windows.forEach(function (item) {
        var pct = Math.round(item.usedPct);
        html += '<div class="q-row"><div class="q-label"><span>' + escapeHtml(windowTitle(item.name)) +
          '</span><span class="q-pct mono">' + pct + '%</span></div><div class="q-bar" role="meter" aria-label="' +
          escapeHtml(item.name) + ' 已用额度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct +
          '"><div class="q-bar-fill" style="width:' + item.usedPct + '%"></div></div><div class="q-refresh">' +
          '剩余 ' + Math.round(100 - item.usedPct) + '% · ' + escapeHtml(remainingTime(item.resetAt)) +
          (item.detail || item.detailText ? ' · ' + escapeHtml(item.detail || item.detailText) : '') +
          (stale || item.stale ? ' · 最近一次有效值' : '') + '</div></div>';
      });
      if (!windows.length) {
        var mainText = source && source.ok && finiteNumber(source.balance)
          ? escapeHtml(source.currency || 'CNY') + ' ' + source.balance.toFixed(2)
          : source && source.ok && typeof source.detail === 'string'
            ? escapeHtml(source.detail)
            : '--';
        var subText = !source || source.disabled
          ? '等待接入 · 尚无额度数据'
          : !source.ok
            ? '暂时无法获取额度 · 等待下次采集'
            : finiteNumber(source.balance) ? '账户余额' : '按量计费 · 无固定额度窗口';
        html += '<div class="q-empty"><strong class="mono">' + mainText +
          '</strong><div class="q-refresh">' + escapeHtml(subText) + '</div></div>';
      }
      html += '</article>';
    });
    ui.html(ui.find('quotaGrid'), html);
    ui.text('providerCount', twoDigits(count) + ' 项服务');
    if (win.layoutQuotaPages) win.layoutQuotaPages();
  }

  function present(data, fromCache) {
    var relativeNode;
    if (!validPayload(data)) return false;
    if (state.renderedAt && timestamp(data.updatedAt) < timestamp(state.renderedAt)) return false;
    if (!fromCache && !storeCache(data)) return false;

    state.latest = data;
    state.usingCache = !!fromCache;
    if (data.updatedAt !== state.renderedAt) {
      state.renderedAt = data.updatedAt;
      updateWeather(data.weather);
      renderProviders(data);
      updateQuotaCard('cardClaude', data.sources.claude);
      updateQuotaCard('cardCodex', data.sources.codex);
      updateQuotaCard('cardKimi', data.sources.kimi);
      updateBalance(data.sources.deepseek);
      updateQuote(data.quote);
      relativeNode = ui.find('relTime');
      if (relativeNode) ui.attribute(relativeNode, 'data-ts', data.updatedAt);
    }
    updateFreshness();
    return true;
  }

  function showValidatedCache() {
    var cached = readCache();
    return cached ? present(cached, true) : false;
  }

  function requestData(url, canFallback) {
    var requestId;
    var separator;
    if (!url || url.indexOf('__LIVE_') === 0) return;
    requestId = ++state.requestId;
    separator = url.indexOf('?') < 0 ? '?' : '&';
    win.DASH_DATA = null;
    attachScript(
      url + separator + '_=' + Date.now(),
      function () {
        if (requestId !== state.requestId) return;
        if (!present(win.DASH_DATA, false)) {
          if (canFallback && url !== settings.fallbackData) requestData(settings.fallbackData, false);
          else {
            state.usingCache = true;
            if (!showValidatedCache()) updateFreshness();
          }
        }
      },
      function () {
        if (requestId !== state.requestId) return;
        if (canFallback && url !== settings.fallbackData) {
          requestData(settings.fallbackData, false);
        } else {
          state.usingCache = true;
          if (!showValidatedCache()) updateFreshness();
        }
      }
    );
  }

  function refresh() {
    requestDeviceStatus();
    win.DASH_LIVE_ENDPOINT = '';
    attachScript(
      settings.endpointPointer + '?_=' + Date.now(),
      function () {
        var supplied = win.DASH_LIVE_ENDPOINT || '';
        if (supplied && supplied.indexOf('__LIVE_') !== 0) state.endpoint = supplied;
        else state.endpoint = settings.fallbackData;
        requestData(state.endpoint, true);
      },
      function () {
        state.endpoint = settings.fallbackData;
        requestData(state.endpoint, false);
      }
    );
  }

  function scheduleRefresh() {
    var now = new Date();
    var milliseconds = now.getTime();
    var delay;

    if (isQuiet(now)) {
      delay = millisecondsUntilMorning(now);
    } else {
      delay = (
        settings.pollOffset -
        (milliseconds % settings.pollEvery) +
        settings.pollEvery
      ) % settings.pollEvery;
      if (delay < 250) delay += settings.pollEvery;
    }

    setTimeout(function () {
      if (!isQuiet()) refresh();
      scheduleRefresh();
    }, delay);
  }

  function scheduleMinuteClock() {
    var now = new Date();
    var delay = isQuiet(now)
      ? millisecondsUntilMorning(now)
      : 60000 - (now.getTime() % 60000) + 100;
    setTimeout(function () {
      updateClock();
      scheduleMinuteClock();
    }, delay);
  }

  if (!present(win.DASH_DATA, false)) showValidatedCache();
  updateClock();
  updateBattery();
  if (!isQuiet()) refresh();
  scheduleRefresh();
  scheduleMinuteClock();
}(window, document));
