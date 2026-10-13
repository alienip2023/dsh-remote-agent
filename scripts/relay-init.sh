#!/usr/bin/env bash
# dsh-remote-relay 中继初始化（Linux / systemd 主机，幂等）。
#
# 做三件事：
#   1. 准备运行用户与数据目录（/var/lib/dsh-remote-relay，0700）
#   2. 生成/复用 token，写入 /etc/dsh-remote-relay/env（0600），文件里不含明文以外的东西
#   3. systemd 可用则装 unit 并 enable --now；否则打印可复制的 nohup 命令
#
# 幂等性：重复执行不会轮换 token、不会覆盖已有 env（除非 FORCE_ROTATE=1）。
# 用法：
#   sudo ./relay-init.sh                       # 默认 8890 / 0.0.0.0
#   sudo RELAY_PORT=9000 ./relay-init.sh
#   sudo FORCE_ROTATE=1 ./relay-init.sh        # 强制轮换 token（已入网副机需重新配置）
#   DRY_RUN=1 ./relay-init.sh                  # 只打印将要做的事
set -euo pipefail

RELAY_USER="${RELAY_USER:-dsh-relay}"
RELAY_GROUP="${RELAY_GROUP:-$RELAY_USER}"
RELAY_PORT="${RELAY_PORT:-8890}"
RELAY_HOST="${RELAY_HOST:-0.0.0.0}"
CONF_DIR="${CONF_DIR:-/etc/dsh-remote-relay}"
ENV_FILE="$CONF_DIR/env"
DATA_DIR="${DATA_DIR:-/var/lib/dsh-remote-relay}"
STATE_DIR="${STATE_DIR:-$DATA_DIR}"
NODE_BIN="${NODE_BIN:-$(command -v node || true)}"
UNIT_PATH="${UNIT_PATH:-/etc/systemd/system/dsh-remote-relay.service}"
FORCE_ROTATE="${FORCE_ROTATE:-0}"
DRY_RUN="${DRY_RUN:-0}"
LOG_FILE="${LOG_FILE:-/var/log/dsh-remote-relay.log}"

log()  { printf '%s\n' "[relay-init] $*"; }
warn() { printf '%s\n' "[relay-init][warn] $*" >&2; }
die()  { printf '%s\n' "[relay-init][error] $*" >&2; exit 1; }
run() {
  if [ "$DRY_RUN" = "1" ]; then
    printf '%s\n' "[dry-run] $*"
    return 0
  fi
  "$@"
}

[ "$(uname -s)" = "Linux" ] || warn "本脚本面向 Linux；当前 $(uname -s)，systemd 分支可能不适用。"
[ -n "$NODE_BIN" ] || die "找不到 node，请先安装 Node.js 22+ 或用 NODE_BIN=/path/to/node 指定。"
NODE_MAJOR="$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || die "需要 Node.js >= 22，当前 $("$NODE_BIN" --version)。"

# 解析本包根目录（脚本在 <pkg>/scripts/ 下）
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
RELAY_BIN="$PKG_DIR/bin/dsh-remote-relay.js"
[ -f "$RELAY_BIN" ] || die "找不到 $RELAY_BIN"

command -v openssl >/dev/null 2>&1 || die "需要 openssl 生成 token。"

if [ "$(id -u)" != "0" ] && [ "$DRY_RUN" != "1" ]; then
  die "需要 root（写 /etc 与 /var/lib、装 systemd unit）。用 sudo 重跑。"
fi

# ---------------------------------------------------------------- 1. 用户与目录
if ! id -u "$RELAY_USER" >/dev/null 2>&1; then
  log "创建系统用户 $RELAY_USER"
  run useradd --system --home-dir "$DATA_DIR" --create-home --shell /usr/sbin/nologin "$RELAY_USER" \
    || run adduser --system --home "$DATA_DIR" --no-create-home --group "$RELAY_USER"
fi

log "准备目录 $CONF_DIR(0700) $DATA_DIR(0700)"
run install -d -m 0700 -o root -g root "$CONF_DIR"
run install -d -m 0700 -o "$RELAY_USER" -g "$RELAY_GROUP" "$DATA_DIR"
run install -d -m 0750 -o "$RELAY_USER" -g "$RELAY_GROUP" "$STATE_DIR"

# ---------------------------------------------------------------- 2. token 与 env
gen_token() { printf '%s_%s\n' "$1" "$(openssl rand -base64 32 | tr -d '\n=+/' | cut -c1-32)"; }

HUB_TOKEN=""
ENROLL_TOKEN=""
if [ -f "$ENV_FILE" ] && [ "$FORCE_ROTATE" != "1" ]; then
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  HUB_TOKEN="${DSH_RELAY_HUB_TOKEN:-}"
  ENROLL_TOKEN="${DSH_RELAY_ENROLL_TOKEN:-}"
  log "复用 $ENV_FILE 中已有凭证（FORCE_ROTATE=1 可轮换）"
fi
if [ -z "$HUB_TOKEN" ] || [ -z "$ENROLL_TOKEN" ] || [ "$FORCE_ROTATE" = "1" ]; then
  HUB_TOKEN="${DSH_RELAY_HUB_TOKEN:-$(gen_token rt)}"
  ENROLL_TOKEN="${DSH_RELAY_ENROLL_TOKEN:-$(gen_token en)}"
  log "写入新凭证到 $ENV_FILE（0600）"
  if [ "$DRY_RUN" = "1" ]; then
    log "[dry-run] 跳过写 $ENV_FILE"
  else
    umask 077
    cat > "$ENV_FILE" <<EOF
