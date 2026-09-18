#!/bin/sh
# KUAL「AI 额度面板」入口：写一次性标记后启动 KOReader，
# aiquota 插件看到标记会在启动 5 秒后自动弹出额度面板。
#
# 重要：vfat 分区不保存 POSIX 权限位，从 Windows 写入的 .sh 常常没有 +x。
#       所以本脚本内部一律用 "/bin/sh <绝对路径>" 显式解释执行，
#       绝不依赖 ./script 这种需要 +x 的写法。
LOG=/mnt/us/aiquota/launch.log
KO_DIR=/mnt/us/koreader

mkdir -p /mnt/us/aiquota 2>/dev/null
{
    echo "=== launch $(date) ==="
    touch /mnt/us/aiquota/autostart.once
    echo "marker ok, PATH=$PATH"
} >>"$LOG" 2>&1

# 启动前修复关键二进制的执行权限（vfat 上常丢失）
for _f in luajit dropbear fbink tar sdcv scp sftp-server wmctrl dbclient zsync2 reader.lua; do
    if [ -f "${KO_DIR}/${_f}" ] && [ ! -x "${KO_DIR}/${_f}" ]; then
        chmod 755 "${KO_DIR}/${_f}" 2>>"$LOG"
    fi
done
unset _f

# 用 /bin/sh 显式解释执行（不依赖 koreader.sh 自身的 +x）
cd "${KO_DIR}" || { echo "FATAL: cd ${KO_DIR} failed" >>"$LOG"; exit 1; }
# === 修复 (2026-09-15) ===
# 补 --framework_stop：否则 Kindle 框架会把画面抢回主页
# （现象：启动后闪现回主页）。
# === 修复 (2026-09-16) ===
# 用子 shell 包住 KOReader：它退出后（正常退出或被 kill）把常亮还给系统。
# 插件打开面板时会把 powerd 的 preventScreenSaver 设为 1；若 KOReader 被强杀
# 来不及还原，Kindle 会一直不休眠（耗电，原生界面也不再自动息屏）。
(
    /bin/sh /mnt/us/koreader/koreader.sh --kual --framework_stop
    lipc-set-prop com.lab126.powerd preventScreenSaver 0
    echo "koreader.sh exited, preventScreenSaver reset to 0"
) >>"$LOG" 2>&1 &
echo "koreader.sh started in background (pid $!)" >>"$LOG"
exit 0
