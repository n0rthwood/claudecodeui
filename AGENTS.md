# AGENTS.md — claudecodeui (cloudcli) 部署与运维说明

> 本文件是项目的运维/部署事实来源。`CLAUDE.md` 是指向本文件的软链接，
> 因此 Claude Code 与 Codex / 其它 agent 读取的是同一份内容。

## 0. 仓库

- 远程：`git@github.com:n0rthwood/claudecodeui.git`（`origin`）
- 主分支：`main`
- 上游原始项目：`siteboon/claudecodeui`（仅历史来源，当前 origin 已指向 n0rthwood fork）

## 1. 本地部署 + ZeroTier 远程访问

本系统**本地部署**在内网服务器上，对外通过 **ZeroTier 虚拟网 IP** 供用户远程访问。
应用进程监听本机端口（见下方 caddy 反代目标，例如 `:3001`）。

## 2. 公网访问：Caddy 反向代理

有一台公网服务器 `root@admin.joysort.cn` 运行 Caddy，通过域名
`ahcXXX.joysort.cn` 反代到对应主机的 ZeroTier IP。

**如何根据本机推导部署域名：**
取本机 ZeroTier IP 的最后一段数字。例如本机 `172.30.3.202` → `202` → 域名 `ahc202.joysort.cn`。

```bash
# 本机 zerotier IP
ip -4 addr show | grep -oE '172\.30\.[0-9]+\.[0-9]+'
```

**查看/编辑该域名的 caddy 配置**（在公网服务器上）：

```bash
ssh root@admin.joysort.cn 'cat /etc/caddy/conf.d/ahc202.caddy'   # 把 202 换成你的尾号
```

配置范式（已存在 `ahc187.caddy`、`ahc202.caddy` 等可参考）：

```caddy
ahc202.joysort.cn {
    tls {
        dns alidns {
            access_key_id "<alidns-key-id>"
            access_key_secret "<alidns-key-secret>"
        }
    }
    handle {
        reverse_proxy 172.30.3.202:3001 {
            header_up X-Forwarded-Proto {scheme}
            header_up X-Forwarded-For {remote_host}
            flush_interval -1
        }
    }
}
```

新增配置后在公网服务器 reload：`ssh root@admin.joysort.cn 'caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy'`

## 3. 编译与 PM2 重启（关键：必须 nohup 进程分离）

本程序通过 PM2 部署，进程名 **`cloudcli`**，运行 `dist-server/server/index.js`（构建产物）。
**改完代码必须先编译再重启**，否则改动不生效（运行的是 `dist-server/`，不是源码）。

```bash
npm run build          # 编译 client + server (vite + tsc → dist/ 和 dist-server/)
# 仅改服务端可用： npm run build:server
```

⚠️ **重启必须用 `nohup` 与当前进程分离**。因为本程序会拉起 `claude` CLI / `codex` 等子进程，
agent 自身可能就跑在 cloudcli 之内，直接 `pm2 restart` 会把自己杀掉导致重启动作中断、失败。

```bash
nohup bash -c 'sleep 1; pm2 restart cloudcli --update-env' >/tmp/cloudcli-restart.log 2>&1 &
# 几秒后再检查： pm2 list | grep cloudcli ; pm2 logs cloudcli --lines 20 --nostream
```

## 4. 已部署主机 / 从零部署流程

**当前已部署的主机（ZeroTier IP）：**

| 主机 IP        | 备注          | 推导域名            |
|----------------|---------------|---------------------|
| 172.30.3.187   | 偶尔会掉线    | ahc187.joysort.cn   |
| 172.30.3.202   | 本机          | ahc202.joysort.cn   |
| 172.30.3.110   |               | ahc110.joysort.cn   |
| 172.30.3.109   |               | ahc109.joysort.cn   |
| 172.30.3.39    |               | ahc39.joysort.cn    |

**如果某主机尚未部署、用户要求新部署，按「本机模式」操作：**

1. **拉代码并编译**
   ```bash
   git clone git@github.com:n0rthwood/claudecodeui.git
   cd claudecodeui
   npm install
   npm run build
   ```
2. **PM2 启动**（首次）
   ```bash
   pm2 start npm --name cloudcli -- run server     # 运行 dist-server/server/index.js
   pm2 save
   ```
   后续更新一律走第 3 节的 nohup 重启。
3. **配置公网域名**：按本机 ZeroTier IP 尾号推导 `ahcXXX.joysort.cn`，
   参照第 2 节在 `root@admin.joysort.cn:/etc/caddy/conf.d/` 下新建 `ahcXXX.caddy`
   （复制已有配置改 IP 和域名即可），validate 后 reload caddy。
4. **初始化数据库默认账号**：创建默认用户 `bill` / `joysoRt2020!`。
   数据库为 SQLite（better-sqlite3），可用 `sqlite3` CLI 查看：
   ```bash
   which sqlite3 || sudo apt-get install -y sqlite3   # 没有就装
   # 找到数据库文件（通常在项目 data/ 目录或 server 配置指定路径）
   find . -name '*.db' -o -name '*.sqlite*' 2>/dev/null
   sqlite3 <db路径> 'SELECT id, username FROM users;'   # 查看/核对账号
   ```
   密码为 bcrypt 哈希，首次访问 Web UI 的注册/初始化流程创建 `bill` 账号即可，
   或参照已部署主机的 users 表数据导入。

## 协作约定（agent 工作方式 / 必读）

- **称呼**：每次回复用户时，以「**勤奋的老大**」开头称呼对方。
- **主进程只做 orchestration（编排），不亲自执行具体任务**。所有任务都派发给子 agent：
  - **模型选择**：简单的事用轻量模型（如 haiku / sonnet），复杂的事用高级模型（如 opus）。
  - **分发任务时给足上下文**：每次都要认真思考如何给出正确、充分的上下文，以确保子 agent 效果最好。
  - **独立任务并行派发**（同一轮发出多个 agent）。
- **主进程职责**：
  1. 分发任务（带足够上下文）；
  2. 汇总子 agent 返回的内容；
  3. 做基本逻辑判断；
  4. 向「勤奋的老大」汇报；
  5. 按用户指示编排任务；
  6. 监督子 agent 完成。

## 速查

```bash
# 本机域名
echo "ahc$(ip -4 addr show | grep -oE '172\.30\.3\.[0-9]+' | head -1 | grep -oE '[0-9]+$').joysort.cn"
# 状态
pm2 list | grep cloudcli
# 重启（分离）
nohup bash -c 'sleep 1; pm2 restart cloudcli --update-env' >/tmp/cloudcli-restart.log 2>&1 &
```
