# Kindle 兼容性

## 已验证范围

首个开源候选版本只声明支持我们实际验证过的 KPM 平台：

- `kindlehf`
- `kindlepw2`

它依赖越狱环境中的 KPM、`kindle_browser`、`lipc-*`、`eips` 和 Kindle GUI 服务。设备代号相同也不代表所有固件行为完全一致。

## 风险

启动器会暂时停止 Kindle 原生 GUI、禁止屏保并启动内置浏览器。退出脚本负责恢复 GUI。固件升级可能改变服务名、浏览器路径或电源键事件格式。

首次测试前：

1. 保留 SSH 或 KTerm 恢复手段。
2. 确认能够执行退出脚本。
3. 不要在未列入兼容表的设备上直接长期运行。
4. 先用 KPM 卸载流程验证可恢复，再把它作为常驻面板。

## Paperwhite 第七代页面

默认展示 Codex 和 Z.ai，使用纯白背景、黑色用量条和中文重置时间。网页采用固定视口与 Flex 布局，无动画和在线字体；每页最多两张服务卡片，每张最多两个额度窗口，额外内容分页。KPW3 使用原生 KOReader 插件，安装方式见 [插件说明](koreader-plugin.md)。

在 `config.json` 中设置 `"displayProviders": ["codex", "zai"]` 控制展示顺序。以后可加入已有采集器的名称，例如 `claude`、`kimi`、`deepseek`；新服务需要先接入采集器。卡片按实际返回的额度窗口生成，不限制为两个窗口。

Z.ai 配置参考 `config.example.json` 的 `providers.zai`，启用时设 `enabled: true`，并在运行采集器的环境中设置 `ZAI_API_KEY`。运行 `npm run collect`、`npm run build` 后更新页面。未配置的服务显示“未接入”，采集失败保留的额度显示“旧数据”。`npm run demo` 生成明确标记的演示数据，会覆盖 `state` 中当前快照。

页面截图检查使用 1072×1448 竖屏，以及渲染脚本默认的 1.5 倍像素比例。浏览器模拟验证不代表已在 Kindle 固件上实测。
