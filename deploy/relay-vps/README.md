# dsh-remote-relay VPS 部署模板

一台公网小 VPS，把「双方都在 NAT 后」的 hub 与 node 会合到一起。
本目录是**可直接抄的部署模板**；想一条命令装完请用仓库里的
`scripts/relay-init.sh`（幂等，自动生成 unit 与凭证）—— 两者等价，
本目录的存在是为了让人**在装之前就能看到将要发生的一切**。

> 中继只做寻址与转发：不存任务、不碰产物字节、不解析业务帧。
> 它挂了任务照跑（副机本地持久执行，重连后 task/sync 对账）——
> 这是设计使然，见 profiles/README.md 的降级链一节。

---

## 0. 装之前想清楚的三件事

1. **端口**：默认 `8890/tcp`。只给这两台机器用就把来源限到它们的出口 IP，
   别对 `0.0.0.0/0` 开。
2. **TLS**：只要中继暴露在公网，就必须前置 TLS 用 `wss://`
   （明文 `ws://` 下 token 与业务帧都在裸奔）。模板见
   [`Caddyfile`](./Caddyfile)（自动证书，最省事）或
   [`nginx.conf`](./nginx.conf)（已有证书/自有 nginx 时用）。
3. **凭证**：`hubToken` / `enrollToken` 一对，中继机器上生成，
   **只走加密信道交给两端**。日志里只出现 12 位指纹，别把明文贴进工单。

## 1. 五分钟上手（推荐：一键脚本）

```bash
# 在 VPS 上，进入包根（把仓库 scp/rsync 过去，或 git clone）
sudo ./scripts/relay-init.sh                  # 默认 8890 / 0.0.0.0；幂等
#   RELAY_PORT=9000 sudo ./scripts/relay-init.sh   # 换端口
#   DRY_RUN=1 ./scripts/relay-init.sh              # 只看动作不落盘
#   sudo FORCE_ROTATE=1 ./scripts/relay-init.sh    # 轮换凭证（已入网副机要重配）

# 拿明文 token（只打一次；别重定向进文件、别贴聊天记录）
node bin/dsh-remote-relay.js --print-tokens --data-dir /var/lib/dsh-remote-relay
# → RELAY_TOKENS hub=rt_... enroll=en_... source=file

# 自检
curl -fsS http://127.0.0.1:8890/healthz
# → {"ok":true,"protocol":1,"nodes":0,"hubs":0,"stats":{...}}
journalctl -u dsh-remote-relay -f     # 看 RELAY_READY 与事件 JSON 行
```

脚本做三件事：建系统用户与数据目录（0700）→ 生成/复用凭证写
`/etc/dsh-remote-relay/env`（0600）→ 装 systemd unit 并 `enable --now`。
没有 systemd 的机器会打印可复制的 nohup 命令。重复执行不会轮换 token。

## 2. 手动安装（不用脚本时）

```bash
# ① 用户与目录
sudo useradd --system --home-dir /var/lib/dsh-remote-relay \
  --create-home --shell /usr/sbin/nologin dsh-relay
sudo install -d -m 0700 -o root -g root /etc/dsh-remote-relay
sudo install -d -m 0700 -o dsh-relay -g dsh-relay /var/lib/dsh-remote-relay

# ② 凭证（env 模板抄自本目录 relay.env.example，改占位符）
sudo install -m 0600 -o root -g root relay.env.example /etc/dsh-remote-relay/env
sudo -u dsh-relay node bin/dsh-remote-relay.js \
  --data-dir /var/lib/dsh-remote-relay    # 首次自动生成 tokens.json

# ③ unit（模板抄自本目录 dsh-remote-relay.service，改 <占位符>）
sudo install -m 0644 dsh-remote-relay.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now dsh-remote-relay
```

## 3. 防火墙 / 云安全组

| 云 | 做法 |
|---|---|
| 阿里云 / 腾讯云 等安全组 | 放行 `tcp/8890`，来源填两台机器的出口 IP |
| `ufw` | `ufw allow from <副机IP> to any port 8890 proto tcp` |
| `firewalld` | 加 rich rule，source 限两台机器 |
| 裸机 iptables | `-p tcp --dport 8890 -s <IP> -j ACCEPT`，默认 DROP |

套了 TLS 前置时，反向代理监听 443，中继本体只听 `127.0.0.1`——
公网根本看不到 8890（`Caddyfile` / `nginx.conf` 模板即此形态）。

## 4. TLS 前置（公网必做）

```bash
# Caddy（自动申请/续期证书；把 <域名> 换成你的）
sudo cp Caddyfile /etc/caddy/Caddyfile && sudo systemctl reload caddy
```

```bash
# nginx（证书用自己的；两个模板都要抄：sites-available + include 段）
sudo cp nginx.conf /etc/nginx/sites-available/dsh-relay
sudo ln -s /etc/nginx/sites-available/dsh-relay /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
```

套上之后两端地址全部换成 `wss://<域名>/relay`（端口 443 省略）：
hub 的 `relay.url`、node 的 `relayUrl` 一起换，token 不变。
healthz 与 `/api/relay/*` 也走 443（模板已含 HTTP 透传）。

## 5. 验证连通

```bash
# ① 中继活着（有 TLS 时走 https）
curl -fsS https://<域名>/healthz

# ② 副机入网后，节点目录（只读；token 用 hub 那一半）
curl -fsS "https://<域名>/api/relay/nodes?token=rt_xxx"
# → {"nodes":[{"nodeId":"slave-pc","os":"windows","since":...,"lastSeen":...}]}

# ③ hub 侧：DSH 里 remote_nodes → online:true
```

**对指纹，不对明文**：中继日志的 `RELAY_READY ... hub=<12位> enroll=<12位>`
与两端配置的来源必须是同一套。`nodes:0` 但副机说 online → 两端 token 不是
一套；`hubs:0` → hub 的 `relay.url`/`relay.token` 不对。

## 6. 轮换、备份、卸载

```bash
# 轮换（会让已入网副机全部掉线，提前打招呼）
sudo FORCE_ROTATE=1 ./scripts/relay-init.sh
node bin/dsh-remote-relay.js --print-tokens --data-dir /var/lib/dsh-remote-relay

# 备份只需一个文件（凭证真身）
sudo tar czf relay-tokens.tgz /etc/dsh-remote-relay/env

# 卸载（数据目录里没有任务状态，删不心疼）
sudo systemctl disable --now dsh-remote-relay
sudo rm -f /etc/systemd/system/dsh-remote-relay.service
sudo rm -rf /etc/dsh-remote-relay /var/lib/dsh-remote-relay
```

---

*端到端配置片段与排障表见 [profiles/README.md](../../profiles/README.md)。*
