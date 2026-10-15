# Muse Teams Invite Channel MCP（渠道邀请 + 公司生命周期投递）

与通用 **Muse Teams MCP**（`https://teams.vyibc.com/mcp`）分离。

## 为什么单独做？

- Teams MCP 管：企业自助入驻、任务、交付包、回执箱、创建/兑付邀请 token、**公司休眠/重开/注销状态**
- 本 MCP 管：把邀请 / 注销 wipe prompt 等**投递**到恰好已登录 Muse 的 Linux 会话
- 开源/通用客户端没有「SSH 到已登 Muse 的机器」能力，故投递不属于通用 Teams

## 边界

| 能力 | 归属 |
|------|------|
| 企业自助开公司 `teams_company_create` | Teams MCP |
| 公司休眠/重开/注销 `teams_company_suspend/resume/archive` | Teams MCP（状态权威） |
| 代企业入驻 token `teams_create_invite` / `teams_redeem_invite` | Teams MCP |
| 回执 `invite_*` / `company_suspend|resume|archive` | Teams 回执箱 |
| 列出可投递目标 / 投递旁聊 | **本 MCP**（仅已登录 Muse lane） |

## 工具

1. `invite_list_targets` — 可投递目标（已登 Muse）；`FLEET_API_URL` 发现或 `INVITE_TARGETS_JSON`
2. `invite_compose` — 调 Teams 创建 invite + prompt
3. `invite_lifecycle_compose` — 调 Teams suspend/resume/archive，返回 prompt（注销走 prompt 渠道）
4. `invite_deliver` — 仅向 logged-in 目标投递；可选 `MUSE_INJECT_URL` 真注入
5. `invite_status` — 查投递记录
6. `invite_ack_poll` — 轮询 Teams `invite_ack`

## 配置

- `TEAMS_API_URL` 默认 `https://teams.vyibc.com`
- `TEAMS_MCP_URL` 默认 `https://teams.vyibc.com/mcp`
- `FLEET_API_URL` 可选：返回已登录 Muse browsers 的 JSON
- `INVITE_TARGETS_JSON` 可选：手动 targets
- `MUSE_INJECT_URL` 可选：真实旁聊注入端点

## 部署

Worker 脚本：`worker.js` → Cloudflare Worker `muse-teams-invite`，路由 `teams.vyibc.com/invite-mcp*`。

本地 stdio：`node index.js`（骨架；生产以 `worker.js` 为准）。
