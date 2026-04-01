#!/bin/sh
#
# 初始化 runner 侧 SSH 依赖与目标主机指纹。
# 这个脚本运行在 GitLab Runner 上，负责确保 git/ssh 可用，
# 写入部署私钥，并预先记录目标主机的 known_hosts。

set -eu

# 安装 runner 上部署链路所需的基础命令。
command -v git >/dev/null 2>&1 || apk add --no-cache git
command -v ssh >/dev/null 2>&1 || apk add --no-cache openssh-client

# 准备部署用 SSH 私钥和目标主机指纹。
mkdir -p "${HOME}/.ssh"
printf '%s' "${SSH_PRIVATE_KEY}" | tr -d '\r' > "${HOME}/.ssh/id_ed25519"
chmod 600 "${HOME}/.ssh/id_ed25519"
ssh-keyscan -H "${SERVER_HOST}" 2>/dev/null >> "${HOME}/.ssh/known_hosts"
