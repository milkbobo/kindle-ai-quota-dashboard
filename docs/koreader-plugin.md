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
- 每分钟重新读取本地文件和更新时钟；超过 15 分钟的快照标为「旧数据」。
- **云端定时同步**：打开面板时和打开期间每 5 分钟，自动拉取最新 `kindle.json`。
  默认三个地址按序容灾：GitHub Pages → jsDelivr CDN → fastly.jsdelivr.net（国内网络下
  github.io 时通时断，jsDelivr 通常可达；部署脚本会在每次发布后 purge jsDelivr 缓存）。
  全部失败时保留旧数据继续显示，不弹窗。可用环境变量 `AIQUOTA_DATA_URL` 指定唯一地址。
  拉取是先显示本地数据再后台更新，断网不阻塞。Kindle 需要连 WiFi。
- 没有文件、无效 JSON、空列表会显示提示。休眠与唤醒沿用 KOReader 的设备行为，不禁用系统休眠。

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
渲染好的仪表盘图片（`dashboard.png` / `dashboard-gray.png`）。Kindle 上的插件会在
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
