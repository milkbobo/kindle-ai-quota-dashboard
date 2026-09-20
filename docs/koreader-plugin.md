# KPW3 / Paperwhite 第 7 代：KOReader 插件

本插件直接使用 KOReader 原生界面，全屏显示本地额度快照。以 1072×1448 竖屏为主要目标，不依赖 Kindle 浏览器。网页是另一个预览入口，使用相同的黑白设计。

![Docker 中运行的 KOReader 插件](koreader-preview.png)

## 安装

1. 把 `kindle/koplugin/aiquota.koplugin` 文件夹复制到 Kindle USB 盘的 `koreader/plugins/`。
2. 建立 USB 盘根目录下的 `aiquota/`，把 `examples/kindle.example.json` 复制进去并改名为 `data.json`，即可先看演示。
3. 安全弹出 USB，重启 KOReader，在顶部菜单 → 工具 → **AI 额度** 中打开。

已有插件时，覆盖同名插件目录里的两个 Lua 文件。安装包中的演示数据不是实时额度；已有自己的 `aiquota/data.json` 时可以保留。

## 使用

- 全屏白底，四周固定留白；长名称和说明自动省略，不越过卡片边框。
- 竖屏每页最多 4 项额度窗口；左右滑动或点击底部上一页 / 下一页切换。
- 点击右上角「关闭 ×」返回 KOReader；点按卡片不会误退出。
- **不打时钟、不空刷新**：面板上没有"每分钟都会变"的内容，所以每 5 分钟才拉一次云端并重读本地快照
  （可用 `AIQUOTA_REFRESH_SEC` 调整节奏），而且**只有屏幕上真会有变化时才推墨水屏**——
  数据没变就一次都不刷（省电的关键）。超过 15 分钟没有新数据时状态行会标成「旧数据」。
- **云端定时同步**：打开面板时和打开期间每 5 分钟，自动拉取最新 `kindle.json`。
  默认三个地址按序容灾：GitHub Pages → jsDelivr CDN → fastly.jsdelivr.net（国内网络下
  github.io 时通时断，jsDelivr 通常可达；部署脚本会在每次发布后 purge jsDelivr 缓存）。
  全部失败时保留旧数据继续显示，不弹窗。可用环境变量 `AIQUOTA_DATA_URL` 指定唯一地址。
  拉取是先显示本地数据再后台更新，断网不阻塞。Kindle 需要连 WiFi。
- 没有文件、无效 JSON、空列表会显示提示。面板打开期间**不自动休眠**且**关闭前光**，底部状态行会显示「已禁止休眠」「前光已关」；关闭面板后回到 KOReader 原有行为。
- **常亮（不自动休眠）**：面板一出现就会阻止三种各自独立的休眠路径——Kindle 系统 `powerd` 的屏保定时器、
  KOReader 自身 AutoSuspend 插件默认的「15 分钟无操作挂起」（`PluginShare.pause_auto_suspend`，Kindle 上这条会把整机送进屏保）、
  以及其它设备上的 `UIManager:preventStandby()`。关闭面板时按原值还原，不会覆盖你自己设的常亮。
  **注意"挡住自动休眠"不等于"锁死设备"**，分两种模式：
  - **软模式（默认）**：每分钟调用 KOReader 自带的 `powerd:resetT1Timeout()` 推迟 `powerd` 的空闲屏保计时器
    （KOReader 平时就是这么防止 powerd 抢在它前面睡的），**不设** `preventScreenSaver`。
    效果：设备不会自己睡，但**你按电源键依然能手动息屏**（电源键由 `powerd` 处理，KOReader 侧拿不到这个键，
    所以"识别到按键再放行"做不到）。
  - **硬锁模式**：设 `preventScreenSaver=1`，**连电源键也挡**（真机实测：按电源键毫无反应、日志里连
    `suspend` 都没有）。想要这个行为：菜单 → 工具 → AI 额度 → 取消「按电源键可以手动息屏」，
    或设 `AIQUOTA_MANUAL_SLEEP=0`。
  想关掉常亮本身：取消「面板打开时保持常亮」，或设 `AIQUOTA_KEEP_AWAKE=0`。
  注意常亮必然耗电（屏幕一直刷新），当桌面看板用建议插着 USB 供电。
