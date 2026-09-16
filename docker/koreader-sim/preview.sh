#!/usr/bin/env bash
set -euo pipefail
export DISPLAY=:99 EMULATE_READER_W=${EMULATE_READER_W:-1072} EMULATE_READER_H=${EMULATE_READER_H:-1448}
export EMULATE_READER_DPI=300 AIQUOTA_AUTOSHOW=3 TZ=CST-8
Xvfb :99 -screen 0 "${EMULATE_READER_W}x${EMULATE_READER_H}x24" -nolisten tcp >/out/xvfb.log 2>&1 &
sleep 1
cd /opt/koreader
: >/out/koreader.log
./AppRun >/out/koreader.log 2>&1 &
reader_pid=$!
trap 'kill "$reader_pid" 2>/dev/null || true' EXIT
for attempt in $(seq 1 25); do
    if grep -q 'aiquota: bounded fullscreen=' /out/koreader.log; then break; fi
    if ! kill -0 "$reader_pid" 2>/dev/null; then cat /out/koreader.log; exit 1; fi
    sleep 1
done
grep 'aiquota: bounded fullscreen=' /out/koreader.log
sleep 1
import -window root /out/shot.png
if [ "${AIQUOTA_TEST:-0}" = 1 ]; then
    xdotool mousemove 900 1370 click 1
    sleep 1
    import -window root /out/page-next.png
    xdotool mousemove 140 1370 click 1
    sleep 1
    import -window root /out/page-previous.png
    xdotool mousemove 980 85 click 1
    sleep 1
    import -window root /out/closed.png
    grep -q 'aiquota: closed' /out/koreader.log
fi
if grep -Eq 'stack traceback|aiquota text exceeds bounds' /out/koreader.log; then cat /out/koreader.log; exit 1; fi
