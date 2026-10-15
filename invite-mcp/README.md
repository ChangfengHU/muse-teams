# Muse Teams Invite Channel MCP（渠道邀请）

与通用 **Muse Teams MCP**（`https://teams.vyibc.com/mcp`）分离。

## 为什么单独做？

- Teams MCP 管：企业自助入驻、任务、交付包、回执箱、**创建/兑付邀请 token**
- 本 MCP 管：把邀请提示词**投递**到恰好已登录 Muse 的 Linux 会话（类似生图投递流）
- 开源/通用客户端没有「SSH 到已登 Muse 的机器」能力，故投递不属于通用 Teams

## 边界

| 能力 | 归属 |
|------|------|
| 企业自助开公司 `teams_company_create` | Teams MCP |
| 代企业入驻 token `teams_create_invite` / `teams_redeem_invite` | Teams MCP |
| 回执 `invite_sent` / `invite_ack` | Teams 回执箱 |
| 列出可投递目标 / 投递旁聊 | **本 MCP** |

## 工具

1. `invite_list_targets` — 可投递目标（已登 Muse 的 Linux / 会话）；骨架返回配置中的 targets
2. `invite_compose` — 调 Teams `teams_create_invite`，返回 `invite_id` + prompt
3. `invite_deliver` — 渠道投递占位：记录 delivery attempt（真实 Muse 旁聊投递需接 fleet/channel）
4. `invite_status` — 查投递记录
5. `invite_ack_poll` — 轮询 Teams `teams_list_receipts` type=`invite_ack`

## 配置

环境变量：

- `TEAMS_MCP_URL` 默认 `https://teams.vyibc.com/mcp`
- `TEAMS_API_URL` 默认 `https://teams.vyibc.com`
- `INVITE_TARGETS_JSON` 可选 JSON 数组 `[{id, label, kind}]`

## 本地跑

```bash
node index.js
# stdio MCP skeleton；生产可改为 streamable-http
```
