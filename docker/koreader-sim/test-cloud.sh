#!/usr/bin/env bash
# 端到端验证插件的云端同步：
#   用 KOReader 自带 luajit 起一个本地 http 服务扮演 GitHub Pages，
#   数据里打上"云端同步 OK"标记；AIQUOTA_DATA_URL 指向它，
#   插件拉取成功后，面板状态栏应显示该标记，日志出现 cloud sync true。
set -euo pipefail
mkdir -p /cloud
sed 's/"updatedText": "[^"]*"/"updatedText": "云端同步 OK"/' /mnt/us/aiquota/data.json > /cloud/data.json
grep -q '云端同步 OK' /cloud/data.json

cat > /srv.lua <<'LUA'
local socket = require("socket")
local server = assert(socket.bind("127.0.0.1", 8099))
local f = io.open("/cloud/data.json", "rb")
local body = f:read("*a"); f:close()
local header = "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
    .. #body .. "\r\nConnection: close\r\n\r\n"
while true do
    local client = server:accept()
    client:settimeout(2)
    local req = client:receive("*l")
    while req and req ~= "" do req = client:receive("*l") end
    if req then client:send(header .. body) end
    client:close()
end
LUA
(cd /opt/koreader/usr/lib/koreader \
    && LUA_PATH="/opt/koreader/usr/lib/koreader/common/?.lua;/opt/koreader/usr/lib/koreader/common/?/init.lua" \
       LUA_CPATH="/opt/koreader/usr/lib/koreader/common/?.so" \
       ./luajit /srv.lua >/out/httpd.log 2>&1 &)
sleep 1
if [ -s /out/httpd.log ]; then echo '--- httpd 启动失败 ---'; cat /out/httpd.log; exit 1; fi

export AIQUOTA_DATA_URL=http://127.0.0.1:8099/data.json
bash /preview.sh
echo "--- cloud sync log ---"
grep 'aiquota: cloud sync' /out/koreader.log || (echo '缺少云端同步日志'; cat /out/httpd.log; exit 1)