- **睡着后屏幕不会变黑是正常的**：墨水屏断电保留最后一帧，如果 KOReader 的屏保被设成 `disable`
  （`screensaver_type`），睡着后画面就是原样停住，看起来像"没睡"或"卡住"。
  想一眼分辨，建议在 KOReader 里把屏保打开（例如显示文字），睡着后会画出屏保画面。
- **关闭前光**：面板打开时熄灯（墨水屏不点灯也看得清，长时间挂机省电），关闭面板时按原亮度点回。原来就没开灯则不会替你点灯。走的是 KOReader 的 `Device.powerd` 前光接口（`turnOffFrontlight` / `turnOnFrontlight`），KPW3 这类机型会把 0 真正写进 sysfs，是实打实的熄灯。
  想关掉这个行为：菜单 → 工具 → AI 额度 → 取消「面板打开时关闭前光」，或设环境变量 `AIQUOTA_LIGHT_OFF=0`。
- **忽略磁吸保护套**：磁吸套一合上，霍尔传感器会让 `powerd` 直接挂起（`HALL_SUSPEND`），这条路径**绕过**
  `preventScreenSaver`——把套子翻折到背面时磁铁正好贴在传感器附近，设备就会自己睡，而且不会自己醒。
  所以面板打开期间会临时把传感器关掉（直接写 `/sys/devices/system/wario_hall/wario_hall0/hall_enable`，
  **不改** KOReader 的 `kindle_hall_effect_sensor_enabled` 全局设置），关闭面板时恢复。
  代价：忽略期间合上套子也不会自动睡眠——这正是"永不息屏"想要的；不想要可在菜单 →
  工具 → AI 额度 → 取消「面板打开时忽略磁吸套」，或设环境变量 `AIQUOTA_IGNORE_HALL=0`。
- **每天定时息屏**：菜单 → 工具 → AI 额度 →「每天定时息屏：HH:MM」里设时间（例如 18:00；**留空=关闭**，
  默认关闭）。到点时如果**面板正开着**，会先画一屏黑底「已息屏」再让设备**真休眠**
  （`UIManager:suspend()`，等价于按电源键）——墨水屏断电会保留最后一帧，不自己画一屏的话看起来就像没关掉。
  息屏画面只有「已息屏」「按电源键即可唤醒」，**故意不显示时间**（这屏是静态的，画时间没意义）。
  - 只在面板开着时动手：正在看书时不会被强制息屏。
  - 醒来（按电源键/开套）后**不会立刻又睡回去**：如果目标是睡着时跨过去的，当天标记为已完成。
  - **会自查有没有真睡着**：真休眠时定时任务不会执行，所以若刷新任务在"息屏"状态下仍在跑，说明没睡成——
    日志里会记 `息屏后仍在运行 → 补发 suspend`，最多补发 3 次，仍不行则记一行放弃原因
    （常见原因：正插着 USB 充电、或 `powerd` 拒绝）。
  - 现场验证办法：菜单 →「立即息屏（测试用：画黑屏并真休眠）」——**它会先打开面板、2 秒后息屏**，
    然后按电源键唤醒；取证日志应出现 `auto-sleep → suspend → resume`，且休眠期间**没有** `tick`。
    （菜单只能在面板没打开时点到，所以这两个"立即执行"类菜单项都是"先开面板再干活"，
    不要用 `enabled_func` 去限制"面板必须已打开"，那样按钮永远是灰的、点不动。）
  - 想临时改时间/测试可以用环境变量 `AIQUOTA_DAILY_SLEEP=18:00`（优先于菜单设置）。
