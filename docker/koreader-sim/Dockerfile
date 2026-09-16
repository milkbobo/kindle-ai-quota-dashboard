# KOReader 模拟环境：在 1072x1448 的 Xvfb 虚拟屏上跑 KOReader Linux 版，
# 用于无 Kindle 时调试/预览 aiquota.koplugin（KPW3 屏幕比例）。
#
# 国内网络：基础镜像走 daocloud 镜像源，apt 走阿里云源。
FROM docker.m.daocloud.io/library/ubuntu:24.04
ENV DEBIAN_FRONTEND=noninteractive
RUN sed -i 's|http://archive.ubuntu.com|http://mirrors.aliyun.com|g; s|http://security.ubuntu.com|http://mirrors.aliyun.com|g; s|https://archive.ubuntu.com|http://mirrors.aliyun.com|g; s|https://security.ubuntu.com|http://mirrors.aliyun.com|g' /etc/apt/sources.list.d/ubuntu.sources 2>/dev/null \
    || sed -i 's|http://archive.ubuntu.com|http://mirrors.aliyun.com|g; s|http://security.ubuntu.com|http://mirrors.aliyun.com|g' /etc/apt/sources.list \
    ; apt-get update && apt-get install -y --no-install-recommends \
        xvfb imagemagick x11-utils xdotool \
        libgl1 libegl1 libopengl0 libglu1-mesa \
        libx11-6 libxext6 libxrender1 libxfixes3 libxi6 libxcursor1 \
        libxrandr2 libxinerama1 libxkbcommon0 \
        libasound2t64 libpulse0 libnss3 \
        libgl1-mesa-dri libegl-mesa0 \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /out
WORKDIR /opt
COPY docker/koreader-sim/koreader.AppImage /tmp/koreader.AppImage
RUN chmod +x /tmp/koreader.AppImage \
    && /tmp/koreader.AppImage --appimage-extract > /dev/null \
    && rm /tmp/koreader.AppImage \
    && mv squashfs-root koreader

COPY kindle/koplugin/aiquota.koplugin /opt/koreader/usr/lib/koreader/plugins/aiquota.koplugin
COPY examples/kindle.example.json /mnt/us/aiquota/data.json
COPY docker/koreader-sim/preview.sh /preview.sh
COPY docker/koreader-sim/test-cloud.sh /test-cloud.sh
CMD ["bash", "/preview.sh"]
