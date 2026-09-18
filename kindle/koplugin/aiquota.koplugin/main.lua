local Device = require("device")
local Screen = Device.screen
local BB = require("ffi/blitbuffer")
local Font = require("ui/font")
local Geom = require("ui/geometry")
local GestureRange = require("ui/gesturerange")
local InfoMessage = require("ui/widget/infomessage")
local InputContainer = require("ui/widget/container/inputcontainer")
local InputDialog = require("ui/widget/inputdialog")
local TextWidget = require("ui/widget/textwidget")
local UIManager = require("ui/uimanager")
local WidgetContainer = require("ui/widget/container/widgetcontainer")
local logger = require("logger")
local DATA_PATH = os.getenv("AIQUOTA_DATA_PATH") or "/mnt/us/aiquota/data.json"
local AUTOSTART_ON = "/mnt/us/aiquota/autostart"        -- 存在 = 每次 KOReader 启动都自动弹面板
local AUTOSTART_ONCE = "/mnt/us/aiquota/autostart.once" -- 存在 = 下次启动弹一次（KUAL 入口用）
-- 数据源：默认 github.io + jsDelivr 双镜像（国内网络下 github.io 时通时断，
-- jsDelivr 的 CDN 节点通常可达）。设置了 AIQUOTA_DATA_URL 则只用它。
local DATA_URLS = os.getenv("AIQUOTA_DATA_URL") and { os.getenv("AIQUOTA_DATA_URL") } or {
    "https://milkbobo.github.io/kindle-ai-quota-dashboard/kindle.json",
    "https://cdn.jsdelivr.net/gh/milkbobo/kindle-ai-quota-dashboard@gh-pages/kindle.json",
    "https://fastly.jsdelivr.net/gh/milkbobo/kindle-ai-quota-dashboard@gh-pages/kindle.json",
}
local preferred_url = 1  -- 记住上次成功的镜像，下次优先尝试
-- 面板不再显示时钟，所以没必要每分钟刷新：每 5 分钟拉一次云端 + 重读本地快照，
-- 并且**只在屏幕上真的会有变化时**才推墨水屏；没变化就完全不刷（省电的关键）。
-- AIQUOTA_REFRESH_SEC 可以调这个节奏（也用于自动化测试里把它压短）。
local REFRESH_SEC = tonumber(os.getenv("AIQUOTA_REFRESH_SEC")) or 300
local STALE_SEC = 900  -- 超过这么久没有新数据就标成"旧数据"

-- ── 面板打开期间：不熄屏 + 关前光 ────────────────────────────────────
-- 把 Kindle 当常驻看板时，要同时挡住三个各自独立的休眠来源，
-- 少挡一个都会在十几分钟后熄屏：
--   1. Kindle 系统层：powerd 自己的无操作屏保/休眠定时器，只能改 lipc 属性
--      preventScreenSaver。注意 UIManager:preventStandby() 在 Kindle 上没用——
--      Device:setAutoStandby 在 generic/device.lua 里是空实现，Kindle 没有覆盖它。
--   2. KOReader 自身：内置 AutoSuspend 插件默认「15 分钟无操作」就广播 Suspend，
--      Kindle 上 powerd 收到后会模拟按下电源键（powerButton 属性）把整机送进屏保，
--      这条路径绕过 preventScreenSaver。用 PluginShare.pause_auto_suspend 暂停它
--      （官方 keepalive 插件在 Kobo 上用的就是这个标志）。
--   3. 其它设备（Kobo / PocketBook 等）：UIManager:preventStandby() / allowStandby()，
--      必须成对，allowStandby 里有计数器断言。
-- 另外面板打开期间把前光关掉：墨水屏不点灯也看得清，长时间挂机省电。
-- 前光的 API 在 Device.powerd 上（BasePowerD），不在 Device 上。
local KEEP_AWAKE_SETTING = "aiquota_keep_awake"  -- 存储 false 表示用户关掉了常亮
local LIGHT_OFF_SETTING = "aiquota_light_off"    -- 存储 false 表示用户想保留原亮度
local IGNORE_HALL_SETTING = "aiquota_ignore_hall" -- 存储 false 表示保留磁吸套的休眠/唤醒行为
local MANUAL_SLEEP_SETTING = "aiquota_manual_sleep" -- 存储 false = 连电源键也挡（硬锁，旧行为）
local CLEANUP_FLASH_SETTING = "aiquota_cleanup_flash" -- true = 每小时整屏闪一次清残影（默认关）
local DAILY_SLEEP_SETTING = "aiquota_daily_sleep"   -- "HH:MM"；未设/空 = 关闭每天定时息屏
local DAILY_WAKE_SETTING = "aiquota_daily_wake"     -- "HH:MM"；未设/空 = 关闭每天定时开屏（RTC 唤醒）
local WAKE_WEEKDAYS_SETTING = "aiquota_daily_wake_weekdays" -- 存 false = 周末也开屏（默认只工作日）
-- 记录最近一次刷新的类型，写进取证日志，方便事后核对"到底有没有闪屏"
local last_refresh = "-"
local share_ok, PluginShare = pcall(require, "pluginshare")
if not share_ok then PluginShare = nil end
local keep_awake = nil  -- 非 nil 表示当前正持有常亮/熄灯；保存了需要还原的旧值

-- lipc 访问：优先用 liblipclua（KOReader 自己读电池/前光就是这么干的：原生调用、不 fork 进程）。
-- 起因：早期版本用 io.popen("lipc-get-prop ...") / os.execute("lipc-set-prop ...")，
-- 每次都要 fork + 建连接。真机日志显示 11:37:02 之后近 4 分钟没有一次刷新、随后进程卡死，
-- 而那条路径上唯一的系统调用就是每分钟一次的 lipc 子进程调用，所以改成原生调用；
-- 命令行只在拿不到 liblipclua 句柄时才回退。
local lipc_handle, lipc_checked = nil, false

local function getLipcHandle()
    if lipc_checked then return lipc_handle end
    lipc_checked = true
    local ok, lipc = pcall(require, "liblipclua")
    if not ok or not lipc then return nil end
    local ok2, handle = pcall(function() return lipc.init("com.github.koreader.aiquota") end)
    if ok2 and handle then lipc_handle = handle end
    return lipc_handle
end

local function lipcPreventScreenSaverValue()
    local handle = getLipcHandle()
    if handle then
        local ok, value = pcall(function()
            return handle:get_int_property("com.lab126.powerd", "preventScreenSaver")
        end)
        if ok and value ~= nil then return value end
        return nil
    end
    local pipe = io.popen("lipc-get-prop com.lab126.powerd preventScreenSaver 2>/dev/null")
    if not pipe then return nil end
    local out = pipe:read("*a") or ""
    pipe:close()
    return tonumber(out:match("%-?%d+"))
end

local function lipcSetPreventScreenSaver(value)
    local handle = getLipcHandle()
    if handle then
        local ok = pcall(function()
            handle:set_int_property("com.lab126.powerd", "preventScreenSaver", value)
        end)
        if ok then return true end
    end
    os.execute(string.format("lipc-set-prop com.lab126.powerd preventScreenSaver %d >/dev/null 2>&1", value))
    return true