- **每天定时开屏（硬件 RTC 唤醒）**：菜单 →「每天定时开屏：HH:MM」设时间（例如 09:00；留空=关闭，
  默认关闭）。Kindle 的 RTC 闹钟由 KOReader 的 `WakeupMgr` 交给 `powerd` 的 `rtcWakeup` 属性，
  **设备睡着也会在指定时刻自己醒过来**，醒来后面板自动重画。
  - **默认只在工作日开屏**：判断依据是**真实工作日**，不是简单的"周一~周五"——
    法定节假日不唤醒，**调休上班的周末照常唤醒**（例如 2026-09-20 周日、2026-10-10 周六）。
    数据来自国务院办公厅每年的节假日安排（由 NateScarlet/holiday-cn 整理成 JSON），
    PC 端 `scripts/fetch-holidays.cjs`（`npm run holidays`）取回后写成 `data/holidays.json`，
    并随 `kindle.json` 快照一起发布；插件从快照里读（表里没有的日期退化成"周一~周五"，
    所以离线/旧快照也不会失控）。菜单 →「开屏只在工作日（尊重法定节假日与调休）」可关掉。
  - 闹钟必须在睡着之前排好，所以四个时机都会排一次：插件启动、面板挂起（手动按电源键也走这里）、
    定时息屏时、以及被 RTC 唤醒之后（任务是一次性的，醒来立刻给下一个工作日再排）。
  - 拿不到 `Device.wakeup_mgr`（例如广告版 Kindle）就只在取证日志里记一行、不报错。
  - 临时覆盖/测试可用环境变量 `AIQUOTA_DAILY_WAKE=09:00`、`AIQUOTA_DAILY_WAKE_WEEKENDS=1`（周末也开）。
  - 日志里能看到 `wake` 记录：`排 RTC 唤醒 09:00 仅工作日（54925 秒后）OK` / `被 RTC 定时唤醒`。
- **常亮看门狗与取证日志**：面板开着期间每分钟重新确认一次常亮仍然生效（`powerd` 的属性、AutoSuspend 暂停标志、
  熄灯状态、霍尔传感器都可能被 USB 拔插／框架重启／系统事件重置）；
  并把关键事件追加到 `/mnt/us/aiquota/sleep.log`（`tick` 每 5 分钟一条心跳、`suspend`/`resume` 挂起与唤醒、
  `open`/`close` 面板开关、`hall-off`/`hall-on` 传感器开关、`re-*` 被重置后重新压下、`error` 刷新出错、
  `slow-watchdog`/`slow-refresh` 单次调用耗时过长）。
  排查「面板卡住不更新」时插上电脑看这个文件即可分辨：
  心跳停在某刻且**有** `suspend` → 设备真的休眠了（看前一条 `re-lipc` 判断是不是属性被重置）；
  心跳断档但**没有** `suspend`/`resume` → KOReader 卡住而不是设备睡着，往下看有没有
  `slow-watchdog`/`slow-refresh`，那一行就指明了卡在哪个系统调用上；
  只有 `error` → 是刷新报错（已有 pcall 兜底，会自动恢复，不会卡死）。
- **不阻塞 UI 线程**（真机踩过的坑）：`preventScreenSaver` 的读写优先用 KOReader 自带的 `liblipclua`
  原生接口，**不再**每分钟 `io.popen`/`os.execute` 起子进程；只有拿不到原生句柄时才退化成命令行，
  并且回退模式下把重设频率降到每 5 分钟。原因见取证日志：真机出现过 11:37:02 之后近 4 分钟
  一次刷新都没有、随后进程彻底卡死（无 Lua 报错、无 suspend），而那条路径上唯一的系统调用就是
  每分钟一次的 lipc 子进程调用。
- **只在有变化时刷新（省电）+ 默认绝不闪屏**：面板不打时钟，刷新任务每 5 分钟只做"拉云端 + 重读本地快照 + 比较"：
  数据 / 状态行 / 日期都没变就**完全不刷屏**；变了才重画，而且只推**头部以下那块区域**
  （`setDirty(self, "ui", body_region)`，`"ui"` 是局部刷新、**不会闪**；KOReader 自身"每 N 次局部刷新提升为整屏刷"的
  机制只对 `"partial"` 生效，我们用 `"ui"` 所以不会被它偷偷升级成闪屏）。
  唯一**刻意**的闪屏是打开面板时那一次（`onShow` → `"full"`），用来清掉上一屏的残影；关闭面板用 `"ui"`，不闪。
  想整屏清残影：菜单 → 工具 → AI 额度 →「立即清残影（整屏闪一次）」，或打开
  「每小时整屏闪一次清残影」（默认关；也可用 `AIQUOTA_CLEANUP_FLASH=1`）。
  取证日志里的 `refresh=` 字段会写明每次刷新的类型，便于事后核对有没有闪屏。

