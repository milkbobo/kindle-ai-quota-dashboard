#!/bin/sh
# KUAL「AI 额度面板」入口：写一次性标记后启动 KOReader，
# aiquota 插件看到标记会在启动 5 秒后自动弹出额度面板。
#
# 用后台方式启动并立即返回：KUAL 菜单不会被"等待"卡住；
# koreader.sh 的全部输出落到 /mnt/us/aiquota/launch.log 供排查。
LOG=/mnt/us/aiquota/launch.log
{
    echo "=== launch $(date) ==="
    mkdir -p /mnt/us/aiquota
    touch /mnt/us/aiquota/autostart.once
    echo "marker ok, PATH=$PATH"
} >>"$LOG" 2>&1

cd /mnt/us/koreader || { echo "FATAL: cd /mnt/us/koreader failed" >>"$LOG"; exit 1; }
./koreader.sh --kual >>"$LOG" 2>&1 &
echo "koreader.sh started in background (pid $!)" >>"$LOG"
exit 0