end

-- 磁吸保护套：霍尔传感器一感应到磁铁就让 powerd 直接挂起（HALL_SUSPEND），
-- 这条路径**绕过 preventScreenSaver**，是"面板明明开着却还是睡过去"最常见的元凶
-- （把保护套翻折到背面时，磁铁正好贴在传感器附近，设备就会自己睡，而且不会自己醒）。
-- 所以面板打开期间把传感器临时关掉，关闭面板时恢复。
-- 直接写 sysfs，不用 powerd:onToggleHallSensor()——那个 API 会把用户的
-- "kindle_hall_effect_sensor_enabled" 全局设置一起改掉，我们只想要临时生效。
local function hallSensorEnabled()
    local powerd = Device.powerd
    if not powerd or not powerd.hall_file or not powerd.isHallSensorEnabled then return nil end
    local ok, value = pcall(function() return powerd:isHallSensorEnabled() end)
    if not ok then return nil end
    return value
end

local function setHallSensorEnabled(enable)
    local powerd = Device.powerd
    if not powerd or not powerd.hall_file then return false end
    -- writeToSysfs 写不进时会返回 false（不抛异常），所以要看返回值，不能只看 pcall
    local ok, written = pcall(function()
        return require("ffi/util").writeToSysfs(enable and 1 or 0, powerd.hall_file)
    end)
    return ok and written ~= false
end

-- 取证日志：面板开着期间的每条记录都带上当时的常亮状态。
-- 为什么需要它：面板"卡住不更新"可能是设备真的挂起了（挂起期间 KOReader 的定时器不走），
-- 也可能是刷新链断了。KOReader 自己的输出在真机上常常没人接（不是走 KUAL 入口启动时），
-- 所以往 U 盘写一份，插上电脑就能读：
--   tick    = 每 5 分钟一条心跳，停在哪一刻说明那一刻起就不再刷新
--   suspend = KOReader 收到了挂起事件（后面还有 tick 在跳 = 没真挂起）
--   resume  = 唤醒（插 USB/按电源/开磁吸套都会走这里）
--   open / close / re-* = 常亮开关状态与"被重置后重新压下"的记录
local LOG_PATH = os.getenv("AIQUOTA_LOG_PATH") or "/mnt/us/aiquota/sleep.log"

-- 电量百分比：给"息屏到底省不省电"留证据（用 KOReader 自己的 API，内部 60 秒缓存，不会频繁读硬件）
local function batteryText()
    local powerd = Device.powerd
    if powerd and powerd.getCapacity then
        local ok, cap = pcall(function() return powerd:getCapacity() end)
        if ok and cap then return tostring(cap) .. "%" end
    end
    return "-"
end

