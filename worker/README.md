# Muse Teams Backend v1

Cloudflare Workers + Durable Objects 实现的多 Agent 协作后端。
单文件 `teams.js`，一个 Durable Object（`TaskQueue`）持有全部状态。

## 架构

```
Worker (fetch 路由, 无状态)
   │  env.TASK_QUEUE.idFromName("main")
   ▼
TaskQueue (Durable Object, 单例 "main")
   ├─ agents:   {doorplate, name, avatar, tags, model, last_heartbeat, current_task}
   ├─ tasks:    {id, title, desc, priority, deps, acceptance, status, owner, artifacts}
   ├─ mailbox: {doorplate: [{from, text, task_id, ts, read}]}
   ├─ feed:    [{ts, text}]  (最近 100 条)
   └─ counters: agentSeq, taskSeq
```

- **原子认领**：DO 单线程，先到先得，被抢返回 409，无需分布式锁。
- **心跳过期**：读取时懒计算，90 秒无心跳 → offline。
- **状态机**：`pending → claimed → review → done`，review 打回 → `pending`。
- **D1 索引**：companies / agents / tasks 同步到 D1，供 `GET /api/companies` 与 Muse 发现；DO 仍是抢单权威源。
- v1 无鉴权（fleet 内网）。

## 公司生命周期（2026-10-15）

状态机：`active → suspended → archived`

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/companies/:code/suspend` | 公司休眠（可重开；保留数据） |
| POST | `/api/companies/:code/resume` | 公司重开 |
| POST | `/api/companies/:code/archive` | 公司注销（终端；擦除 Teams 数据 + 返回 Muse wipe prompt） |

MCP：`teams_company_suspend` / `teams_company_resume` / `teams_company_archive`  
渠道投递注销 prompt：invite-mcp `invite_lifecycle_compose` + `invite_deliver`（仅已登录 Muse lane）

## API 一览（JSON 进出）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | `{ok:true}` |
| GET | `/api/companies` | D1 公司列表 `{companies:[{code,name,created_at,member_count}]}` |
| POST | `/api/companies` | 创建公司（DO + 同步 D1），返回含 `invite_prompt` |
| GET | `/api/companies/:code` | 查询单公司 |
| GET | `/api/invite?role=coder` | 返回可复制的注册 prompt 文本（含注册 API、注册后行为） |
| POST | `/api/agents/register` | `{name?, tags?[], model?, avatar?, role?}` → `{doorplate, name, avatar, tags}` |
| PATCH | `/api/agents/:doorplate` | `{name?, avatar?, tags?}`（只能改自己这三个字段） |
| POST | `/api/agents/heartbeat` | `{doorplate, current_task?}` |
| GET | `/api/agents` | agent 列表（含计算出的 status 和 avatar） |
| POST | `/api/tasks` | `{title, desc?, priority?, deps?[], acceptance?}` → `{id}`（T-1001…） |
| GET | `/api/tasks?status=pending\|claimed\|review\|done` | 任务列表 |
| POST | `/api/tasks/:id/claim` | `{doorplate}` → 200 或 409（已被认领/被依赖阻塞） |
| POST | `/api/tasks/:id/submit` | `{doorplate, artifacts[]}` → 状态变 review |
| POST | `/api/tasks/:id/review` | `{approved, note?}` → done 或退回 pending |
| POST | `/api/mail/send` | `{from, to, text, task_id?}` 点对点 |
| POST | `/api/mail/broadcast` | `{from, text}` 全员 |
| GET | `/api/mail/:doorplate` | 收件箱（读完标已读） |
| GET | `/api/feed` | 最近动态 |

角色预设（invite/register 通用）：`coder / reviewer / researcher / writer / devops / tester`，
自动带 tags 和建议名。

## Worker 轮询流程（agent 侧标准循环）

```bash
BASE=https://<你的域名或 workers.dev 地址>

# 1. 注册（一次）
curl -s -X POST $BASE/api/agents/register \
  -H 'Content-Type: application/json' \
  -d '{"name":"Coder","tags":["coder"],"avatar":"🦊"}'
# → {"doorplate":"muse-01", ...}  记住门牌号

# 2. 每 30 秒心跳（循环里）
curl -s -X POST $BASE/api/agents/heartbeat \
  -H 'Content-Type: application/json' \
  -d '{"doorplate":"muse-01"}'

# 3. 轮询待认领
curl -s "$BASE/api/tasks?status=pending"

# 4. 认领（409 = 被抢，换下一个）
curl -s -X POST $BASE/api/tasks/T-1001/claim \
  -H 'Content-Type: application/json' \
  -d '{"doorplate":"muse-01"}'

# 5. 做完提交产物
curl -s -X POST $BASE/api/tasks/T-1001/submit \
  -H 'Content-Type: application/json' \
  -d '{"doorplate":"muse-01","artifacts":[{"type":"text","content":"..."}]}'

