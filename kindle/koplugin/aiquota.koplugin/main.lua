local Device = require("device")
local Screen = Device.screen
local BB = require("ffi/blitbuffer")
local Font = require("ui/font")
local GestureRange = require("ui/gesturerange")
local InputContainer = require("ui/widget/container/inputcontainer")
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
local CLOUD_SYNC_SEC = 300  -- 打开期间每 5 分钟从镜像拉一次最新数据

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

local Panel = InputContainer:extend{ modal = true, covers_fullscreen = true, page = 1 }
function Panel:init()
    self.data = loadData()
    self:layout()
    self.cycles = 0
    -- 打开时先用本地数据显示，再异步拉云端；断网时不阻塞面板出现
    UIManager:scheduleIn(0.1, function()
        local ok, err = fetchCloud()
        logger.info("aiquota: cloud sync on open", ok, err)
        if self.data then
            self.data = loadData()
            self:layout()
            UIManager:setDirty(self, "ui")
        end
    end)
    self.refresh_task = function()
        UIManager:unschedule(self.refresh_task)
        self.cycles = self.cycles + 1
        if self.cycles * 60 >= CLOUD_SYNC_SEC then
            self.cycles = 0
            local cloud_ok, cloud_err = fetchCloud()
            logger.info("aiquota: cloud sync", cloud_ok, cloud_err)
        end
        self.data = loadData()
        self:layout()
        UIManager:setDirty(self, "ui")
        UIManager:scheduleIn(60, self.refresh_task)
    end
    UIManager:scheduleIn(60, self.refresh_task)
end
function Panel:layout()
    self.dimen = Screen:getSize()
    self.per_page = self.dimen.w > self.dimen.h and 2 or 4
    self.pages = math.max(1, math.ceil(#self.data.items / self.per_page))
    self.page = math.max(1, math.min(self.page, self.pages))
    self.ges_events = {
        Tap = { GestureRange:new{ ges = "tap", range = self.dimen } },
        Swipe = { GestureRange:new{ ges = "swipe", range = self.dimen } },
    }
    self.key_events = { Close = { { "Back" }, { "Esc" } }, Next = { { "Right" }, { "PgFwd" } }, Previous = { { "Left" }, { "PgBack" } } }
end
function Panel:onShow() UIManager:setDirty(self, "full"); return true end
function Panel:onClose() UIManager:close(self); return true end
function Panel:onCloseWidget()
    UIManager:unschedule(self.refresh_task)
    UIManager:setDirty(nil, "full")
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
function Panel:onResume() self.refresh_task(); return true end
function Panel:onSuspend() UIManager:unschedule(self.refresh_task); return true end

function Panel:paintTo(bb, x, y)
    local w, h = self.dimen.w, self.dimen.h
    local s = math.min(w / 1072, h / 1448)
    local pad = math.floor(w * 0.05)
    local iw = w - 2 * pad
    local function rect(rx, ry, rw, rh, color)
        bb:paintRect(x + math.floor(rx), y + math.floor(ry), math.floor(rw), math.floor(rh), color or BB.COLOR_BLACK)
    end
    -- Bound every text box and compensate for Font:getFace's device DPI scaling.
    local function text(value, tx, ty, tw, th, size, bold, right)
        local font_size = math.max(1, math.floor(size * s / (Screen:scaleBySize(100) / 100)))
        local widget
        repeat
            if widget then widget:free() end
            widget = TextWidget:new{ text = tostring(value or ""):gsub("[\r\n\t]", " "),
                face = Font:getFace("cfont", font_size), bold = bold or false,
                padding = 0, max_width = math.floor(tw), fgcolor = BB.COLOR_BLACK }
            font_size = font_size - 1
        until widget:getSize().h <= th or font_size < 1
        local size_px = widget:getSize()
        assert(size_px.h <= th and size_px.w <= tw + 1, "aiquota text exceeds bounds")
        widget:paintTo(bb, x + math.floor(tx + (right and tw - size_px.w or 0)), y + math.floor(ty))
        widget:free()
    end
    rect(0, 0, w, h, BB.COLOR_WHITE)
    rect(pad, pad, iw, math.max(2, 5 * s))
    text("AI / QUOTA JOURNAL", pad, pad + 18*s, iw*.70, 32*s, 23, true)
    text("关闭 ×", pad + iw*.76, pad + 12*s, iw*.24, 42*s, 25, true, true)
    text("算力有数。", pad, pad + 73*s, iw*.65, 87*s, 66, true)
    text(os.date("%H:%M"), pad + iw*.65, pad + 82*s, iw*.35, 76*s, 57, true, true)
    text("AI 额度监控 / 专注当下，心中有数", pad, pad + 174*s, iw*.70, 35*s, 24)
    text(os.date("%Y.%m.%d"), pad + iw*.7, pad + 174*s, iw*.3, 35*s, 23, false, true)
    local updated = tonumber(self.data.updated)
    local stale = not updated or os.time() - updated > 900
    local status = self.data.error or ((stale and "旧数据" or "已同步") .. " · " .. tostring(self.data.updatedText or "时间未知"))
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
    text("本地快照每分钟 · 云端每5分钟 · 左右滑动翻页", pad, h - pad - 23*s, iw, 32*s, 21)
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

function Aiquota:init()
    if self.ui and self.ui.menu then self.ui.menu:registerToMainMenu(self) end
    if os.getenv("AIQUOTA_AUTOSHOW") then
        UIManager:scheduleIn(tonumber(os.getenv("AIQUOTA_AUTOSHOW")) or 3, function() self:showPanel() end)
        return
    end
    -- 一键打开：KUAL 入口写一次性标记；或用户开了"启动自动打开"。
    -- 等 KOReader 起完（文件管理器就绪）再弹。
    local auto_open = self:consumeOnceMarker()
    if not auto_open then auto_open = self:autostartEnabled() end
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
            { text = "KOReader 启动时自动打开面板",
              checked_func = function() return self:autostartEnabled() end,
              callback = function() self:toggleAutostart() end, separator = true },
        },
    }
end
function Aiquota:showPanel()
    if self.panel then return end
    self.panel = Panel:new{ owner = self }
    UIManager:show(self.panel)
end
return Aiquota
