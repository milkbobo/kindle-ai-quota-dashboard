' 无窗口启动"AI 额度看板"的常驻采集器（开机自动后台运行用）。
'
' 用法：把本文件（或它的快捷方式）放进开机启动目录 —— Win+R → shell:startup。
'      项目移动过的话，改一下下面那行路径即可。
' 它启动的是 scripts\watch-loop.cjs：会先检查是否已有实例在跑（有就退出，不会起第二个），
' 然后常驻执行 npm run watch，崩了 30 秒后自动重启，日志写到 <项目>\logs\refresh-watch.log。
' 停止办法：任务管理器里结束 node.exe，或把启动目录里这个文件删掉。
Set sh = CreateObject("WScript.Shell")
sh.Run "node ""D:\project\kindle-ai-quota-dashboard\scripts\watch-loop.cjs""", 0, False