# dsh-remote-relay 环境文件（0600）—— 由 scripts/relay-init.sh 生成，勿入版本库
DSH_RELAY_PORT=$RELAY_PORT
DSH_RELAY_HOST=$RELAY_HOST
DSH_RELAY_DATA_DIR=$DATA_DIR
DSH_RELAY_HUB_TOKEN=$HUB_TOKEN
DSH_RELAY_ENROLL_TOKEN=$ENROLL_TOKEN
EOF
    chmod 0600 "$ENV_FILE"
    chown root:root "$ENV_FILE"
  fi
fi
[ -n "$HUB_TOKEN" ] && [ -n "$ENROLL_TOKEN" ] || die "凭证生成失败"

# 顺手把凭证同步进 data-dir，供 `--print-tokens` 复用同一份
if [ "$DRY_RUN" != "1" ]; then
  TOKENS_JSON="$DATA_DIR/tokens.json"
  if [ ! -f "$TOKENS_JSON" ] || [ "$FORCE_ROTATE" = "1" ]; then
    umask 077
    printf '{\n  "version": 1,\n  "hubToken": "%s",\n  "enrollToken": "%s",\n  "createdAt": "%s"\n}\n' \
      "$HUB_TOKEN" "$ENROLL_TOKEN" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$TOKENS_JSON"
    chmod 0600 "$TOKENS_JSON"
    chown "$RELAY_USER:$RELAY_GROUP" "$TOKENS_JSON"
  fi
fi

# ---------------------------------------------------------------- 3. systemd / nohup
NO_HUB_TOKEN="$(printf '%s' "$HUB_TOKEN" | sha256sum | cut -c1-12)"
NO_ENROLL_TOKEN="$(printf '%s' "$ENROLL_TOKEN" | sha256sum | cut -c1-12)"

if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then
  log "安装 systemd unit: $UNIT_PATH"
  if [ "$DRY_RUN" = "1" ]; then
    log "[dry-run] 跳过写 unit 与 systemctl"
  else
    cat > "$UNIT_PATH" <<EOF
[Unit]
Description=dsh-remote-agent relay (addressing + forwarding only)
Documentation=https://github.com/example/dsh-remote-agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RELAY_USER
Group=$RELAY_GROUP
WorkingDirectory=$PKG_DIR
EnvironmentFile=$ENV_FILE
ExecStart=$NODE_BIN $RELAY_BIN --port \${DSH_RELAY_PORT} --host \${DSH_RELAY_HOST} --data-dir \${DSH_RELAY_DATA_DIR}
Restart=always
RestartSec=3
KillSignal=SIGTERM
TimeoutStopSec=20
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=$DATA_DIR
StandardOutput=journal
StandardError=journal
SyslogIdentifier=dsh-remote-relay

[Install]
WantedBy=multi-user.target
EOF
    chmod 0644 "$UNIT_PATH"
    systemctl daemon-reload
    systemctl enable --now dsh-remote-relay.service
    log "已启动：systemctl status dsh-remote-relay"
    log "查看日志：journalctl -u dsh-remote-relay -f"
    log "健康检查：curl -fsS http://127.0.0.1:$RELAY_PORT/healthz"
  fi
else
  warn "systemd 不可用，打印手动启动命令（nohup）。"
  cat <<EOF

# ---- 手动启动（nohup 版，可直接复制；token 从 $DATA_DIR/tokens.json 读，不进命令行） ----
sudo -u $RELAY_USER env \\
  DSH_RELAY_PORT=$RELAY_PORT DSH_RELAY_HOST=$RELAY_HOST \\
  nohup $NODE_BIN $RELAY_BIN --port $RELAY_PORT --host $RELAY_HOST --data-dir $DATA_DIR \\
  >> $LOG_FILE 2>&1 &

# 健康检查
curl -fsS http://127.0.0.1:$RELAY_PORT/healthz

# 停止
pkill -f 'dsh-remote-relay.js' || true

# ---- 也可以直接跑前台（首次排障推荐） ----
$NODE_BIN $RELAY_BIN --port $RELAY_PORT --host $RELAY_HOST --data-dir $DATA_DIR

# ---- 需要明文 token 时（只显示一次，别重定向进文件） ----
$NODE_BIN $RELAY_BIN --print-tokens --data-dir $DATA_DIR
EOF
fi

# ---------------------------------------------------------------- 汇总（只打指纹）
cat <<EOF

[relay-init] 完成
  监听        : $RELAY_HOST:$RELAY_PORT
  凭证文件    : $ENV_FILE (0600, 仅指纹如下)
  hub 指纹    : $NO_HUB_TOKEN
  enroll 指纹 : $NO_ENROLL_TOKEN
  明文 token  : 用 sudo cat $ENV_FILE 查看，或用
                $NODE_BIN $RELAY_BIN --print-tokens --data-dir $DATA_DIR
  副机配置    : profiles/worker.cordis.yml → relayUrl=ws://<本机IP>:$RELAY_PORT/relay
  防火墙      : 放行 tcp/$RELAY_PORT（仅对副机网段，别对全网开）
EOF