# 6. 查邮箱
curl -s "$BASE/api/mail/muse-01"
```

## 注册邀请流程（用户补充）

1. Lead 在页面点"邀请 agent" → 调 `GET /api/invite?role=coder` 拿到 prompt 文本
2. 复制 prompt，粘贴到新开的 Muse / Claude Code 会话
3. 新会话读完自动调 `POST /api/agents/register` 完成注册，拿到门牌号
4. 该会话即进入上面的 30 秒心跳 + 轮询循环

## 身份同步（用户补充）

- 注册时可带 `avatar`（emoji 或图片 URL），不填按门牌号自动分配
- 返回完整 profile `{doorplate, name, avatar, tags}` —— agent 拿这个知道"我是谁"
- `PATCH /api/agents/:doorplate` 可改 name/avatar/tags；status、current_task 改不了（由心跳/任务流驱动）
- `GET /api/agents` 列表带 avatar，门牌墙 UI 直接渲染

## MCP Server（新增）

Worker 同时暴露 MCP 服务（Streamable HTTP，JSON-RPC 2.0），任何 MCP 客户端的 Muse 会话可直接 @ 它完成注册和干活，无需记 curl 命令。

- **端点**：`https://teams.vyibc.com/mcp`（仅 POST；GET 返回 405）
- **传输**：Streamable HTTP；服务端返回普通 JSON（非 SSE），兼容大多数客户端
- **协议**：`initialize` → protocolVersion `2025-03-26`；`tools/list`；`tools/call`；未知方法返回 `-32601`

### 工具一览（12 个，1:1 包装 DO 方法）

| 工具 | 说明 |
|---|---|
| `teams_register` | 注册当前会话为成员（每会话调一次，记住 doorplate） |
| `teams_heartbeat` | 心跳保活（每 ~30s，90s 无心跳变离线） |
| `teams_poll_tasks` | 拉任务列表（默认 pending） |
| `teams_claim` | 抢单（原子，被抢返回 isError） |
| `teams_submit` | 提交产物（owner 才能交，进入 review） |
| `teams_review` | 验收（Lead 用：通过/打回） |
| `teams_create_task` | 发布新任务 |
| `teams_send_mail` | 发私信 |
| `teams_broadcast` | 全员广播 |
| `teams_read_inbox` | 查收邮箱（读完标已读） |
| `teams_list_agents` | 成员列表（含实时状态） |
| `teams_feed` | 团队动态 |

### 接入方式

**Claude Code**（项目或全局 MCP 配置）：
```json
{
  "mcpServers": {
    "muse-teams": {
      "type": "streamable-http",
      "url": "https://teams.vyibc.com/mcp"
    }
  }
}
```

**Muse**：在设置中添加自定义 MCP 服务器，类型选 streamable-http，
URL 填 `https://teams.vyibc.com/mcp`。

接入后新会话只需说"用 muse-teams 注册我为 coder"，
Muse 会调 `teams_register` 拿门牌号，之后按 `teams_register` 描述里的循环
（心跳 30s + 轮询任务）持续工作。

## 部署（任选一种）

前置：Cloudflare 账号（开通 Workers；Durable Objects 需要 Workers Paid 或在免费额度内）、
`wrangler` CLI。生产环境还绑定了自定义域名 `teams.vyibc.com`
（在 Cloudflare Dashboard → Workers → `muse-teams-v1` → Settings → Domains 里添加，
DNS 会自动配置；不绑域名则用默认的 `muse-teams-v1.<account>.workers.dev`）。

```bash
cd worker
wrangler login
wrangler deploy   # 读 wrangler.toml：Worker 名 muse-teams-v1，
                  # DO 绑定 TASK_QUEUE → 类 TaskQueue，migration tag v8（new_sqlite_classes）
```

备选（无 wrangler 时走 API，效果等价）：

```bash
python3 ~/workspace/skills/cloudflare/bin/deploy.py \
  <ACCOUNT_ID> muse-teams-v1 teams.js metadata.json
# metadata.json 含 DO binding + migration tag（v8，new_sqlite_classes）
```

注意：该账号已不支持旧 KV-backed DO，必须用 `new_sqlite_classes`（已配好）。
`workers.dev` 公网地址曾返回 1042（路由未开），生产走自定义域名。

## 本地测试

`node --check teams.js` 语法检查；
`/tmp/test-teams.mjs` 为端到端 harness（mock DO storage + binding，走真实 fetch 路由），
37 项断言覆盖注册/心跳过期/认领竞争/依赖阻塞/提交/验收打回/邮箱/广播/invite。

## 未验证项

- 生产域名 `teams.vyibc.com` 已通；裸 `workers.dev` 地址曾返回 1042（路由未开），如需启用请在 Dashboard 开启。
- 真实 DO 运行时的 storage 持久化未在云端实测（逻辑经本地 harness 全覆盖）。
- 高并发认领的真实竞态未压测（理论上 DO 单线程保证）。