local function logEvent(reason, detail, device)
    local file = io.open(LOG_PATH, "a")
    if not file then return end
    file:write(string.format("%s %-8s %s\n", os.date("%m-%d %H:%M:%S"), reason, detail or string.format(
        "keep_awake=%s mode=%s refresh=%s batt=%s lipc=%s pause=%s ui_prevent=%s light=%s hall=%s",
        tostring(keep_awake ~= nil),
        keep_awake and (keep_awake.hard and "hard" or "soft") or "-",
        last_refresh,
        batteryText(),
        tostring(device and device.lipc or (Device:isKindle() and lipcPreventScreenSaverValue() or "-")),
        tostring(PluginShare and PluginShare.pause_auto_suspend),
        tostring(UIManager._prevent_standby_count),
        tostring(keep_awake and keep_awake.light or false),
        tostring(hallSensorEnabled()))))
    file:close()
    -- 防无限增长：超过 32KB 只留最后 200 行
    local probe = io.open(LOG_PATH, "r")
    if not probe then return end
    local size = probe:seek("end")
    probe:close()
    if not size or size < 32768 then return end
    local kept = {}
    local reader = io.open(LOG_PATH, "r")
    if not reader then return end
    for line in reader:lines() do
        kept[#kept + 1] = line
        if #kept > 200 then table.remove(kept, 1) end
    end
    reader:close()
    local writer = io.open(LOG_PATH, "w")
    if not writer then return end
    writer:write(table.concat(kept, "\n") .. "\n")
    writer:close()
end

-- 与环境变量/设置合起来判断某个开关是否生效：设置里存 false 表示关掉
local function switchWanted(setting, env_name)
    if os.getenv(env_name) == "0" then return false end
    if G_reader_settings then
        local ok, off = pcall(function() return G_reader_settings:isFalse(setting) end)
        if ok and off then return false end
    end
    return true
end

local function keepAwakeWanted() return switchWanted(KEEP_AWAKE_SETTING, "AIQUOTA_KEEP_AWAKE") end
local function lightOffWanted() return switchWanted(LIGHT_OFF_SETTING, "AIQUOTA_LIGHT_OFF") end
local function ignoreHallWanted() return switchWanted(IGNORE_HALL_SETTING, "AIQUOTA_IGNORE_HALL") end
local function manualSleepWanted() return switchWanted(MANUAL_SLEEP_SETTING, "AIQUOTA_MANUAL_SLEEP") end
-- 默认**不**整屏闪；只有显式打开（菜单/环境变量）才每小时闪一次清残影
local function cleanupFlashWanted()
    if os.getenv("AIQUOTA_CLEANUP_FLASH") == "1" then return true end
    if G_reader_settings then
        local ok, on = pcall(function() return G_reader_settings:isTrue(CLEANUP_FLASH_SETTING) end)
        if ok and on then return true end
    end
    return false
end

-- 读一个 "HH:MM" 形式的设置（环境变量优先，便于临时覆盖/测试）：返回 时,分 或 nil（=关闭）
local function timeSetting(setting, env_name)
    local raw = os.getenv(env_name)
    if raw == nil and G_reader_settings then
        local ok, value = pcall(function() return G_reader_settings:readSetting(setting) end)
        raw = ok and value or nil
    end
    if type(raw) ~= "string" then return nil end
    local hh, mm = raw:match("^%s*(%d%d?):(%d%d)%s*$")
    hh, mm = tonumber(hh), tonumber(mm)
    if not hh or not mm or hh > 23 or mm > 59 then return nil end
    return hh, mm
end

-- 每天定时息屏 / 开屏的时间点（设置里存 "HH:MM"，空 = 关闭）
local function dailySleepTime() return timeSetting(DAILY_SLEEP_SETTING, "AIQUOTA_DAILY_SLEEP") end
local function dailyWakeTime() return timeSetting(DAILY_WAKE_SETTING, "AIQUOTA_DAILY_WAKE") end

-- 开屏是否只在工作日（默认是；设置里存 false 或 AIQUOTA_DAILY_WAKE_WEEKENDS=1 → 周末也开）
local function wakeWeekdaysOnly()
    if os.getenv("AIQUOTA_DAILY_WAKE_WEEKENDS") == "1" then return false end
    if G_reader_settings then
        local ok, off = pcall(function() return G_reader_settings:isFalse(WAKE_WEEKDAYS_SETTING) end)
        if ok and off then return false end
    end
    return true
end

-- 算"下一次 HH:MM"离现在多少秒（今天已过 → 明天；weekdays_only 时跳过周六周日）。
-- AIQUOTA_TEST_NOW="YYYY-MM-DD HH:MM" 可伪造当前时间，用来测周末跳过逻辑。
local function nowEpoch()
    local raw = os.getenv("AIQUOTA_TEST_NOW")
    if raw then
        local y, mo, d, h, mi = raw:match("^(%d%d%d%d)-(%d%d)-(%d%d)%s+(%d%d):(%d%d)$")
        if y then
            return os.time{ year = tonumber(y), month = tonumber(mo), day = tonumber(d),
                hour = tonumber(h), min = tonumber(mi), sec = 0 }
        end
    end
    return os.time()
end

-- Lua 的 %w：0=周日 … 6=周六
local function isWeekend(epoch)
    local w = tonumber(os.date("%w", epoch))
    return w == 0 or w == 6
end

local function secondsUntil(hh, mm, extra_sec, weekdays_only)
    local now = nowEpoch()
    local t = os.date("*t", now)
    local target = os.time{ year = t.year, month = t.month, day = t.day,
        hour = hh, min = mm, sec = extra_sec or 0 }
    if target <= now then target = target + 24 * 3600 end
    if weekdays_only then
        local guard = 0
        while isWeekend(target) and guard < 10 do
            target = target + 24 * 3600
            guard = guard + 1
        end
    end
    return target - now, target
end

local function todayText()
    return os.date("%Y-%m-%d")
end

-- 熄灯：只记 state.light，还原时用 powerd 自己记住的 fl_intensity 点回原亮度；
-- 原来就没开灯就什么都不做，绝不替用户点灯
local function turnFrontlightOffForPanel(state)
    if not lightOffWanted() or not Device:hasFrontlight() then return end
    local powerd = Device.powerd
    if not powerd or not powerd.turnOffFrontlight or not powerd.isFrontlightOn then return end
    if powerd:isFrontlightOn() then
        powerd:turnOffFrontlight()
        state.light = true
    end
end

local function restoreFrontlight(state)
    if not state or not state.light then return end
    state.light = nil
    local powerd = Device.powerd
    if powerd and powerd.turnOnFrontlight then powerd:turnOnFrontlight() end
end

-- 面板打开期间忽略磁吸套（只在原来开着传感器时才动，关的时候恢复）
local function ignoreHallForPanel(state)
    if not ignoreHallWanted() then return end
    if hallSensorEnabled() ~= true then return end  -- 没有传感器 / 本来就是关的
    if setHallSensorEnabled(false) then
        state.hall = true
        logEvent("hall-off", "面板期间临时关闭霍尔传感器（磁吸套不再触发挂起）")
    end
end

local function restoreHall(state)
    if not state or not state.hall then return end
    state.hall = nil
    if setHallSensorEnabled(true) then
        logEvent("hall-on", "已恢复霍尔传感器")
    end
end

local function enableKeepAwake()
    if keep_awake then return end
    local state = {}
    if keepAwakeWanted() then
        if Device:isKindle() then
            state.kindle = true
            -- 两种模式：
            --  soft（默认）——只推迟 powerd 自己的空闲屏保计时器（每分钟 resetT1Timeout），
            --                不动 preventScreenSaver。设备不会自己睡，但你按电源键依然能手动息屏。
            --  hard        ——设 preventScreenSaver=1，连电源键也挡。代价：手动息屏失效
            --                （真机实测：按电源键毫无反应，连 suspend 事件都没有）。
            -- 电源键没有映射成 KOReader 的输入事件（Kindle 键位表里没有 116），
            -- 所以想在 Lua 里"感知到按键再放行"做不到，只能靠不设这个属性。
            state.hard = not manualSleepWanted()
            if state.hard then
                state.prev_screensaver = lipcPreventScreenSaverValue()
                lipcSetPreventScreenSaver(1)
                -- 回读确认真的写进去了：真机上若 lipc 调用失败（PATH/权限），
                -- 这里就是第一个暴露点，别让它静默失效
                state.lipc = lipcPreventScreenSaverValue()
                if state.lipc ~= 1 then
                    logger.warn("aiquota: preventScreenSaver did not stick, now", tostring(state.lipc))
                end
            end
        end
        if PluginShare then
            state.prev_pause = PluginShare.pause_auto_suspend
            PluginShare.pause_auto_suspend = true
            state.paused = true
        end
        if UIManager.preventStandby and UIManager.allowStandby then
            UIManager:preventStandby()
            state.prevented = true
        end
        state.nosleep = state.kindle or state.paused or state.prevented or false
    end
    turnFrontlightOffForPanel(state)
    ignoreHallForPanel(state)
    if next(state) == nil then return end  -- 两个开关都关着，不持有任何状态
    keep_awake = state
    logEvent("open", nil, state)
    logger.info("aiquota: keep awake ON", "kindle=" .. tostring(state.kindle or false),
        "pause_auto_suspend=" .. tostring(state.paused or false),
        "prevent_standby=" .. tostring(state.prevented or false),
        "light_off=" .. tostring(state.light or false),
        "lipc=" .. tostring(state.lipc),
        "lipc_mode=" .. (getLipcHandle() and "native" or "shell"))
end

local function disableKeepAwake()
    local state = keep_awake
    if not state then return end
    keep_awake = nil
    if state.hard then
        -- 只有硬锁模式才动过 preventScreenSaver；还原成进来之前的值
        -- （用户可能本来就开着常亮：KeepAlive 插件 / 启动器设置过）
        lipcSetPreventScreenSaver(state.prev_screensaver or 0)
    end
    if state.paused and PluginShare then
        PluginShare.pause_auto_suspend = state.prev_pause or false
    end
    if state.prevented then UIManager:allowStandby() end
    local light_was = state.light or false
    local hall_was = state.hall or false
    restoreFrontlight(state)
    restoreHall(state)
    logEvent("close", "mode=" .. (state.hard and "hard" or "soft") ..
        " prev_screensaver=" .. tostring(state.prev_screensaver) ..
        " light_was=" .. tostring(light_was) .. " hall_was=" .. tostring(hall_was))
    logger.info("aiquota: keep awake OFF")
end

-- 看门狗：面板开着期间每分钟重新确认常亮还在生效。
-- 为什么需要：powerd 的属性可能被系统事件（USB 拔插、框架重启、powerd 状态切换）重置，
-- AutoSuspend 的暂停标志也可能被别的插件改掉。只在打开面板时设一次，一旦静默失效
-- 就只能等设备睡过去——又回到"插电才刷新"。
local function refreshKeepAwake(verbose)
    local state = keep_awake
    if not state then return end
    local started = os.time()
    if state.kindle then
        if state.hard then
            -- 硬锁模式：每分钟幂等重设 preventScreenSaver（原生调用，很便宜）；
            -- 只有退化成命令行时才降频到每 5 分钟一次，因为命令行要 fork 子进程，
            -- 真机上正是这类调用把单线程 UI 卡住过。
            local native = getLipcHandle() ~= nil
            if verbose and lipcPreventScreenSaverValue() == 0 then
                logEvent("re-lipc", "读回发现被系统重置为 0")
            end
            if native or verbose then
                lipcSetPreventScreenSaver(1)
            end
        else
            -- 软模式：只推迟 powerd 自己的空闲屏保计时器（KOReader 平时也这么做），
            -- 不碰 preventScreenSaver —— 所以按电源键依然能手动息屏。
            -- powerd 那边对 t1 重置有 15 秒节流，每分钟一次足够，且不会失败。
            local powerd = Device.powerd
            if powerd and powerd.resetT1Timeout then
                pcall(function() powerd:resetT1Timeout() end)
            end
        end
    end
    if state.paused and PluginShare and not PluginShare.pause_auto_suspend then
        PluginShare.pause_auto_suspend = true
        logEvent("re-pause", "pause_auto_suspend was false -> true")
    end
    if state.light then
        local powerd = Device.powerd
        if powerd and powerd.isFrontlightOn and powerd:isFrontlightOn() then
            powerd:turnOffFrontlight()
            logEvent("re-light", "frontlight back on -> off")
        end
    end
    if state.hall and hallSensorEnabled() == true then
        setHallSensorEnabled(false)
        logEvent("re-hall", "霍尔传感器被重新打开 -> 再关掉")
    end
    local cost = os.time() - started
    if cost >= 5 then
        logEvent("slow-watchdog", "看门狗单次耗时 " .. cost .. " 秒（这里就是卡顿源头）")
    end
end

-- 按顺序尝试镜像直到成功，原子替换本地文件；全部失败时保留旧数据
local function fetchCloud()
    local socket = require("socket")
    local http = require("socket.http")
    local https = require("ssl.https")
    local ltn12 = require("ltn12")
    local socketutil = require("socketutil")
    local tmp = DATA_PATH .. ".tmp"
    local last_err

    for offset = 0, #DATA_URLS - 1 do
        local idx = ((preferred_url - 1 + offset) % #DATA_URLS) + 1
        local url = DATA_URLS[idx]
        local file = io.open(tmp, "wb")
        if not file then return false, "tmp 不可写" end
        local request = {
            url = url,
            method = "GET",
            headers = {
                ["User-Agent"] = "aiquota.koplugin",
                ["Cache-Control"] = "no-cache",
            },
            sink = ltn12.sink.file(file),
        }
        -- 小 JSON 文件用短超时，避免镜像全挂时长时间阻塞界面
        socketutil:set_timeout(5, 10)
        local code
        if url:find("^https:") then
            code = socket.skip(1, https.request(request))
        else
            code = socket.skip(1, http.request(request))
        end
        socketutil:reset_timeout()
        if code == 200 then
            os.rename(tmp, DATA_PATH)
            preferred_url = idx
            return true
        end
        os.remove(tmp)
        last_err = string.format("%s HTTP %s", url, tostring(code))
        logger.info("aiquota: mirror fail", last_err)
    end
    return false, last_err or "没有可用镜像"
end

local function loadData()
    local file = io.open(DATA_PATH, "rb")
    if not file then return { items = {}, error = "尚无数据 · 请推送 aiquota/data.json" } end
    local content = file:read(262145) or ""
    file:close()
    if #content > 262144 then return { items = {}, error = "数据文件过大" } end
    local ok, data = pcall(function() return require("rapidjson").decode(content) end)
    if not ok or type(data) ~= "table" or type(data.items) ~= "table" then
        return { items = {}, error = "数据格式错误 · 请重新导出" }
    end
    local items = {}
    for _, item in ipairs(data.items) do
        if type(item) == "table" then table.insert(items, item) end
    end
    data.items = items
    return data
end

-- 数据算不算"旧"：没有 updated 或超过 STALE_SEC。paintTo 和刷新任务都用它，
-- 保证"画出来的状态"和"判断要不要重画"用的是同一套标准。
local function dataIsStale(data)
    local updated = tonumber(data and data.updated)
    return not updated or os.time() - updated > STALE_SEC
end

local Panel = InputContainer:extend{ modal = true, covers_fullscreen = true, page = 1 }
function Panel:init()
    enableKeepAwake()  -- 面板出现即禁止休眠 + 关前光，直到面板关闭
    self.data = loadData()
    self:layout()
    -- 打开时先用本地数据显示，再异步拉云端；断网时不阻塞面板出现
    UIManager:scheduleIn(0.1, function()
        local ok, err = fetchCloud()
        logger.info("aiquota: cloud sync on open", ok, err)
        if self.data then
            self.data = loadData()
            self:layout()
            last_refresh = "ui(打开同步)"
            UIManager:setDirty(self, "ui")
        end
    end)
    self.refresh_task = function()
        UIManager:unschedule(self.refresh_task)
        -- 用 pcall 包住整段刷新：单次出错（坏 JSON、布局异常）不能让定时链断掉，
        -- 否则面板会永远停在最后一帧——现象同样是"卡住不更新"，但 sleep.log 里
        -- 只会看到 tick 断档、没有 suspend/resume，正好和真休眠区分开。
        local started = os.time()
        local ok, err = pcall(function()
            -- 每轮都拉一次云端 + 重读本地快照（都是 5 分钟一次）
            local cloud_ok, cloud_err = fetchCloud()
            logger.info("aiquota: cloud sync", cloud_ok, cloud_err)
            local previous = self.data
            self.data = loadData()
            self:layout()
            self.ticks = (self.ticks or 0) + 1
            refreshKeepAwake(true)  -- 每轮做一次完整校验（含读回确认）
            logEvent("tick")
            -- 定时息屏兜底：休眠期间单调时钟不走，定时器可能被推迟，这里每 5 分钟核一次钟点
            if self.owner and self.owner.maybeDailySleep then self.owner:maybeDailySleep() end
            -- 只有"屏幕上真会有变化"才推墨水屏：数据/状态行变化、或跨天后日期变了。
            -- 没变化就一点都不刷 —— 原来每分钟刷一次，现在是平均每 5 分钟一次（且只在有变化时）。
            local changed = previous == nil
                or previous.updated ~= self.data.updated
                or previous.error ~= self.data.error
                or #previous.items ~= #self.data.items
                or dataIsStale(previous) ~= dataIsStale(self.data)
                or os.date("%Y.%m.%d") ~= self.shown_date
            if changed then
                -- 默认绝不整屏闪：只把"有变化的那块"用 "ui"（局部、不闪）推给墨水屏。
                -- 想要整屏闪清残影得显式打开（菜单开关或 AIQUOTA_CLEANUP_FLASH=1）——
                -- 之前是默认每小时闪一次，结果 16:59 那次把你吓了一跳（真机日志复核过）。
                if cleanupFlashWanted() and self.ticks % 12 == 0 then
                    last_refresh = "full(整屏闪)"
                    UIManager:setDirty(self, "full")
                elseif self.body_region then
                    last_refresh = "ui(body区域)"
                    UIManager:setDirty(self, "ui", self.body_region)
                else
                    last_refresh = "ui(整屏不闪)"
                    UIManager:setDirty(self, "ui")
                end
            end
        end)
        if not ok then
            logger.warn("aiquota: refresh failed", tostring(err))
            logEvent("error", tostring(err))
        end
        local cost = os.time() - started
        if cost >= 15 then
            logEvent("slow-refresh", "本次刷新耗时 " .. cost .. " 秒（这里就是卡顿源头）")
        end
        UIManager:scheduleIn(REFRESH_SEC, self.refresh_task)
    end
    UIManager:scheduleIn(REFRESH_SEC, self.refresh_task)
end
function Panel:layout()
    self.dimen = Screen:getSize()
    self.per_page = self.dimen.w > self.dimen.h and 2 or 4
    self.pages = math.max(1, math.ceil(#self.data.items / self.per_page))
    self.page = math.max(1, math.min(self.page, self.pages))
    -- 数据更新时要重画的区域：从头部下方那条分割线，到页脚上方。
    -- 头部（标题/大标题/日期）和页脚（页码、常亮标记）只在打开、翻页、关闭时变，
    -- 所以数据变化只把这一块推给墨水屏，别整屏刷。
    local w = self.dimen.w
    local h = self.dimen.h
    local s = math.min(w / 1072, h / 1448)
    local pad = math.floor(w * 0.05)
    local body_top = math.floor(pad + 235 * s)
    local body_bottom = math.floor(h - pad - 88 * s)
    self.body_region = Geom:new{
        x = 0,
        y = math.max(0, body_top),
        w = w,
        h = math.max(1, body_bottom - body_top),
    }
    self.ges_events = {
        Tap = { GestureRange:new{ ges = "tap", range = self.dimen } },
        Swipe = { GestureRange:new{ ges = "swipe", range = self.dimen } },
    }
    self.key_events = { Close = { { "Back" }, { "Esc" } }, Next = { { "Right" }, { "PgFwd" } }, Previous = { { "Left" }, { "PgBack" } } }
end
-- 打开面板时整屏刷一次：这是**刻意**的一次闪屏，保证首屏干净没有上一屏的残影。
-- 不想看到它也告诉我，可以改成 "ui"（不闪但可能有残影）。
function Panel:onShow() last_refresh = "full(打开)"; UIManager:setDirty(self, "full"); return true end
-- 关闭面板时必须保证 UI 栈非空。
-- 原因：本面板是通过 KUAL / autostart 拉起时 KOReader 里的唯一窗口，
-- 若直接 UIManager:close(self)，窗口栈会被清空，uimanager.lua 主循环
-- (`if not self._window_stack[1] then ... self:_gated_quit()`) 会判定
-- "No dialogs left to show" 并以 exit code 0 退出 KOReader —— 表现就是
-- 闪一下回到 Kindle 原生主页。
--
-- 正确做法：先确保文件管理器已经在栈底（顺序很重要！必须先垫后关），
-- 再关闭面板。文件管理器必须用官方的 FileManager:showFiles() 创建，
-- 不能自己 FileManager:new{}，否则缺少 dimen / covers_fullscreen /
-- root_path 等必要字段，构造出的实例不可用，栈仍会变空。
function Panel:onClose()
    local FileManager = require("apps/filemanager/filemanager")
    -- 关掉面板后窗口栈不能变空，否则 uimanager 主循环会判定 "No dialogs left to show"
    -- 并以 exit code 0 退出 KOReader（现象：闪回原生主页）。
    -- 只判断 FileManager.instance 不够：实例存在、但已经不在窗口栈里时照样会走到空栈
    -- （真机日志就是这么翻车的：close 之后 5 秒 "No dialogs left to show" + 退出）。
    local others = 0
    for _, window in ipairs(UIManager._window_stack or {}) do
        if window.widget ~= self then others = others + 1 end
    end
    if others == 0 then
        local dir = G_reader_settings and G_reader_settings:readSetting("lastdir")
        FileManager:showFiles(dir)
    end
    UIManager:close(self)
    return true
end
function Panel:onCloseWidget()
    UIManager:unschedule(self.refresh_task)
    disableKeepAwake()  -- 关面板即还原休眠行为和前光亮度
    -- 关闭时用 "ui"（不闪）而不是 "full"：KOReader 文档里明确说
    -- "ui" onCloseWidget 能保证这个 widget 永远不会引起一次闪屏
    UIManager:setDirty(nil, "ui")
    if self.owner then self.owner.panel = nil end
    logger.info("aiquota: closed")
end
function Panel:turn(delta)
    self.page = math.max(1, math.min(self.pages, self.page + delta))
    UIManager:setDirty(self, "ui")
    return true
end
function Panel:onNext() return self:turn(1) end
function Panel:onPrevious() return self:turn(-1) end
function Panel:onSwipe(_, ges)
    if ges.direction == "west" then return self:onNext() end
    if ges.direction == "east" then return self:onPrevious() end
    return true
end
function Panel:onTap(_, ges)
    if ges.pos.y < self.dimen.h * 0.085 and ges.pos.x > self.dimen.w * 0.75 then return self:onClose() end
    if ges.pos.y > self.dimen.h * 0.9 then
        return self:turn(ges.pos.x < self.dimen.w / 2 and -1 or 1)
    end
    return true
end
function Panel:onSetDimensions() self:layout(); UIManager:setDirty(self, "full"); return true end
-- 挂起/唤醒取证：这两条是判断"卡住不更新"到底是设备休眠还是刷新链断掉的关键。
-- 如果 sleep.log 里只有 tick 断档、却没有 suspend/resume 配对，说明设备确实睡了
-- 但 KOReader 没收到事件（powerd 直接挂起 / 磁吸套霍尔传感器触发），要往系统层查。
function Panel:onSuspend()
    logEvent("suspend")
    -- 睡着之前把 RTC 定时开屏的闹钟排好（手动按电源键息屏也走这里）
    if self.owner and self.owner.armDailyWake then self.owner:armDailyWake("面板挂起") end
    UIManager:unschedule(self.refresh_task)
    return true
end
function Panel:onResume()
    logEvent("resume")
    if self.sleeping then
        -- 从"已息屏"黑屏回来：清掉标记并整屏重画（刻意的一次闪，重新画出仪表盘）
        self.sleeping = nil
        last_refresh = "full(唤醒)"
        UIManager:setDirty(self, "full")
    end
    if self.owner and self.owner.onResume then self.owner:onResume() end
    refreshKeepAwake(true)
    self.refresh_task()  -- 唤醒后立刻拉一次云端并重画（不用等下一个 5 分钟窗口）
    return true
end

function Panel:paintTo(bb, x, y)
    local w, h = self.dimen.w, self.dimen.h
    local s = math.min(w / 1072, h / 1448)
    local pad = math.floor(w * 0.05)
    local iw = w - 2 * pad
    local function rect(rx, ry, rw, rh, color)
        bb:paintRect(x + math.floor(rx), y + math.floor(ry), math.floor(rw), math.floor(rh), color or BB.COLOR_BLACK)
    end
    -- Bound every text box and compensate for Font:getFace's device DPI scaling.
    local function text(value, tx, ty, tw, th, size, bold, right, color)
        local font_size = math.max(1, math.floor(size * s / (Screen:scaleBySize(100) / 100)))
        local widget
        repeat
            if widget then widget:free() end
            widget = TextWidget:new{ text = tostring(value or ""):gsub("[\r\n\t]", " "),
                face = Font:getFace("cfont", font_size), bold = bold or false,
                padding = 0, max_width = math.floor(tw), fgcolor = color or BB.COLOR_BLACK }
            font_size = font_size - 1
        until widget:getSize().h <= th or font_size < 1
        local size_px = widget:getSize()
        assert(size_px.h <= th and size_px.w <= tw + 1, "aiquota text exceeds bounds")
        widget:paintTo(bb, x + math.floor(tx + (right and tw - size_px.w or 0)), y + math.floor(ty))
        widget:free()
    end
    -- 定时息屏后的画面：墨水屏断电会保留最后一帧，所以必须自己画一屏"已休眠"，
    -- 否则看起来就像没关掉（一直显示着仪表盘）。
    if self.sleeping then
        rect(0, 0, w, h, BB.COLOR_BLACK)
        local top = math.floor(h * 0.42)
        text("已息屏", pad, top, iw, math.floor(120 * s), 72, true, false, BB.COLOR_WHITE)
        local shh, smm = dailySleepTime()
        local line2 = os.date("%m-%d %H:%M") .. (shh and string.format("（每日 %02d:%02d 自动息屏）", shh, smm) or "（手动息屏）")
        text(line2, pad, top + math.floor(150 * s), iw, math.floor(40 * s), 26, false, false, BB.COLOR_WHITE)
        text("按电源键即可唤醒", pad, top + math.floor(210 * s), iw, math.floor(40 * s), 26, false, false, BB.COLOR_WHITE)
        last_refresh = "full(息屏画面)"
        logger.info("aiquota: sleep screen painted")
        return
    end
    rect(0, 0, w, h, BB.COLOR_WHITE)
    rect(pad, pad, iw, math.max(2, 5 * s))
    text("AI / QUOTA JOURNAL", pad, pad + 18*s, iw*.70, 32*s, 23, true)
    text("关闭 ×", pad + iw*.76, pad + 12*s, iw*.24, 42*s, 25, true, true)
    text("算力有数。", pad, pad + 73*s, iw, 87*s, 66, true)
    text("AI 额度监控 / 专注当下，心中有数", pad, pad + 174*s, iw*.70, 35*s, 24)
    text(os.date("%Y.%m.%d"), pad + iw*.7, pad + 174*s, iw*.3, 35*s, 23, false, true)
    -- 这里原本是 57pt 的大时钟（每分钟都要重画）。整点时间从面板上去掉后，
    -- 面板上就没有"每分钟都会变"的内容了，于是不需要再每分钟刷新一次。
    local stale = dataIsStale(self.data)
    local status = self.data.error or ((stale and "旧数据" or "已同步") .. " · " .. tostring(self.data.updatedText or "时间未知"))
    -- 记住这次画出去的状态，刷新任务据此判断"要不要重画"
    self.shown_stale = stale
    self.shown_date = os.date("%Y.%m.%d")
    local top = pad + 235*s
    rect(pad, top, iw, math.max(1, 2*s))
    text(status, pad, top + 16*s, iw*.72, 34*s, 23, stale)
    text("黑条 / 已用", pad + iw*.74, top + 16*s, iw*.26, 34*s, 23, false, true)
    local cards_top, cards_bottom = top + 75*s, h - pad - 120*s
    local gap = 20*s
    local card_h = (cards_bottom - cards_top - gap * (self.per_page - 1)) / self.per_page
    local first = (self.page - 1) * self.per_page + 1
    for i = first, math.min(#self.data.items, first + self.per_page - 1) do
        local item = self.data.items[i]
        local cy = cards_top + (i - first) * (card_h + gap)
        local inset = 24*s
        rect(pad, cy, iw, card_h)
        rect(pad + 2*s, cy + 2*s, iw - 4*s, card_h - 4*s, BB.COLOR_WHITE)
        local left, width = pad + inset, iw - 2*inset
        text(string.format("%02d / %s", i, tostring(item.name or "未知服务")), left, cy + card_h*.10, width*.77, card_h*.25, 33, true)
        local used = tonumber(item.used)
        if used and used == used and used ~= math.huge and used ~= -math.huge then
            used = math.max(0, math.min(100, used))
            text(string.format("%d%%", math.floor(used + .5)), left + width*.78, cy + card_h*.08, width*.22, card_h*.27, 39, true, true)
            local by, bh = cy + card_h*.46, math.max(6, 15*s)
            rect(left, by, width, bh)
            rect(left + 2*s, by + 2*s, width - 4*s, bh - 4*s, BB.COLOR_WHITE)
            rect(left + 2*s, by + 2*s, (width - 4*s)*used/100, bh - 4*s)
        end
        text(item.detail or item.text or "暂无额度数据", left, cy + card_h*.67, width, card_h*.23, 25)
    end
    if #self.data.items == 0 then
        text("等待第一份额度快照", pad, cards_top + 70*s, iw, 70*s, 40, true)
        text("电脑端导出后，将文件放入 aiquota/data.json", pad, cards_top + 160*s, iw, 45*s, 26)
    end
    rect(pad, h - pad - 88*s, iw, math.max(2, 3*s))
    text("‹ 上一页       " .. self.page .. " / " .. self.pages .. "       下一页 ›", pad, h - pad - 68*s, iw*.70, 40*s, 24)
    text("PAPERWHITE / 07", pad + iw*.70, h - pad - 68*s, iw*.30, 35*s, 20, true, true)
    local marks = ""
    if keep_awake then
        if keep_awake.nosleep then marks = marks .. " · 已禁止休眠" end
        if keep_awake.light then marks = marks .. " · 前光已关" end
        if keep_awake.hall then marks = marks .. " · 忽略磁吸套" end
    end
    text("每5分钟同步 · 左右滑动翻页" .. marks, pad, h - pad - 23*s, iw, 32*s, 21)
    logger.info(string.format("aiquota: bounded fullscreen=%dx%d page=%d/%d items=%d", w, h, self.page, self.pages, #self.data.items))
end

local Aiquota = WidgetContainer:extend{ name = "aiquota" }

function Aiquota:autostartEnabled()
    local file = io.open(AUTOSTART_ON, "rb")
    if file then file:close() return true end
    return false
end

function Aiquota:consumeOnceMarker()
    local file = io.open(AUTOSTART_ONCE, "rb")
    if not file then return false end
    file:close()
    os.remove(AUTOSTART_ONCE)
    return true
end

function Aiquota:toggleAutostart()
    if self:autostartEnabled() then
        os.remove(AUTOSTART_ON)
        return false
    end
    os.execute("mkdir -p /mnt/us/aiquota")
    local file = io.open(AUTOSTART_ON, "w")
    if file then file:close() end
    return true
end

-- 现场取号：把每次 init 的时间/pid 追加到 boot.log。
-- 用途：排查"点了 Start KOReader 没反应"时，判断 KOReader 到底有没有被拉起
--       （boot.log 没有新记录 = koreader.sh 没跑起来；有记录 = 跑起来了但退出了）
function Aiquota:traceBoot(reason)
    local f = io.open("/mnt/us/aiquota/boot.log", "a")
    if not f then return end
    f:write(string.format("%s pid=%s auto=%s\n",
        os.date("%m-%d %H:%M:%S"), tostring(os.time()), tostring(reason)))
    f:close()
end

-- ── 每天定时息屏 ─────────────────────────────────────────────────────
-- 到点（默认 18:30，菜单里可改）如果面板正开着，就先画一屏"已息屏"再让设备真休眠。
-- 只在面板开着时动手：你正在看书时不会被强制息屏。

function Aiquota:markDailySleepDone()
    self.last_daily_sleep_date = todayText()
end

-- 到点了吗？返回 "HH:MM" 表示该睡了（今天还没睡过、且在目标时间后 15 分钟窗口内）
function Aiquota:dailySleepDue()
    local hh, mm = dailySleepTime()
    if not hh then return nil end
    if self.last_daily_sleep_date == todayText() then return nil end
    local t = os.date("*t")
    local now_min, target = t.hour * 60 + t.min, hh * 60 + mm
    if now_min < target or now_min > target + 15 then return nil end
    return string.format("%02d:%02d", hh, mm)
end

function Aiquota:sleepNow(reason)
    if not self.panel then return false end
    self.panel.sleeping = true
    self:markDailySleepDone()
    last_refresh = "full(息屏画面)"
    UIManager:setDirty(self.panel, "full")
    logEvent("auto-sleep", reason or "")
    -- 睡之前把明早的开屏闹钟排好（挂起事件里也会排一次，双保险）
    self:armDailyWake("定时息屏")
    -- 等墨水屏把"已息屏"那屏刷完再睡；模拟器没有真实休眠，跳过
    UIManager:scheduleIn(1.5, function()
        if Device.isEmulator then
            logEvent("auto-sleep", "模拟器：跳过 suspend")
        else
            UIManager:suspend()
        end
    end)
    return true
end

function Aiquota:maybeDailySleep()
    local at = self:dailySleepDue()
    if not at then return end
    if not self.panel then return end  -- 面板没开（比如在看书）就不打扰
    self:sleepNow("到点 " .. at)
end

-- 定时器负责准点；睡眠期间单调时钟不走，所以还有个 refresh 任务兜底 + onResume 修正
function Aiquota:scheduleDailySleep()
    if self.daily_task then UIManager:unschedule(self.daily_task) end
    local hh, mm = dailySleepTime()
    if not hh then return end
    local now = os.date("*t")
    local target = os.time{ year = now.year, month = now.month, day = now.day, hour = hh, min = mm, sec = 2 }
    if target <= os.time() then target = target + 24 * 3600 end
    local wait = math.max(1, target - os.time())
    UIManager:scheduleIn(wait, self.daily_task)
    logger.info("aiquota: daily sleep scheduled at", string.format("%02d:%02d", hh, mm), "in", wait, "s")
end

-- 设备从休眠里醒来：如果今天的目标时间已经过去（说明是睡着时跨过去的），
-- 就把今天标记为已完成，免得你一唤醒它又立刻睡回去。
function Aiquota:onResume()
    local hh, mm = dailySleepTime()
    if not hh then return end
    local t = os.date("*t")
    if t.hour * 60 + t.min >= hh * 60 + mm and self.last_daily_sleep_date ~= todayText() then
        self:markDailySleepDone()
        logEvent("daily-sleep", "醒来时已过目标时间，今天不再自动息屏")
    end
end

-- ── 每天定时开屏（硬件 RTC 唤醒）─────────────────────────────────────
-- Kindle 支持硬件闹钟：KOReader 的 WakeupMgr 把它交给 powerd 的 rtcWakeup 属性，
-- 设备睡着也能在指定时刻自己醒过来。闹钟必须在"睡着之前"排好，所以三个时机都排一次：
-- 插件启动、面板挂起（手动按电源键 / 我们的定时息屏）、以及被 RTC 唤醒之后（任务是一次性的）。
-- 拿不到 Device.wakeup_mgr 就是这台设备不支持（例如广告版 Kindle），只写日志、不报错。

function Aiquota:onRtcWake()
    logEvent("wake", "被 RTC 定时唤醒")
    if self.panel then
        last_refresh = "full(定时开屏)"
        UIManager:setDirty(self.panel, "full")
    end
    refreshKeepAwake(true)
    self:armDailyWake("唤醒后重排")
end

function Aiquota:armDailyWake(reason)
    local hh, mm = dailyWakeTime()
    if not hh then return end
    local mgr = Device.wakeup_mgr
    if not mgr or not mgr.addTask then
        logEvent("wake", "设备不支持 RTC 唤醒（Device.wakeup_mgr 缺失）" ..
            (reason and (" · " .. tostring(reason)) or ""))
        return
    end
    if not self.wake_callback then
        self.wake_callback = function() self:onRtcWake() end
    end
    local weekdays = wakeWeekdaysOnly()
    local delay = secondsUntil(hh, mm, 5, weekdays)
    local ok_remove = pcall(function() mgr:removeTasks(nil, self.wake_callback) end)
    local ok_add = pcall(function() mgr:addTask(delay, self.wake_callback) end)
    logEvent("wake", string.format("%s：排 RTC 唤醒 %02d:%02d%s（%d 秒后）%s",
        tostring(reason or ""), hh, mm, weekdays and " 仅工作日" or "", delay,
        (ok_remove and ok_add) and "OK" or "调用失败"))
end

-- 改 "HH:MM" 设置的通用对话框（定时息屏 / 开屏共用）
function Aiquota:showTimeDialog(opts, touchmenu_instance)
    local hh, mm = opts.get()
    self.time_dialog = InputDialog:new{
        title = opts.title,
        input = hh and string.format("%02d:%02d", hh, mm) or "",
        buttons = { { {
            text = "取消",
            callback = function() UIManager:close(self.time_dialog) end,
        }, {
            text = "保存",
            is_enter_default = true,
            callback = function()
                local value = (self.time_dialog:getInputText() or ""):gsub("%s", "")
                UIManager:close(self.time_dialog)
                local h2, m2 = value:match("^(%d%d?):(%d%d)$")
                h2, m2 = tonumber(h2), tonumber(m2)
                if value == "" then
                    if G_reader_settings then G_reader_settings:delSetting(opts.setting) end
                elseif h2 and h2 <= 23 and m2 <= 59 then
                    if G_reader_settings then
                        G_reader_settings:saveSetting(opts.setting, string.format("%02d:%02d", h2, m2))
                    end
                else
                    UIManager:show(InfoMessage:new{
                        text = "格式应为 HH:MM（如 18:30），小时 0-23、分钟 0-59；留空表示关闭",
                    })
                end
                if opts.after then opts.after() end
                if touchmenu_instance then touchmenu_instance:updateItems() end
            end,
        } } },
    }
    UIManager:show(self.time_dialog)
    self.time_dialog:onShowKeyboard()
end

-- 生成一个"每天定时 XX：18:30 / 已关闭"的菜单项
function Aiquota:timeMenuItem(label, setting, get, after)
    return {
        text_func = function()
            local hh, mm = get()
            return hh and string.format("%s：%02d:%02d", label, hh, mm) or (label .. "：已关闭")
        end,
        keep_menu_open = true,
        callback = function(touchmenu_instance)
            self:showTimeDialog({ title = label .. "（HH:MM，留空=关闭）", setting = setting, get = get, after = after },
                touchmenu_instance)
        end,
    }
end

function Aiquota:init()
    if self.ui and self.ui.menu then self.ui.menu:registerToMainMenu(self) end
    self.daily_task = function()
        local ok, err = pcall(function() self:maybeDailySleep() end)
        if not ok then logEvent("error", "daily sleep: " .. tostring(err)) end
        self:scheduleDailySleep()
    end
    self:scheduleDailySleep()
    -- 开机就先排一次 RTC 唤醒（真正确认在挂起时还会再排一次）
    if self.armDailyWake then self:armDailyWake("KOReader 启动") end
    if os.getenv("AIQUOTA_AUTOSHOW") then
        self:traceBoot("env")
        UIManager:scheduleIn(tonumber(os.getenv("AIQUOTA_AUTOSHOW")) or 3, function() self:showPanel() end)
        return
    end
    -- 一键打开：KUAL 入口写一次性标记；或用户开了"启动自动打开"。
    -- 等 KOReader 起完（文件管理器就绪）再弹。
    local auto_open = self:consumeOnceMarker()
    local via = auto_open and "once" or (self:autostartEnabled() and "autostart" or "no")
    if not auto_open then auto_open = self:autostartEnabled() end
    self:traceBoot(via)
    if auto_open then
        UIManager:scheduleIn(5, function() self:showPanel() end)
    end
end
function Aiquota:addToMainMenu(menu_items)
    menu_items.aiquota = {
        text = "AI 额度",
        sorting_hint = "tools",
        sub_item_table = {
            { text = "打开面板", callback = function() self:showPanel() end },
            { text = "面板打开时保持常亮（不自动休眠）",
              checked_func = function() return keepAwakeWanted() end,
              callback = function()
                  if not G_reader_settings then return end
                  if keepAwakeWanted() then
                      G_reader_settings:saveSetting(KEEP_AWAKE_SETTING, false)
                      disableKeepAwake()
                  else
                      G_reader_settings:delSetting(KEEP_AWAKE_SETTING)
                      if self.panel then enableKeepAwake() end
                  end
              end },
            { text = "面板打开时关闭前光（省电）",
              checked_func = function() return lightOffWanted() end,
              callback = function()
                  if not G_reader_settings then return end
                  if lightOffWanted() then
                      G_reader_settings:saveSetting(LIGHT_OFF_SETTING, false)
                      if keep_awake then restoreFrontlight(keep_awake) end
                  else
                      G_reader_settings:delSetting(LIGHT_OFF_SETTING)
                      if keep_awake then turnFrontlightOffForPanel(keep_awake) end
                  end
              end },
            { text = "面板打开时忽略磁吸套（防误休眠）",
              checked_func = function() return ignoreHallWanted() end,
              callback = function()
                  if not G_reader_settings then return end
                  if ignoreHallWanted() then
                      G_reader_settings:saveSetting(IGNORE_HALL_SETTING, false)
                      if keep_awake then restoreHall(keep_awake) end
                  else
                      G_reader_settings:delSetting(IGNORE_HALL_SETTING)
                      if keep_awake then ignoreHallForPanel(keep_awake) end
                  end
              end },
            { text = "按电源键可以手动息屏",
              checked_func = function() return manualSleepWanted() end,
              callback = function()
                  -- 勾上（默认）：常亮只用"推迟 powerd 空闲计时器"实现，电源键照常能睡。
                  -- 取消：改用 preventScreenSaver 硬锁，连电源键也挡（代价是手动息屏失效）。
                  if not G_reader_settings then return end
                  if self.panel then disableKeepAwake() end
                  if manualSleepWanted() then
                      G_reader_settings:saveSetting(MANUAL_SLEEP_SETTING, false)
                  else
                      G_reader_settings:delSetting(MANUAL_SLEEP_SETTING)
                  end
                  if self.panel then enableKeepAwake() end
              end },
            { text = "每小时整屏闪一次清残影（会看到闪屏）",
              checked_func = function() return cleanupFlashWanted() end,
              callback = function()
                  -- 默认关：面板平常只做局部刷新、绝不闪屏。开了就每小时整屏闪一次，
                  -- 残影更干净但会看到闪。环境变量 AIQUOTA_CLEANUP_FLASH=1 也可以打开。
                  if not G_reader_settings then return end
                  if cleanupFlashWanted() then
                      G_reader_settings:delSetting(CLEANUP_FLASH_SETTING)
                  else
                      G_reader_settings:saveSetting(CLEANUP_FLASH_SETTING, true)
                  end
              end },
            { text = "立即清残影（整屏闪一次）",
              enabled_func = function() return self.panel ~= nil end,
              callback = function()
                  if self.panel then
                      last_refresh = "full(手动)"
                      UIManager:setDirty(self.panel, "full")
                  end
              end },
            self:timeMenuItem("每天定时息屏", DAILY_SLEEP_SETTING, dailySleepTime, function()
                -- 改了时间就允许今天按新时间生效
                self.last_daily_sleep_date = nil
                self:scheduleDailySleep()
            end),
            self:timeMenuItem("每天定时开屏", DAILY_WAKE_SETTING, dailyWakeTime, function()
                self:armDailyWake("改了时间")
            end),
            { text = "开屏只在工作日（周一至周五）",
              checked_func = function() return wakeWeekdaysOnly() end,
              callback = function()
                  -- 默认勾上：周六周日不自动开屏（想周末也开就取消勾选）
                  if not G_reader_settings then return end
                  if wakeWeekdaysOnly() then
                      G_reader_settings:saveSetting(WAKE_WEEKDAYS_SETTING, false)
                  else
                      G_reader_settings:delSetting(WAKE_WEEKDAYS_SETTING)
                  end
                  self:armDailyWake("改了工作日设置")
              end },
            { text = "KOReader 启动时自动打开面板",
              checked_func = function() return self:autostartEnabled() end,
              callback = function() self:toggleAutostart() end, separator = true },
        },
    }
end
function Aiquota:showPanel()
    if self.panel then return end
    -- 弹面板前先确保栈底有文件管理器：面板是全屏 widget，若它成为唯一窗口，
    -- 关闭时窗口栈会变空 → KOReader 直接退出（闪回 Kindle 主页）。
    -- 必须用官方 FileManager:showFiles() 创建，不要自己 :new{}；
    -- 判断"栈里有没有别的窗口"，不要只看 FileManager.instance（它可能已不在栈中）。
    local FileManager = require("apps/filemanager/filemanager")
    if #(UIManager._window_stack or {}) == 0 then
        local dir = G_reader_settings and G_reader_settings:readSetting("lastdir")
        FileManager:showFiles(dir)
    end
    self.panel = Panel:new{ owner = self }
    UIManager:show(self.panel)
end
return Aiquota
