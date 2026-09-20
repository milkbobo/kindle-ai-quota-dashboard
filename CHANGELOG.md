# 更新记录

## 0.1.1 - 未发布

- Codex 采集器改为**自动发现 CLI**：Codex 桌面版每次升级都会换掉 exe 所在目录
  （内置包带版本号、它下载的副本带哈希），之前写死 `CODEX_CLI_PATH` 的做法升级后必然失效。
  现在按"能执行的概率"依次尝试 `OpenAI\Codex\bin\<哈希>\codex.exe`、`~/.codex/.sandbox-bin/codex.exe`、
  WindowsApps 内置包，最后才回退到 PATH 上的 `codex`；候选起不来（不存在 / 被 ACL 拒绝）才换下一个，
  能起来但查询失败（网络、鉴权）直接上报，避免把真实错误盖掉。`CODEX_CLI_PATH` 保留为可选覆盖项。
  注：WindowsApps 下的内置 exe 普通进程既不能列举也不能执行，所以它只作为最后兜底。
- KOReader 插件面板打开期间不再自动休眠：同时阻止 Kindle `powerd` 屏保定时器、
  KOReader AutoSuspend 的 15 分钟自动挂起和其它设备的 standby，关闭面板按原值还原；
  新增菜单开关与 `AIQUOTA_KEEP_AWAKE=0` 环境变量，面板底部显示「已禁止休眠」。
- 面板打开期间自动关闭前光（底部显示「前光已关」），关闭面板按原亮度点回；
  可用菜单开关或 `AIQUOTA_LIGHT_OFF=0` 关掉。
- 加入常亮看门狗（每分钟重设被系统事件重置的 `preventScreenSaver` / 暂停标志 / 熄灯状态）、
  刷新链路 pcall 兜底，以及 `/mnt/us/aiquota/sleep.log` 取证日志（心跳、挂起唤醒、面板开关、
  重新压下、刷新报错），用于区分"设备真休眠"与"刷新链断掉"。
- 面板打开期间忽略磁吸保护套：临时关闭霍尔传感器（直写 sysfs，不改 KOReader 全局设置），
  避免翻折的套子磁铁触发 `powerd` 挂起（该路径绕过 `preventScreenSaver`）；关闭面板恢复，
  可用菜单开关或 `AIQUOTA_IGNORE_HALL=0` 关掉。
- 修掉一处可能卡死 UI 的写法：`preventScreenSaver` 改用 KOReader 自带的 `liblipclua` 原生接口，
  不再每分钟 `io.popen` 起子进程；拿不到原生句柄时才回退命令行并降频到每 5 分钟。
- 每分钟只刷新时钟矩形（`setDirty(..., "partial", clock_region)`），整屏刷新只在数据变化 /
  每 5 分钟 / 每小时发生，削掉墨水屏上最重的操作。
- 取证日志新增 `slow-watchdog` / `slow-refresh`：单次系统调用耗时过长时写明耗时，用于定位卡顿源头。
- 常亮改为两种模式：**软模式（默认）**只用 `powerd:resetT1Timeout()` 推迟系统空闲屏保，
  **按电源键仍可手动息屏**；想看门狗式硬锁（连电源键也挡）可在菜单里取消「按电源键可以手动息屏」
  或设 `AIQUOTA_MANUAL_SLEEP=0`。之前默认用 `preventScreenSaver=1`，会导致手动息屏完全失效。
- 修掉关面板后偶发闪回原生主页：改为按"窗口栈里还有没有别的窗口"判断是否需要垫 FileManager，
  光看 `FileManager.instance` 在实例已不在栈中时不管用。
- **去掉面板上的时钟**，顺便去掉"每分钟刷新"：改为每 5 分钟（`AIQUOTA_REFRESH_SEC` 可调）拉云端 +
  重读本地快照，且**只在数据/状态/日期真的变化时才推墨水屏**，变了也只刷头部以下那块区域，
  每小时整屏闪一次清残影。数据不变时完全不刷屏，这是最直接的省电改动。
- 新增**每天定时开屏（硬件 RTC 唤醒）**：菜单里设时间（默认关闭），靠 KOReader 的 `WakeupMgr` → `powerd`
  的 `rtcWakeup`，设备睡着也会在指定时刻自己醒；闹钟在插件启动 / 面板挂起 / 被唤醒后各排一次
  （任务一次性）；不支持的设备只记日志；可用 `AIQUOTA_DAILY_WAKE=HH:MM` 覆盖。
- 新增**每天定时息屏**：菜单里设时间（默认关闭，例如 18:30），到点且面板开着时先画一屏黑底
  「已息屏」再让设备真休眠（墨水屏断电保留最后一帧，不自己画就像没关）；看书时（面板没开）不打扰；
  醒来后不会立刻又睡回去；准点用定时器 + 每 5 分钟核钟点兜底；也可用 `AIQUOTA_DAILY_SLEEP=HH:MM`。