## 一键打开（出门用）

两种方式，都不需要电脑：

1. **KUAL 入口**：Kindle 主界面打开 KUAL →「AI 额度面板」→「打开额度面板」。
   会自动启动 KOReader 并在 5 秒后弹出面板（实现：`extensions/aiquota/bin/launch.sh`
   写一次性标记 `/mnt/us/aiquota/autostart.once`，插件启动时消费该标记）。
2. **常开模式**：KOReader 菜单 → 工具 → AI 额度 →「KOReader 启动时自动打开面板」。
   勾上后每次进 KOReader 都直接弹面板（标记文件 `/mnt/us/aiquota/autostart`，
   再点一次取消）。

出门前 `npm run refresh` 一次，到了图书馆连上 WiFi，面板打开即拉最新数据
（三镜像容灾）；没网就显示出发前那份。

## 更新真实数据

电脑端一条命令完成「采集 → 导出 → 渲染图片 → 发布到 GitHub Pages」：

```bash
npm run refresh
```

发布后 Pages 上会有：网页版（`index.html` + `data.js`）、插件数据（`kindle.json`）、
渲染好的灰阶仪表盘图片（`dashboard-gray.png`）。`data.json` 和彩色 `dashboard.png` 仅保留在电脑本地，不上传。Kindle 上的插件会在
下个同步周期自动拉到新数据，无需 USB。也可以单独运行 `node scripts/export-kindle.cjs`
后把 `state/kindle.json` 复制到 Kindle 的 `aiquota/data.json`（USB / SSH 均可，
建议先传临时文件再重命名）。

**API 密钥只在电脑端使用，不会进入 Kindle，也不会发布到 Pages。**

## Docker 预览（Windows / macOS / Linux）

准备 Docker 和 Node.js 18+，下载 [KOReader 官方 Release](https://github.com/koreader/koreader/releases) 中的 Linux x86_64 AppImage，保存为 `docker/koreader-sim/koreader.AppImage`。

在仓库根目录运行：

```bash
npm run preview:koreader -- --build
npm run preview:koreader -- --test
# 使用已有真实快照，不会重新采集
npm run preview:koreader -- --data state/kindle.json
```

首次或 `--build` 时构建镜像，需要网络；之后用本地镜像，容器禁用网络。默认使用公开演示数据，插件代码直接只读挂载，修改插件后无需重新构建。

输出在 `state/koreader-preview/`：

- `shot.png`：1072×1448 全屏截图。
- `koreader.log`：KOReader 日志，包含实际屏幕尺寸与页码。
- `--test` 另生成翻页、返回上一页、关闭后的截图，并检查正常关闭。

云端同步的端到端测试：`docker/koreader-sim/test-cloud.sh`（容器内 `/test-cloud.sh`），
用本地 http 服务扮演 GitHub Pages，验证插件真实走网络拉取并刷新界面。

模拟器使用 [KOReader 官方屏幕环境变量](https://github.com/koreader/koreader/blob/master/kodev) 配置宽、高和 300 DPI；运行的是 KOReader Linux 版，不是网页截图。镜像只包含演示快照，唯一插件源码在 `kindle/koplugin/`。

## 已验证与限制

Docker 中已验证全屏、7 项额度分页、0% / 100%、超长中文、返回上一页和关闭；网页在原生像素和 1.5 倍像素比例下通过边界检查，包括 9 个额度窗口分页。模拟无法复现真机的残影、刷新速度、耗电或具体固件行为，仍需 KPW3 上确认。

## 数据格式

```json
{
  "updated": 1789435571,
  "updatedText": "09-15 09:26",
  "items": [
    { "name": "Codex · 5小时", "used": 12, "detail": "剩余 88% · 14:26 重置" },
    { "name": "某服务", "text": "未启用" }
  ]
}
```

`updated` 为 Unix 秒时间戳；`used` 是已用百分比，显示限制在 0–100。没有数值时只显示说明。