- **默认不再整屏闪屏**：原来每小时会整屏闪一次清残影（真机 16:59 那次被用户抓到），现在改成默认关，
  整屏闪只在两个显式场景发生——打开面板时那一次（刻意清残影）、以及菜单里手动「立即清残影」；
  想要自动每小时清残影可用菜单开关或 `AIQUOTA_CLEANUP_FLASH=1`。关闭面板的刷新也从 `"full"` 改成
  不闪的 `"ui"`；取证日志新增 `refresh=` 字段写明每次刷新的类型。
- **修掉"定时息屏只黑屏、根本没休眠"的严重 bug**：KOReader 里 `Device.isEmulator` 是字符串标志
  （`"yes"`/`"no"`），Lua 里非空字符串恒为真，所以 `if Device.isEmulator then` 在真机上恒成立 →
  息屏只画了黑屏、从不调 `UIManager:suspend()`（实测后果：整夜清醒，15 小时掉 18% 电，
  RTC 定时开屏也不会触发）。改用 KOReader 自己的方法 `Device:isEmulator()`。
  另加两道保险：启动时把 `emulator/wakeup_mgr/canSuspend` 写进取证日志；息屏后若刷新任务仍在跑
  （说明没睡成）会自动补发 `suspend` 并记日志，连续 3 次失败则记录放弃原因。
- 定时开屏的"工作日"改为**真实工作日**：接入国务院节假日安排（含调休），法定假日不唤醒，
  调休上班的周末照常唤醒。数据由 `scripts/fetch-holidays.cjs`（`npm run holidays`）取回
  （源：NateScarlet/holiday-cn），保存在 `data/holidays.json`，随 `kindle.json` 快照发布；
  插件表里没有的日期退化成"周一~周五"。菜单项改为「开屏只在工作日（尊重法定节假日与调休）」。
- 新增 `scripts/watch-loop.cjs`（`npm run watch:loop`）作为**常驻采集器**：启动先检查是否已有实例
  （快照 5 分钟内更新过就退出，避免两个实例并发采集/推送），然后常驻跑 `npm run watch`，
  崩了 30 秒自动重启，输出追加到 `logs/refresh-watch.log`；配套 `scripts/start-watch.vbs` 无窗口启动，
  放进 `shell:startup` 即可开机自启（Windows 计划任务 `schtasks` 在部分环境被安全策略禁用）。
- 修掉插件菜单里「立即息屏（测试用）」「立即清残影」永远灰着点不动的问题：原来用
  `enabled_func` 要求"面板已打开"，但面板是全屏模态、开着就点不到菜单，两头对不上。
  现在两项都是"先打开面板、2 秒后再干活"。
- 取证日志的 `boot` 行新增 `boot_id` 与 `uptime`（读 `/proc/sys/kernel/random/boot_id`、
  `/proc/uptime`）：用来区分"设备真重启了"和"只是框架 UI 重来一遍"。
- 修复 `scripts/build-site.cjs` 在 Windows 上因 `dist/.git` 被文件保护占用而 EPERM 失败
  （导致 `npm run refresh` 整条管道中断、站点发布不出去）：清理 dist 时跳过 `.git`，
  其它文件清理失败也只警告不中断。
- 定时开屏默认**只在工作日**（周一至周五）生效，周末自动跳到下周一；菜单可改成每天都开。
- 息屏画面**不再显示时间**（静态屏画实时时间没意义，也容易让人误以为要刷新）；
  新增菜单项「立即息屏（测试用：画黑屏并真休眠）」，方便当场验证真休眠。
- 取证日志新增 `batt=` 电量百分比，用来实测"息屏到底省不省电"（每 5 分钟一条，可对比醒着/睡着的耗电速率）。
- KOReader 退出后把 `preventScreenSaver` 还给系统，避免进程被强杀导致 Kindle 永不休眠。
- 修复公开前检查在 Windows 路径和 Git 已忽略文件上的误报（感谢 @ChangeKuan 在 PR #2 中发现并提供修复）。
- 为 Kindle 页面加入短时有效缓存、数据结构校验、时间倒退保护和请求竞态保护。
- 明确标出临时采集失败后继续显示的旧值，避免把历史数据误认为实时结果。
- 修正文档中的实际前端入口、定时采集与同步说明。
- 增加持续集成和浏览器缓存回归测试，并兼容 Node.js 18 的 Windows 测试命令。
- Kindle 安装包版本号改为自动读取 `package.json`，避免发布文件名与项目版本不一致。
- 保持现有配置格式、默认四张卡片和 Kindle 页面入口不变。

## 0.1.0 - 2026-07-26

- 建立与私人生产仓库完全分离的开源代码仓库。
- 加入假数据模式、静态页面构建和本地预览。
- 将 DeepSeek、Claude、Codex、Kimi 拆成独立可选采集器。
- 加入 Kindle 安装包源码、卸载脚本和公开前敏感信息检查。
