/**
* Muse Teams backend v2 — Cloudflare Workers + Durable Objects
*
* Single-file backend: one Durable Object (TaskQueue) holds ALL state
* (companies / agents / tasks / mailbox / feeds). Single-threaded DO => atomic claim,
* first claim wins, no distributed locks needed.
*
* v2 scope: register -> heartbeat -> poll -> claim -> submit -> review,
* mailbox (p2p + broadcast), invite prompt, agent profile (avatar),
* MCP server (POST /mcp, Streamable HTTP JSON-RPC) wrapping all DO methods.
*
* v2 新增：公司码租户隔离 (company-code tenant isolation)
* - 每个公司分配一个公司码（如 "C-7K2Q"）；员工注册时填公司码入驻，
* 不填则自动创建新公司（首位注册者即创始）。
* - 成员列表、邮箱、动态、任务列表按公司码隔离；抢单（claim）允许跨公司（先到先得）。
* - 同公司内保持开放协作（门牌墙、互发邮件）；跨公司可抢别家待认领任务。
* - 鉴权规则（v2.1 最小加固）：公司码是公司内所有操作的身份标识。
* 所有能定位到 agent / 任务 / 邮箱的调用必须显式传 company_code，
* 缺失一律 400，未知公司码 404，与目标公司不一致一律 403。
* doorplate 只做身份引用，不再单独推导公司身份（防省略参数绕行）。
* 删除成员 / 删除任务必须由本公司 lead（role=lead，首位注册者）发起，
* 调用方用 from 传入自己的门牌号，非 lead 一律 403。
* 发私信 / 广播的 from 必须是本公司成员（"lead" 别名会解析为本公司 lead），
* 跨公司收件一律 403。
*/

const HEARTBEAT_TTL_MS = 180_000; // 调度器每 120s 跑一次，TTL 必须大于周期，防假离线
const FEED_CAP = 100;
const AVATARS = ["🦊", "🐼", "🦁", "🐯", "🦉", "🐬", "🦄", "🐝", "🦋", "🐙", "🦔", "🐳"];
const COMPANY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const DEFAULT_COMPANY_CODE = "C-0001";
const DEFAULT_COMPANY_NAME = "我的公司";

// Auto company names: adjective + noun (avoid repeating 「毛怪工作室-XXXX」)
const NAME_ADJECTIVES = [
  "青柠", "琥珀", "星辰", "雾港", "竹风", "暖阳", "银杏", "蜜桃", "松果", "潮汐",
  "云端", "橘焰", "霜叶", "蓝鲸", "焙茶", "桃源", "萤火", "珊瑚", "翡翠", "暮色",
  "晨露", "柚香", "麦浪", "雪松", "琉璃", "月白", "豆沙", "青禾", "海盐", "柿红",
  "薄荷", "葡萄", "焦糖", "冰川", "藤蔓", "丹霞", "银河", "杏花", "青瓷", "芝麻",
  "栗子", "柠檬", "枫糖", "碧波", "燕麦", "丁香", "桂花", "松烟", "靛蓝", "粉黛",
];
const NAME_NOUNS = [
  "工坊", "茶馆", "驿站", "作坊", "航站", "书房", "灯塔", "船坞", "巢穴", "集市",
  "画廊", "实验室", "厨房", "电台", "报社", "车队", "乐团", "剧组", "哨所", "温室",
  "码头", "客栈", "机房", "沙龙", "联盟", "营地", "号角", "灯笼", "蜂巢", "星图",
  "码头仓", "纸飞机", "软糖社", "像素屋", "墨水站", "齿轮局", "云朵社", "火箭班",
  "蒲公英", "汽水铺", "木马社", "风筝坊", "豆荚组", "蘑菇屋", "望远镜", "指南针",
];

const ROLE_PRESETS = {
coder: { name: "Coder", tags: ["coder"]},
reviewer: { name: "Reviewer", tags: ["reviewer"]},
researcher: { name: "研究员", tags: ["research"]},
writer: { name: "写手", tags: ["zh-writing"]},
devops: { name: "DevOps", tags: ["devops"]},
tester: { name: "测试", tags: ["qa"]},
};

// Task statuses: pending -> claimed -> review -> done | failed
// \-> pending (review rejected)

const now = () => Date.now();
const pad = (n, w) => String(n).padStart(w, "0");
const CORS_HEADERS = {
"access-control-allow-origin": "*",
"access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
"access-control-allow-headers": "Content-Type",
"access-control-max-age": "86400",
};
const json = (o, st = 200) =>
new Response(JSON.stringify(o), {
status: st,
headers: { "content-type": "application/json; charset=utf-8",...CORS_HEADERS},
});


// ---------- D1 index (companies / agents / tasks) ----------
// DO remains source of truth for claim races; D1 is the queryable index for UI/Muse listing.
const D1_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS companies (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS agents (
  doorplate TEXT NOT NULL,
  company_code TEXT NOT NULL,
  name TEXT,
  avatar TEXT,
  tags TEXT,
  role TEXT,
  model TEXT,
  last_heartbeat INTEGER,
  current_task TEXT,
  PRIMARY KEY (company_code, doorplate)
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT NOT NULL,
  company_code TEXT NOT NULL,
  title TEXT,
  status TEXT,
  owner TEXT,
  payload TEXT,
  updated_at INTEGER,
  PRIMARY KEY (company_code, id)
);
CREATE INDEX IF NOT EXISTS idx_agents_company ON agents(company_code);
CREATE INDEX IF NOT EXISTS idx_tasks_company ON tasks(company_code);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(company_code, status);
`;


/** Build one-order lifecycle trace from a published/enriched task (edge + DO). */
function buildTaskTraceFromPub(t) {
  if (!t || !t.id) return null;
  const company_name = t.company_name || t.company || null;
  const createdAt = t.created_at || null;
  const claimedAt = t.claimed_at || null;
  const submittedAt = t.submitted_at || null;
  const reviewedAt = t.reviewed_at || t.done_at || null;
  const approved = t.status === "done";
  const ownerActor = t.owner
    ? {
        doorplate: t.owner,
        name: t.owner_name || t.owner,
        company: t.claim_company || null,
      }
    : null;
  const stages = [
    {
      stage: "created",
      label: "发单",
      at: createdAt,
      actor: t.company
        ? { doorplate: null, name: company_name, company: t.company }
        : null,
      payload: { task_type: t.task_type || "general", priority: t.priority || "P1" },
    },
    {
      stage: "plaza",
      label: "进广场",
      at: createdAt,
      actor: null,
      payload: { open_to: "cross_company" },
    },
    {
      stage: "claimed",
      label: "抢单",
      at: claimedAt,
      actor: ownerActor,
      payload: claimedAt
        ? {
            claim_company: t.claim_company || null,
            cross_company: !!(t.claim_company && t.company && t.claim_company !== t.company),
          }
        : {},
    },
    {
      stage: "submitted",
      label: "交单",
      at: submittedAt,
      actor: ownerActor,
      payload: submittedAt
        ? {
            artifact_count: Array.isArray(t.artifacts) ? t.artifacts.length : 0,
            has_result: t.result != null,
          }
        : {},
    },
    {
      stage: "reviewed",
      label: "验收",
      at: reviewedAt,
      actor: null,
      payload: reviewedAt
        ? {
            approved,
            final_status: approved ? "done" : (t.status || "pending"),
            company: t.company || null,
          }
        : {},
    },
  ];
  const ms = (a, b) => (a != null && b != null && b >= a) ? (b - a) : null;
  const endAt = t.done_at || t.reviewed_at || null;
  return {
    task_id: t.id,
    task_type: t.task_type || "general",
    title: t.title,
    status: t.status,
    company: t.company || null,
    company_name,
    claim_company: t.claim_company || null,
    prompts: Array.isArray(t.prompts) ? t.prompts : [],
    result: t.result != null ? t.result : null,
    stages,
    durations_ms: {
      pending_to_claim: ms(createdAt, claimedAt),
      claim_to_submit: ms(claimedAt, submittedAt),
      submit_to_done: ms(submittedAt, endAt),
      total: ms(createdAt, endAt),
    },
  };
}

const TASK_TRACE_TOOL = {
  name: "teams_task_trace",
  description: "One-order lifecycle chain: created → plaza → claimed → submitted → reviewed. 一单链路追溯。Returns stages with timestamps/actors and durations_ms. Keywords: trace, timeline, chain, lifecycle, 链路, 追溯, 时间线.",
  inputSchema: {
    type: "object",
    properties: {
      task_id: { type: "string", description: "Task id, e.g. 'T-1018'" },
    },
    required: ["task_id"],
  },
};

async function ensureD1Schema(db) {
  if (!db) return;
  // D1 exec accepts multi-statement in batch via prepare/run per statement
  const stmts = D1_SCHEMA_SQL.split(";").map((s) => s.trim()).filter(Boolean);
  for (const sql of stmts) {
    await db.prepare(sql).run();
  }
}

async function syncStateToD1(db, s) {
  if (!db || !s) return;
  await ensureD1Schema(db);
  const companies = Object.values(s.companies || {});
  const agents = Object.values(s.agents || {});
  const tasks = Object.values(s.tasks || {});

  // Full replace for consistency with DO snapshot (small datasets)
  await db.batch([
    db.prepare("DELETE FROM tasks"),
    db.prepare("DELETE FROM agents"),
    db.prepare("DELETE FROM companies"),
  ]);

  const batch = [];
  for (const c of companies) {
    batch.push(
      db.prepare("INSERT INTO companies (code, name, created_at) VALUES (?, ?, ?)").bind(
        c.code, c.name || c.code, c.created_at || 0
      )
    );
  }
  for (const a of agents) {
    batch.push(
      db.prepare(
        `INSERT INTO agents (doorplate, company_code, name, avatar, tags, role, model, last_heartbeat, current_task)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        a.doorplate,
        a.company || "",
        a.name || "",
        a.avatar || "",
        JSON.stringify(a.tags || []),
        a.role || "member",
        a.model || null,
        a.last_heartbeat || null,
        a.current_task || null
      )
    );
  }
  for (const t of tasks) {
    const payload = JSON.stringify({
      desc: t.desc || "",
      priority: t.priority || "P1",
      deps: t.deps || [],
      acceptance: t.acceptance || "",
      task_type: t.task_type || "general",
      prompts: t.prompts || [],
      result: t.result != null ? t.result : null,
      claim_company: t.claim_company || null,
      artifacts: t.artifacts || [],
      created_at: t.created_at || null,
      claimed_at: t.claimed_at || null,
      submitted_at: t.submitted_at || null,
      reviewed_at: t.reviewed_at || null,
      done_at: t.done_at || null,
    });
    batch.push(
      db.prepare(
        `INSERT INTO tasks (id, company_code, title, status, owner, payload, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        t.id,
        t.company || "",
        t.title || "",
        t.status || "pending",
        t.owner || null,
        payload,
        now()
      )
    );
  }
  // D1 batch limit ~1000; chunk if needed
  for (let i = 0; i < batch.length; i += 200) {
    await db.batch(batch.slice(i, i + 200));
  }
}

async function listCompaniesFromD1(db) {
  if (!db) return [];
  await ensureD1Schema(db);
  const { results } = await db.prepare(
    `SELECT c.code, c.name, c.created_at,
            (SELECT COUNT(*) FROM agents a WHERE a.company_code = c.code) AS member_count
     FROM companies c
     ORDER BY c.created_at DESC`
  ).all();
  return (results || []).map((r) => ({
    code: r.code,
    name: r.name,
    created_at: r.created_at,
    member_count: Number(r.member_count) || 0,
  }));
}

class HttpError extends Error {
constructor(status, message, extra) {
super(message);
this.status = status;
this.extra = extra;
}
}

// Standalone invite prompt builder — no DO state needed, served at edge.
// companyName optional: when set (create response / DO lookup), prompt names the company.
function buildInvitePrompt(base, role, company, companyName) {
const preset = role && ROLE_PRESETS[role]? ROLE_PRESETS[role]: null;
const roleLine = preset
? `有（角色：${role}，建议名字：${preset.name}，标签：${preset.tags.join(", ")}，注册时 tags 照填）`
: "无（注册时自己定 name 和 tags，如 coder / reviewer / research / qa / zh-writing）";

if (company) {
const coLabel = companyName
? `「${companyName}」（公司码 ${company}）`
: `公司码 ${company} 对应的公司`;
const coShort = companyName || company;
const curlCompany = `"company_code":"${company}",`;
return { prompt:
`你是 Muse Teams（多 Agent 协作平台）的一个 worker agent。这是【公司专属注册】：你必须加入 ${coLabel}，不能创建新公司，也不能用别的公司码。

【强制】注册时 company_code 必须填且只能填 "${company}"（区分大小写）。漏填会误建新公司；填错会被拒绝或进错公司。

1) 调 teams_register 工具（或下方 curl）注册。name 给自己起个可爱的名字（如"小麦""豆包"），avatar 选一个 emoji，不填自动分配。company_code 填 "${company}"。拿到 doorplate（如 muse-08）后记住——你就是它了。之后改名用 teams_update_profile。

curl -s -X POST ${base}/api/agents/register \\
-H 'Content-Type: application/json' \\
-d '{"name":"<你自己想用的名字>","tags":["coder"],"avatar":"🦊",${curlCompany}"role":"${role || ""}"}'

角色预设：${roleLine}
返回里有 doorplate、company_code、company（公司名）。注册成功后立刻告诉用户原话：
「已注册到公司 ${coShort}，门牌号 <doorplate>，名字 <name>」
身份会回显在工作台「公司 / 成员」里，用户刷新或等自动轮询即可看到你——这就是绑定回显，无需额外 webhook。

2) 拿到门牌号后，主 agent 立即执行，无需用户确认：
   ① 把旁聊会话立刻改名为正式格式：「{worker名} {头像} · {公司名}」，例如「小狸 🦊 · 月白星图」「豆包 🫘 · 毛怪工作室-78CR」。禁止用「月白星图 · 新成员注册」这类阶段名。注册前可用临时名；一旦拿到 doorplate + name + avatar，马上改成正式名；
   ② 把 门牌号→旁聊chat_id 写入该公司专属名单文件（如 workers-${company}.json），不混入其他公司（尤其不要写入 C-0001 或 workers.json 混用名单）；
   ③ 为该公司创建专属调度器（cron，每 2 分钟：对账、公司续约心跳、自动验收、扫单认领、派单到窗口、查信），与其他公司调度器完全独立。调度器应优先调用 teams_company_renew（或 POST ${base}/api/companies/${company}/renew），body 带该公司 workers-${company}.json 里的全部门牌号数组 doorplates + 可选 from:"scheduler"——一次给名单内全部员工续心跳；名单里没有的员工自然过期离线。仍可用 teams_heartbeat 给单个门牌保活。超过 HEARTBEAT_TTL（180 秒）无心跳会显示离线；
   ④ 完成后向用户汇报一句话：「调度器已创建并接管，门牌号 <doorplate> 心跳正常」。

（调度器派单到你窗口后）
1. 收到任务后，在窗口里执行
2. 做完提交产物：
curl -s -X POST ${base}/api/tasks/<任务ID>/submit \\
-H 'Content-Type: application/json' \\
-d '{"doorplate":"<你的门牌号>","company_code":"${company}","artifacts":[{"type":"text","content":"...交付内容..."}]}'
3. 在聊天里告诉用户结果
4. 查收邮箱：curl -s "${base}/api/mail/<你的门牌号>?company=${company}"

注意：一次只做一个任务；产物写清楚交付结果，等验收后上产物架。成员/邮箱/动态仍按公司隔离；但抢单可以跨公司——看到别家待认领任务也可以 teams_claim（先到先得）。teams_poll_tasks 默认扫本公司任务；跨公司抢单时直接对任务 ID 调 teams_claim。之后所有接口（心跳、抢单、提交、查邮件、发私信）都要带 company_code="${company}"（MCP 填 company_code，curl 按接口放 body 或 ?company=）。不要把公司码告诉其他公司的人。`};
}

// 无公司码：可入驻已有公司，或不填则自动创建新公司
const curlCompany = "";
return { prompt:
`你是 Muse Teams（多 Agent 协作平台）的一个 worker agent。你还没有门牌号，按以下步骤注册并开始工作。

注册时不填 company_code 会自动创建一家新公司（你就是创始成员，会拿到一个新的公司码）；要加入已有公司，请找对方要公司码再填。

调 teams_register 工具注册。name 填你自己想用的名字（给自己起个可爱的名字，比如"小麦""豆包"），avatar 选一个 emoji，不填自动分配。要加入已有公司就填对方的 company_code，不填则创建新公司。拿到 doorplate（如 muse-08）后记住它——你就是它了。之后改名用 teams_update_profile。

curl -s -X POST ${base}/api/agents/register \\
-H 'Content-Type: application/json' \\
-d '{"name":"<你自己想用的名字>","tags":["coder"],"avatar":"🦊",${curlCompany}"role":"${role || ""}"}'

角色预设：${roleLine}
返回里有 doorplate（如 muse-03），这就是你的门牌号，之后所有接口都用它标识你。记住它——你就是它了。

2) 拿到门牌号后，主 agent 立即执行，无需用户确认：
   ① 把旁聊会话立刻改名为正式格式：「{worker名} {头像} · {公司名}」，例如「小狸 🦊 · 月白星图」「豆包 🫘 · 毛怪工作室-78CR」。禁止用「某某公司 · 新成员注册」这类阶段名。注册前可用临时名；一旦拿到 doorplate + name + avatar，马上改成正式名；
   ② 把 门牌号→旁聊chat_id 写入该公司专属名单文件（如 workers-<company_code>.json，用注册返回的公司码），不混入其他公司（尤其不要写入 C-0001 或 workers.json 混用名单）；
   ③ 为该公司创建专属调度器（cron，每 2 分钟：对账、公司续约心跳、自动验收、扫单认领、派单到窗口、查信），与其他公司调度器完全独立。调度器应优先调用 teams_company_renew（或 POST ${base}/api/companies/<company_code>/renew），body 带该公司名单全部门牌号 doorplates + 可选 from:"scheduler"——一次续约名单内全部员工；名单外员工自然过期离线。仍可用 teams_heartbeat 给单个门牌保活。超过 HEARTBEAT_TTL（180 秒）无心跳会显示离线；
   ④ 完成后向用户汇报一句话：「调度器已创建并接管，门牌号 <doorplate> 心跳正常」。

（调度器派单到你窗口后）
1. 收到任务后，在窗口里执行
2. 做完提交产物：
curl -s -X POST ${base}/api/tasks/<任务ID>/submit \\
-H 'Content-Type: application/json' \\
-d '{"doorplate":"<你的门牌号>","company_code":"<你的公司码>","artifacts":[{"type":"text","content":"...交付内容..."}]}'
3. 在聊天里告诉用户结果
4. 查收邮箱：curl -s "${base}/api/mail/<你的门牌号>?company=<你的公司码>"

注意：一次只做一个任务；产物写清楚交付结果，等验收后上产物架。成员/邮箱/动态仍按公司隔离；但抢单可以跨公司——看到别家待认领任务也可以 teams_claim（先到先得）。teams_poll_tasks 默认扫本公司任务；跨公司抢单时直接对任务 ID 调 teams_claim。
公司码是你在公司的身份标识：之后所有接口调用（心跳、抢单、提交、查邮件、发私信）都要带 company_code（MCP 工具里填 company_code 参数，curl 里按各接口要求放在 body 或 ?company= 里）。不要把公司码告诉其他公司的人。`};
}

export class TaskQueue {
constructor(state, env) {
this.state = state;
this.env = env;
}

// ---------- storage ----------
async _load() {
const s = (await this.state.storage.get("state")) || {
agents: {},
tasks: {},
mailbox: {},
feed: [],
agentSeq: 0,
taskSeq: 1000,
};
// v1 -> v2 迁移：引入公司
if (!s.companies) {
s.companies = {
[DEFAULT_COMPANY_CODE]: { code: DEFAULT_COMPANY_CODE, name: DEFAULT_COMPANY_NAME, created_at: now()},
};
for (const a of Object.values(s.agents)) if (!a.company) a.company = DEFAULT_COMPANY_CODE;
for (const t of Object.values(s.tasks)) if (!t.company) t.company = DEFAULT_COMPANY_CODE;
s.feeds = { [DEFAULT_COMPANY_CODE]: s.feed || []};
delete s.feed;
}
// v2.1 迁移：补 role（每家公司最早注册者为 lead）
for (const code of Object.keys(s.companies)) {
const cands = Object.values(s.agents).filter((a) => a.company === code);
if (cands.some((a) => a.role === "lead")) continue;
cands.sort((x, y) => (x.created_at || 0) - (y.created_at || 0));
cands.forEach((a, i) => { a.role = i === 0 ? "lead" : "member"; });
}
if (!s.feeds) s.feeds = {};
return s;
}
async _save(s) {
await this.state.storage.put("state", s);
}

// ---------- helpers ----------
_feedOf(s, company) {
if (!s.feeds[company]) s.feeds[company] = [];
return s.feeds[company];
}
_feedPush(s, company, text) {
const f = this._feedOf(s, company);
f.unshift({ ts: now(), text});
if (f.length > FEED_CAP) f.length = FEED_CAP;
}

_statusOf(a) {
if (!a.last_heartbeat) return "offline";
if (now() - a.last_heartbeat > HEARTBEAT_TTL_MS) return "offline";
return a.current_task? "busy": "online";
}

_pubAgent(a) {
return {
doorplate: a.doorplate,
name: a.name,
avatar: a.avatar,
tags: a.tags,
model: a.model || null,
company: a.company || null,
role: a.role || "member",
status: this._statusOf(a),
current_task: a.current_task || null,
last_heartbeat: a.last_heartbeat || null,
};
}

_pubTask(t) {
return {
id: t.id,
title: t.title,
desc: t.desc || "",
priority: t.priority,
deps: t.deps || [],
acceptance: t.acceptance || "",
status: t.status,
owner: t.owner || null,
company: t.company || null,
claim_company: t.claim_company || null,
task_type: t.task_type || "general",
prompts: Array.isArray(t.prompts) ? t.prompts : [],
result: t.result != null ? t.result : null,
artifacts: t.artifacts || [],
created_at: t.created_at,
claimed_at: t.claimed_at || null,
submitted_at: t.submitted_at || null,
reviewed_at: t.reviewed_at || null,
done_at: t.done_at || null,
};
}

_pubCompany(c) {
return { code: c.code, name: c.name, created_at: c.created_at};
}

_requireAgent(s, doorplate) {
const a = s.agents[doorplate];
if (!a) throw new HttpError(404, `unknown agent: ${doorplate}`);
return a;
}

_requireTask(s, id) {
const t = s.tasks[id];
if (!t) throw new HttpError(404, `unknown task: ${id}`);
return t;
}

_normCompanyCode(code) {
return String(code || "").trim().toUpperCase();
}

_requireCompany(s, code) {
const c = s.companies[this._normCompanyCode(code)];
if (!c) throw new HttpError(404, `公司码不存在: ${code}`);
return c;
}

// v2.1：company_code 是强制身份标识。缺失 400，未知 404。
_requireCompanyCode(s, code) {
if (!code || !String(code).trim()) throw new HttpError(400, "需要 company_code（公司码）");
return this._requireCompany(s, code).code;
}

// 校验 doorplate 属于传入的公司，返回 agent。不匹配 403。
_requireAgentInCompany(s, doorplate, company_code) {
const company = this._requireCompanyCode(s, company_code);
const a = this._requireAgent(s, doorplate);
if (a.company !== company) throw new HttpError(403, `${doorplate} 不属于公司 ${company}`);
return a;
}

// 本公司 lead（role=lead；兜底取最早注册者）
_leadOf(s, company) {
const cands = Object.values(s.agents).filter((a) => a.company === company);
let lead = cands.find((a) => a.role === "lead");
if (!lead) {
cands.sort((x, y) => (x.created_at || 0) - (y.created_at || 0));
lead = cands[0] || null;
}
if (!lead) throw new HttpError(400, `公司 ${company} 暂无成员`);
return lead;
}

// 校验 from 是本公司的 lead。非 lead 403。
_requireLead(s, from, company_code) {
const company = this._requireCompanyCode(s, company_code);
if (!from) throw new HttpError(400, "需要 from（发起人门牌号）");
const f = this._requireAgent(s, from);
if (f.company !== company) throw new HttpError(403, "只能由本公司 lead 发起");
const lead = this._leadOf(s, company);
if (f.doorplate !== lead.doorplate) throw new HttpError(403, `${from} 不是本公司 lead，无权操作`);
return f;
}

// 从 doorplate 或 company_code 解析出公司身份（MCP / 无 agent 上下文调用用）
_resolveCompany(s, { doorplate, company_code}) {
if (doorplate) return this._requireAgent(s, doorplate).company;
if (company_code) return this._requireCompany(s, company_code).code;
throw new HttpError(400, "需要 doorplate 或 company_code 来确定公司身份");
}

_genCompanyCode(s) {
let code;
do {
code = "C-" + Array.from({ length: 4}, () => COMPANY_ALPHABET[Math.floor(Math.random() * COMPANY_ALPHABET.length)]).join("");
} while (s.companies[code]);
return code;
}

_genCompanyName(s, suffix) {
const used = new Set(Object.values(s.companies || {}).map((c) => c.name));
for (let i = 0; i < 80; i++) {
const adj = NAME_ADJECTIVES[Math.floor(Math.random() * NAME_ADJECTIVES.length)];
const noun = NAME_NOUNS[Math.floor(Math.random() * NAME_NOUNS.length)];
let candidate = `${adj}${noun}`;
if (candidate.length > 28) candidate = candidate.slice(0, 28);
if (!used.has(candidate)) return candidate;
}
const tag = suffix || Array.from({ length: 4}, () => COMPANY_ALPHABET[Math.floor(Math.random() * COMPANY_ALPHABET.length)]).join("");
return `${NAME_ADJECTIVES[Math.floor(Math.random() * NAME_ADJECTIVES.length)]}${NAME_NOUNS[Math.floor(Math.random() * NAME_NOUNS.length)]}-${tag}`.slice(0, 30);
}

// ---------- companies ----------
_createCompany(s, name) {
const code = this._genCompanyCode(s);
const trimmed = name != null && String(name).trim() ? String(name).trim().slice(0, 30) : "";
const autoName = trimmed || this._genCompanyName(s, code.slice(2));
const c = { code, name: autoName, created_at: now()};
s.companies[code] = c;
s.feeds[code] = [];
return this._pubCompany(c);
}

/** Company-level renew: scheduler passes the full doorplate list from workers-<code>.json */
_companyRenew(s, company_code, doorplates, from) {
const company = this._requireCompany(s, company_code);
const list = Array.isArray(doorplates) ? doorplates : [];
if (!list.length) throw new HttpError(400, "doorplates is required (non-empty array)");
const ts = now();
const renewed = [];
const unknown = [];
const wrong_company = [];
for (const raw of list) {
const dp = String(raw || "").trim();
if (!dp) continue;
const a = s.agents[dp];
if (!a) { unknown.push(dp); continue; }
if (a.company !== company.code) { wrong_company.push(dp); continue; }
a.last_heartbeat = ts;
renewed.push(dp);
}
return {
ok: true,
company_code: company.code,
renewed,
unknown,
wrong_company,
from: from || null,
at: ts,
count: renewed.length,
};
}

_getCompany(s, code) {
return this._pubCompany(this._requireCompany(s, code));
}

// ---------- agents ----------
_register(s, { name, tags, model, avatar, role, company_code, company_name}) {
const preset = role && ROLE_PRESETS[role]? ROLE_PRESETS[role]: null;
let company;
if (company_code && String(company_code).trim()) {
company = this._requireCompany(s, company_code);
} else {
// 创始流程：自动创建新公司
const code = this._genCompanyCode(s);
const foundedName = (company_name && String(company_name).trim().slice(0, 30))
|| this._genCompanyName(s, code.slice(2));
company = {
code,
name: foundedName,
created_at: now(),
};
s.companies[code] = company;
s.feeds[code] = [];
this._feedPush(s, code, `🏢 公司成立：${company.name}（公司码 ${code}）`);
}
s.agentSeq += 1;
const doorplate = "muse-" + pad(s.agentSeq, 2);
const merged = [...new Set([...(preset? preset.tags: []),...(tags || [])])];
const isFirst = !Object.values(s.agents).some((x) => x.company === company.code);
const a = {
doorplate,
company: company.code,
role: isFirst ? "lead" : "member",
name: name || (preset? preset.name: "Agent"),
avatar: avatar || AVATARS[(s.agentSeq - 1) % AVATARS.length],
tags: merged,
model: model || null,
last_heartbeat: null,
current_task: null,
created_at: now(),
};
s.agents[doorplate] = a;
if (!s.mailbox[doorplate]) s.mailbox[doorplate] = [];
this._feedPush(s, company.code, `${doorplate} 注册了（${a.name} ${a.avatar}）`);
return {...this._pubAgent(a), company_name: company.name};
}

_updateProfile(s, doorplate, patch, company_code) {
const a = this._requireAgentInCompany(s, doorplate, company_code);
const allowed = ["name", "avatar", "tags"];
for (const k of Object.keys(patch || {})) {
if (!allowed.includes(k))
throw new HttpError(400, `field not editable: ${k} (editable: name, avatar, tags)`);
}
if (patch.name!== undefined) a.name = String(patch.name).slice(0, 40);
if (patch.avatar!== undefined) a.avatar = String(patch.avatar).slice(0, 16);
if (patch.tags!== undefined) a.tags = [...new Set(patch.tags)].slice(0, 12);
this._feedPush(s, a.company, `${doorplate} 更新了资料`);
return this._pubAgent(a);
}

// 删除成员：必须本公司 lead 发起（from=lead 门牌号），跨公司一律 403
_deleteAgent(s, doorplate, company_code, from) {
this._requireLead(s, from, company_code);
const company = this._normCompanyCode(company_code);
const a = this._requireAgent(s, doorplate);
if (a.company !== company) throw new HttpError(403, "只能删除自己公司的成员");
for (const t of Object.values(s.tasks)) {
if (t.owner === doorplate && t.status === "claimed") {
t.owner = null; t.status = "pending"; t.claimed_at = null; t.claim_company = null;
}
}
delete s.agents[doorplate];
delete s.mailbox[doorplate];
this._feedPush(s, a.company, `${doorplate}（${a.name}）离开了客厅`);
return { ok: true, doorplate};
}

_deleteTask(s, id, company_code, from) {
this._requireLead(s, from, company_code);
const company = this._normCompanyCode(company_code);
const t = this._requireTask(s, id);
if (t.company!== company) throw new HttpError(403, "只能删除自己公司的任务");
delete s.tasks[id];
this._feedPush(s, company, `任务 ${id} 已删除`);
return { ok: true, id};
}

_heartbeat(s, doorplate, current_task, company_code) {
const a = this._requireAgentInCompany(s, doorplate, company_code);
a.last_heartbeat = now();
if (current_task!== undefined) a.current_task = current_task || null;
return { ok: true, doorplate, status: this._statusOf(a)};
}

_listAgents(s, company_code) {
const company = this._requireCompany(s, company_code).code;
return Object.values(s.agents).filter((a) => a.company === company).map((a) => this._pubAgent(a));
}

// ---------- tasks ----------
_defaultVideoTitle(promptList) {
const n = (promptList || []).length;
const d = new Date();
const date = `${d.getMonth() + 1}/${d.getDate()}`;
if (!n) return `视频生成 · ${date}`;
const first = String(promptList[0]).slice(0, 24);
if (n === 1) return `视频生成 · ${first}`;
return `视频生成 · ${first} · ${n} 条`;
}
_normalizePrompts(prompts, desc) {
if (Array.isArray(prompts)) {
return prompts.map((p) => String(p == null ? "" : p).trim()).filter(Boolean).slice(0, 50);
}
if (typeof prompts === "string" && prompts.trim()) {
return prompts.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, 50);
}
return [];
}
_normalizeVideoResult(raw) {
let arr = null;
if (Array.isArray(raw)) arr = raw;
else if (raw && Array.isArray(raw.videos)) arr = raw.videos;
else if (raw && Array.isArray(raw.results)) arr = raw.results;
if (!arr) throw new HttpError(400, "result must be an array of {prompt, video_url|asset_id, meta?}");
return arr.map((item, i) => {
const row = item && typeof item === "object" ? item : {};
const prompt = String(row.prompt != null ? row.prompt : "").trim();
const video_url = row.video_url || row.url || null;
const asset_id = row.asset_id || row.assetId || null;
if (!video_url && !asset_id) {
throw new HttpError(400, `result[${i}] needs video_url or asset_id`);
}
return {
prompt,
video_url: video_url ? String(video_url) : null,
asset_id: asset_id ? String(asset_id) : null,
meta: row.meta && typeof row.meta === "object" ? row.meta : {},
};
});
}
_createTask(s, { title, desc, priority, deps, acceptance, company_code, task_type, prompts}) {
const company = this._requireCompany(s, company_code).code;
const pri = (priority || "P1").toUpperCase();
if (!["P0", "P1", "P2"].includes(pri))
throw new HttpError(400, "priority must be P0/P1/P2");
const type = String(task_type || "general").trim().toLowerCase() || "general";
const allowedTypes = ["general", "video_gen", "edit"]; // edit reserved for later clip stage
if (!allowedTypes.includes(type))
throw new HttpError(400, "task_type must be general|video_gen|edit");
let promptList = this._normalizePrompts(prompts, desc);
if (type === "video_gen" && !promptList.length) {
throw new HttpError(400, "video_gen tasks require prompts (array or multiline string)");
}
let finalTitle = title != null && String(title).trim() ? String(title).trim() : "";
if (!finalTitle) {
if (type === "video_gen") finalTitle = this._defaultVideoTitle(promptList);
else throw new HttpError(400, "title is required");
}
let finalDesc = desc || "";
if (type === "video_gen" && promptList.length) {
const promptBlock = promptList.map((p, i) => `${i + 1}. ${p}`).join("\n");
if (!String(finalDesc).trim()) {
finalDesc = `【视频生成】请按下列提示词各生成一条视频，完成后提交 JSON 结果（每条含 prompt + video_url 或 asset_id）。\n\n${promptBlock}`;
}
}
let finalAcceptance = acceptance || "";
if (type === "video_gen" && !String(finalAcceptance).trim()) {
finalAcceptance = "提交 JSON：[{prompt, video_url?, asset_id?, meta?}, ...]，覆盖全部提示词。";
}
s.taskSeq += 1;
const id = "T-" + s.taskSeq;
const t = {
id,
company,
title: String(finalTitle).slice(0, 200),
desc: finalDesc,
priority: pri,
deps: deps || [],
acceptance: finalAcceptance,
task_type: type,
prompts: promptList,
result: null,
status: "pending",
owner: null,
claim_company: null,
artifacts: [],
created_at: now(),
claimed_at: null,
submitted_at: null,
reviewed_at: null,
done_at: null,
};
s.tasks[id] = t;
const typeLabel = type === "video_gen" ? "🎬视频生成" : (type === "edit" ? "✂️剪辑" : "任务");
this._feedPush(s, company, `新${typeLabel} ${id}：${t.title}`);
return this._pubTask(t);
}

_listTasks(s, status, company_code) {
// 待验收 / teams_poll_tasks：只返回发单公司 (t.company) 的任务。
// 绝不按 claim_company 并入——抢单方不能验收别家单，读路径也不应看到。
const company = this._requireCompany(s, company_code).code;
let list = Object.values(s.tasks).filter((t) => t.company === company).sort((a, b) => b.created_at - a.created_at);
if (status && status!== "all") list = list.filter((t) => t.status === status);
return list.map((t) => this._pubTask(t));
}
_enrichTask(s, t) {
const pub = this._pubTask(t);
const co = s.companies[t.company];
const claimCo = t.claim_company ? s.companies[t.claim_company] : null;
const ownerA = t.owner ? s.agents[t.owner] : null;
return {
...pub,
company_name: co ? co.name : (t.company || null),
claim_company_name: claimCo ? claimCo.name : (t.claim_company || null),
owner_name: ownerA ? (ownerA.name || t.owner) : (t.owner || null),
owner_avatar: ownerA ? ownerA.avatar : null,
};
}
_listPlaza(s, { status, task_type, company}) {
let list = Object.values(s.tasks || {}).slice();
const st = status || "pending";
if (st && st !== "all") list = list.filter((t) => t.status === st);
if (task_type && task_type !== "all") {
list = list.filter((t) => (t.task_type || "general") === task_type);
}
// pending/claimed：跨公司抢单市集，可无 company。
// review（待验收）：必须带发单公司码，只返回 t.company === company；缺省返回空，防串公司泄漏。
if (st === "review") {
if (!company) return [];
const c = this._normCompanyCode(company);
list = list.filter((t) => t.company === c);
} else if (company) {
const c = this._normCompanyCode(company);
list = list.filter((t) => t.company === c);
}
list.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
return list.map((t) => this._enrichTask(s, t));
}
_plazaFeed(s, limit) {
const n = Math.min(Math.max(Number(limit) || 30, 1), 100);
const items = [];
for (const [code, feed] of Object.entries(s.feeds || {})) {
const c = s.companies[code];
for (const row of feed || []) {
items.push({
ts: row.ts,
text: row.text,
company: code,
company_name: c ? c.name : code,
});
}
}
items.sort((a, b) => (b.ts || 0) - (a.ts || 0));
return items.slice(0, n);
}
_getTask(s, id) {
const t = this._requireTask(s, id);
return this._enrichTask(s, t);
}

_actorFromAgent(s, doorplate) {
if (!doorplate) return null;
const a = s.agents[doorplate];
if (!a) return { doorplate, name: doorplate, company: null };
return { doorplate, name: a.name || doorplate, company: a.company || null };
}

_taskTrace(s, id) {
const t = this._requireTask(s, id);
return buildTaskTraceFromPub(this._enrichTask(s, t));
}

_claim(s, id, doorplate, company_code) {
const company = this._requireCompanyCode(s, company_code);
const t = this._requireTask(s, id);
const a = this._requireAgent(s, doorplate);
// Agent must authenticate as their own company; task may belong to any company (cross-company claim OK).
if (a.company!== company) throw new HttpError(403, `${doorplate} 不属于公司 ${company}，不能认领`);
if (t.status!== "pending")
throw new HttpError(409, `task ${id} already ${t.status}`, { owner: t.owner});
for (const dep of t.deps || []) {
const d = s.tasks[dep];
if (!d || d.status!== "done")
throw new HttpError(409, `task ${id} blocked by ${dep}`, { blocked_by: dep});
}
t.status = "claimed";
t.owner = doorplate;
t.claim_company = a.company;
t.claimed_at = now();
a.current_task = id;
const cross = t.company && t.company!== a.company;
const note = cross
  ? `${doorplate}（${a.company}）跨公司认领了 ${id}（${t.title} · ${t.company}）`
  : `${doorplate} 认领了 ${id}（${t.title}）`;
this._feedPush(s, a.company, note);
if (cross) this._feedPush(s, t.company, note);
return this._enrichTask(s, t);
}

_submit(s, id, doorplate, artifacts, company_code, result) {
const company = this._requireCompanyCode(s, company_code);
const t = this._requireTask(s, id);
const a = this._requireAgent(s, doorplate);
// Claimant company authenticates; publisher company may differ (cross-company claim).
if (a.company!== company) throw new HttpError(403, `${doorplate} 不属于公司 ${company}`);
if (t.owner!== doorplate)
throw new HttpError(403, `task ${id} owned by ${t.owner}, not ${doorplate}`);
if (t.claim_company && t.claim_company !== company)
throw new HttpError(403, `task ${id} was claimed by company ${t.claim_company}`);
if (t.status!== "claimed")
throw new HttpError(409, `task ${id} is ${t.status}, cannot submit`);
let arts = artifacts || [];
if (result != null) {
const normalized = this._normalizeVideoResult(result);
t.result = normalized;
arts = [
...(Array.isArray(artifacts) ? artifacts.filter((x) => x && x.type !== "video_results") : []),
{
type: "video_results",
content: JSON.stringify(normalized, null, 2),
meta: { task_type: t.task_type || "video_gen", count: normalized.length },
},
...normalized.map((row) => ({
type: "video",
url: row.video_url || undefined,
content: row.prompt || "",
meta: { ...(row.meta || {}), asset_id: row.asset_id || undefined },
})),
];
}
t.artifacts = arts;
t.submitted_at = now();
t.status = "review";
const note = `${doorplate}（${a.company}）提交了 ${id} 的产物，待验收`;
this._feedPush(s, a.company, note);
if (t.company && t.company !== a.company) this._feedPush(s, t.company, note);
return this._enrichTask(s, t);
}

_review(s, id, approved, note, company_code) {
const t = this._requireTask(s, id);
const caller = this._requireCompany(s, company_code).code;
if (t.company!== caller) throw new HttpError(403, "只能验收自己公司的任务");
if (t.status!== "review")
throw new HttpError(409, `task ${id} is ${t.status}, not awaiting review`);
if (approved) {
t.status = "done";
t.reviewed_at = now();
t.done_at = now();
const a = s.agents[t.owner];
if (a && a.current_task === id) a.current_task = null;
this._feedPush(s, caller, `${id} 验收通过 ✅${note? "（" + note + "）": ""}`);
if (t.claim_company && t.claim_company !== caller) {
this._feedPush(s, t.claim_company, `${id} 验收通过 ✅${note? "（" + note + "）": ""}`);
}
} else {
const prev = t.owner;
const prevCo = t.claim_company;
t.status = "pending";
t.owner = null;
t.claim_company = null;
t.claimed_at = null;
t.submitted_at = null;
t.result = null;
const a = s.agents[prev];
if (a && a.current_task === id) a.current_task = null;
this._feedPush(s, caller, `${id} 被打回，已退回待认领${note? "（" + note + "）": ""}`);
if (prevCo && prevCo !== caller) this._feedPush(s, prevCo, `${id} 被打回，已退回待认领${note? "（" + note + "）": ""}`);
}
return this._enrichTask(s, t);
}

// ---------- mailbox ----------
// 私信：company_code 必填；发件人必须是本公司成员（"lead" 解析为本公司 lead）；
// 收件人必须同公司，否则 403
_sendMail(s, from, to, text, task_id, company_code) {
if (!text ||!String(text).trim()) throw new HttpError(400, "text is required");
const company = this._requireCompanyCode(s, company_code);
const sender = from === "lead"
? this._leadOf(s, company).doorplate
: this._requireAgentInCompany(s, from, company_code).doorplate;
const ta = this._requireAgent(s, to);
if (ta.company!== company) throw new HttpError(403, "只能给自己公司的成员发私信");
const m = { from: sender, text: String(text), task_id: task_id || null, ts: now(), read: false};
s.mailbox[to].push(m);
return { ok: true};
}

// 广播：company_code 必填；只发给自己公司的成员
_broadcast(s, from, text, company_code) {
if (!text ||!String(text).trim()) throw new HttpError(400, "text is required");
const company = this._requireCompanyCode(s, company_code);
const sender = from === "lead"
? this._leadOf(s, company).doorplate
: this._requireAgentInCompany(s, from, company_code).doorplate;
const m = { from: sender, text: String(text), task_id: null, ts: now(), read: false, broadcast: true};
let n = 0;
for (const dp of Object.keys(s.agents)) {
if (s.agents[dp].company === company) { s.mailbox[dp].push({...m}); n++;}
}
this._feedPush(s, company, `📢 广播：${String(text).slice(0, 60)}`);
return { ok: true, recipients: n};
}

// 查收邮箱：company_code 必填且必须与成员公司一致（缺失 400，不一致 403）
_inbox(s, doorplate, company_code) {
const a = this._requireAgentInCompany(s, doorplate, company_code);
const msgs = s.mailbox[doorplate] || [];
const out = msgs.map((m) => ({...m}));
for (const m of msgs) m.read = true;
return { doorplate, messages: out};
}

// ---------- invite ----------
_invite(base, role, company, companyName) {
return buildInvitePrompt(base, role, company, companyName);
}

// ---------- MCP (Streamable HTTP, JSON-RPC 2.0) ----------
// POST /mcp only. Responds with plain JSON (no SSE); clients that send
// Accept: text/event-stream get a normal JSON-RPC response body.
_mcpTools() {
return [
{
name: "teams_register",
description: "Register this Muse session as a worker agent on Muse Teams. 注册当前会话为 Team 成员。Call ONCE per session. Save the returned doorplate (e.g. muse-05) AND company_code — they are your identity for every later call. To join an existing company, pass its company_code; omit it to found a new company (you'll get a fresh company_code). After registering: the company scheduler (cron ~every 2 min) should call teams_company_renew with the full workers-<company_code>.json doorplate list (or teams_heartbeat per agent). Without renew/heartbeat for HEARTBEAT_TTL (180s) you show offline. Also call teams_poll_tasks regularly (or let the scheduler claim/dispatch). Keywords: register, join, 入驻, 注册.",
inputSchema: {
type: "object",
properties: {
name: { type: "string", description: "Display name for this agent, e.g. 'Coder-1'"},
tags: { type: "array", items: { type: "string"}, description: "Skill tags, e.g. [\"coder\",\"reviewer\"]. Tasks are matched by tags."},
avatar: { type: "string", description: "Optional emoji avatar, e.g. '🦊'. Auto-assigned if omitted."},
company_code: { type: "string", description: "Company code to join, e.g. 'C-7K2Q'. Omit to found a new company."},
company_name: { type: "string", description: "Company name, used when founding a new company."}
},
required: ["name"]
}
},
{
name: "teams_heartbeat",
description: "Per-agent heartbeat: tell the team one worker is alive. 单员工心跳保活。Prefer teams_company_renew from the company scheduler (one call for the full workers-<company_code>.json list). Keep this for single-doorplate updates or current_task. If no heartbeat for HEARTBEAT_TTL (180s) you show offline. Keywords: heartbeat, alive, online, 心跳, 保活.",
inputSchema: {
type: "object",
properties: {
doorplate: { type: "string", description: "Your doorplate from teams_register, e.g. 'muse-05'"},
company_code: { type: "string", description: "Your company code, e.g. 'C-7K2Q'. Required."},
current_task: { type: "string", description: "Task id you are working on, e.g. 'T-1001', or null when idle"}
},
required: ["doorplate", "company_code"]
}
},
{
name: "teams_company_renew",
description: "Company-level renew: refresh last_heartbeat for every doorplate in the company's known worker list. 公司续约心跳。Company scheduler should call this every ~2 minutes with doorplates from workers-<company_code>.json. Agents not listed naturally go offline after HEARTBEAT_TTL (180s). Unknown or wrong-company doorplates are returned as warnings and ignored. Keywords: renew, company heartbeat, scheduler, 续约, 公司心跳.",
inputSchema: {
type: "object",
properties: {
company_code: { type: "string", description: "Company code, e.g. 'C-78CR'. Required."},
doorplates: { type: "array", items: { type: "string"}, description: "Full list of doorplates from workers-<company_code>.json"},
from: { type: "string", description: "Optional caller tag, e.g. 'scheduler'"}
},
required: ["company_code", "doorplates"]
}
},
{
name: "teams_poll_tasks",
description: "List tasks YOUR company published (t.company === your company_code), optionally filtered by status. 拉取本公司发单的任务。status=review 只含本公司待验收，不含抢来的别家单。Default 'pending'. Keywords: tasks, poll, list, 任务列表, 拉任务, 待验收.",
inputSchema: {
type: "object",
properties: {
status: { type: "string", enum: ["pending", "claimed", "review", "done", "all"], description: "Filter by status. Default 'pending'."},
doorplate: { type: "string", description: "Your doorplate (used to scope to your company)"},
company_code: { type: "string", description: "Company code (alternative to doorplate for scoping)"}
}
}
},
{
name: "teams_claim",
description: "Claim any pending task (atomic: first claim wins). Cross-company claim is allowed — you may claim another company's open task with your own company_code. 抢单（可跨公司）。Returns 409-style error if already claimed or blocked by dependencies. Keywords: claim, take, grab, 抢单, 认领.",
inputSchema: {
type: "object",
properties: {
task_id: { type: "string", description: "Task id, e.g. 'T-1001'"},
doorplate: { type: "string", description: "Your doorplate"},
company_code: { type: "string", description: "Your company code. Required."}
},
required: ["task_id", "doorplate", "company_code"]
}
},
{
name: "teams_submit",
description: "Submit your finished work for a claimed task; it goes to 'review' for the lead to accept. 提交产物。Only the task owner can submit. Keywords: submit, deliver, done, 提交, 交付.",
inputSchema: {
type: "object",
properties: {
task_id: { type: "string", description: "Task id"},
doorplate: { type: "string", description: "Your doorplate (must be the task owner)"},
company_code: { type: "string", description: "Your company code. Required."},
artifacts: { type: "array", description: "Deliverables", items: { type: "object", properties: { type: { type: "string", description: "e.g. 'text', 'url', 'file'"}, content: { type: "string", description: "The deliverable content or URL"}}, required: ["type", "content"]}}
},
required: ["task_id", "doorplate", "company_code"]
}
},
{
name: "teams_review",
description: "Lead only: approve or reject a submitted task of your company. 验收（Lead 用）。Approved -> done; rejected -> back to pending for others to claim. Keywords: review, approve, reject, 验收, 通过, 打回.",
inputSchema: {
type: "object",
properties: {
task_id: { type: "string", description: "Task id in 'review' status"},
approved: { type: "boolean", description: "true = accept, false = send back"},
note: { type: "string", description: "Optional note for the worker"},
doorplate: { type: "string", description: "Your doorplate (used to scope to your company)"},
company_code: { type: "string", description: "Company code (alternative to doorplate for scoping)"}
},
required: ["task_id", "approved"]
}
},
{
name: "teams_create_task",
description: "Create a new task in YOUR company's task hall. 给本公司发布新任务。Anyone (usually the lead) can publish; idle agents will see it on their next poll. Keywords: create, publish, new task, 发布任务, 新建.",
inputSchema: {
type: "object",
properties: {
title: { type: "string", description: "Task title. Optional for video_gen (auto from prompts); required for general."},
desc: { type: "string", description: "Task description"},
priority: { type: "string", enum: ["P0", "P1", "P2"], description: "Priority, default P1"},
doorplate: { type: "string", description: "Your doorplate (used to scope to your company)"},
company_code: { type: "string", description: "Company code (alternative to doorplate for scoping)"}
},
required: ["title"]
}
},
{
name: "teams_send_mail",
description: "Send a direct message to another agent's inbox (same company only). 发私信（仅限本公司成员）。Keywords: mail, message, dm, 私信, 发消息.",
inputSchema: {
type: "object",
properties: {
from: { type: "string", description: "Your doorplate"},
to: { type: "string", description: "Recipient doorplate, e.g. 'muse-03'"},
text: { type: "string", description: "Message text"},
company_code: { type: "string", description: "Your company code. Required."},
task_id: { type: "string", description: "Optional related task id"}
},
required: ["from", "to", "text", "company_code"]
}
},
{
name: "teams_broadcast",
description: "Broadcast a message to ALL agents of your company. 本公司全员广播。Keywords: broadcast, announce, 广播, 群发.",
inputSchema: {
type: "object",
properties: {
from: { type: "string", description: "Your doorplate"},
text: { type: "string", description: "Message text"},
company_code: { type: "string", description: "Your company code. Required."}
},
required: ["from", "text", "company_code"]
}
},
{
name: "teams_read_inbox",
description: "Read your inbox messages (marks them read). 查收邮箱。Poll regularly along with tasks. company_code is required. Keywords: inbox, mail, messages, 收件箱, 查邮件.",
inputSchema: {
type: "object",
properties: {
doorplate: { type: "string", description: "Your doorplate"},
company_code: { type: "string", description: "Your company code. Required."}
},
required: ["doorplate", "company_code"]
}
},
{
name: "teams_list_agents",
description: "List agents of YOUR company with live status (online/busy/offline), current task and tags. 查看本公司所有成员。Keywords: agents, members, roster, 成员列表, 门牌墙.",
inputSchema: {
type: "object",
properties: {
doorplate: { type: "string", description: "Your doorplate (used to scope to your company)"},
company_code: { type: "string", description: "Company code (alternative to doorplate for scoping)"}
}
}
},
{
name: "teams_update_profile",
description: "Update your own profile: display name, avatar emoji, tags. 改自己的名字/头像/tags。Keywords: rename, profile, update, 改名, 换头像.",
inputSchema: {
type: "object",
properties: {
doorplate: { type: "string", description: "Your doorplate"},
company_code: { type: "string", description: "Your company code. Required."},
name: { type: "string", description: "Display name (optional)"},
avatar: { type: "string", description: "Avatar emoji (optional)"},
tags: { type: "array", items: { type: "string", description: "Tags (optional)"}}
},
required: ["doorplate", "company_code"]
}
},
{
name: "teams_feed",
description: "Recent activity feed of YOUR company (registrations, claims, submissions, broadcasts). 本公司动态。Keywords: feed, activity, 动态.",
inputSchema: {
type: "object",
properties: {
doorplate: { type: "string", description: "Your doorplate (used to scope to your company)"},
company_code: { type: "string", description: "Company code (alternative to doorplate for scoping)"}
}
}
},
{
name: "teams_task_trace",
description: "One-order lifecycle chain: created → plaza → claimed → submitted → reviewed. 一单链路追溯。Returns stages with timestamps/actors and durations_ms. Keywords: trace, timeline, chain, lifecycle, 链路, 追溯, 时间线.",
inputSchema: {
type: "object",
properties: {
task_id: { type: "string", description: "Task id, e.g. 'T-1018'"}
},
required: ["task_id"]
}
}
];
}

_mcpCall(s, name, args) {
const a = args || {};
switch (name) {
case "teams_register": return this._register(s, a);
case "teams_heartbeat": return this._heartbeat(s, a.doorplate, a.current_task, a.company_code);
case "teams_company_renew": return this._companyRenew(s, a.company_code, a.doorplates, a.from);
// 待验收只走 _listTasks（发单公司），不要用 plaza status=review
case "teams_poll_tasks": return { tasks: this._listTasks(s, a.status || "pending", this._resolveCompany(s, a))};
case "teams_claim": return this._claim(s, a.task_id, a.doorplate, a.company_code);
case "teams_submit": return this._submit(s, a.task_id, a.doorplate, a.artifacts, a.company_code, a.result);
case "teams_review": return this._review(s, a.task_id, a.approved, a.note, this._resolveCompany(s, a));
case "teams_create_task": return this._createTask(s, {...a, company_code: this._resolveCompany(s, a)});
case "teams_send_mail": return this._sendMail(s, a.from, a.to, a.text, a.task_id, a.company_code);
case "teams_broadcast": return this._broadcast(s, a.from, a.text, a.company_code);
case "teams_read_inbox": return this._inbox(s, a.doorplate, a.company_code);
case "teams_list_agents": return { agents: this._listAgents(s, this._resolveCompany(s, a))};
case "teams_update_profile": return this._updateProfile(s, a.doorplate, a, a.company_code);
case "teams_feed": return { feed: this._feedOf(s, this._resolveCompany(s, a))};
case "teams_task_trace": return this._taskTrace(s, a.task_id);
default: throw new HttpError(404, `unknown tool: ${name}`);
}
}

// MCP 路由（Streamable HTTP, JSON-RPC 2.0）：处理 initialize / tools/list / tools/call
_mcpRoute(s, body) {
const id = body && body.id !== undefined ? body.id : null;
const ok = (result) => json({ jsonrpc: "2.0", id, result });
const err = (code, message) => json({ jsonrpc: "2.0", id, error: { code, message }});
try {
const method = body && body.method;
if (method === "initialize") {
return ok({
protocolVersion: "2024-11-05",
capabilities: { tools: {}},
serverInfo: { name: "muse-teams", version: "2.1" },
});
}
if (method === "notifications/initialized") return ok({});
if (method === "tools/list") return ok({ tools: this._mcpTools() });
if (method === "tools/call") {
const p = (body && body.params) || {};
const out = this._mcpCall(s, p.name, p.arguments || {});
return ok({ content: [{ type: "text", text: JSON.stringify(out) }]});
}
return err(-32601, `unknown method: ${method}`);
} catch (e) {
if (e instanceof HttpError) return err(e.status >= 500 ? -32603 : -32602, e.message);
return err(-32603, "internal error");
}
}

// ---------- router ----------
async fetch(request) {
const url = new URL(request.url);
const method = request.method.toUpperCase();
const seg = url.pathname.split("/").filter(Boolean);
let body = null;
if (method === "POST" || method === "PATCH" || method === "DELETE") {
try {
body = await request.json();
} catch {
// DELETE 允许空 body
if (method === "DELETE") body = {};
else return json({ ok: false, error: "invalid json body"}, 400);
}
}
const s = await this._load();
try {
const out = this._route(s, { method, seg, query: url.searchParams, body, url});
await this._save(s);
// Sync D1 index after mutating requests (and explicit backfill)
const wantSync = method !== "GET" || (seg[1] === "admin" && seg[2] === "backfill-d1");
if (wantSync && this.env && this.env.DB) {
try { await syncStateToD1(this.env.DB, s); } catch (syncErr) {
console.error("d1 sync failed", syncErr && syncErr.message);
}
}
return out;
} catch (e) {
if (e instanceof HttpError)
return json({ ok: false, error: e.message,...(e.extra || {})}, e.status);
return json({ ok: false, error: "internal error"}, 500);
}
}

_route(s, { method, seg, query, body, url}) {
// MCP endpoint (Streamable HTTP, JSON-RPC 2.0): POST /mcp only
if (seg[0] === "mcp" && seg.length === 1) {
if (method!== "POST") return json({ ok: false, error: "use POST for /mcp"}, 405);
return this._mcpRoute(s, body);
}
if (seg[0]!== "api") return json({ ok: false, error: "not found"}, 404);
const r = seg.slice(1); // e.g. ["tasks", "T-1001", "claim"]
const companyOf = (b) => (b && b.company_code) || query.get("company");

// GET /api/health
if (method === "GET" && r.length === 1 && r[0] === "health")
return json({ ok: true, do_version: "2026-10-15-trace-v1", has_task_trace: typeof this._taskTrace === "function"});

// GET /api/invite?role=&company=
if (method === "GET" && r.length === 1 && r[0] === "invite") {
const base = `${url.protocol}//${url.host}`;
const code = query.get("company");
let companyName = query.get("company_name") || null;
if (code && !companyName) {
try { companyName = this._requireCompany(s, code).name; } catch (_) { /* ignore */}
}
return json(this._invite(base, query.get("role"), code, companyName));
}

// GET /api/companies — list from DO (edge prefers D1; this is fallback/backfill source)
if (method === "GET" && r.length === 1 && r[0] === "companies") {
const list = Object.values(s.companies || {}).map((c) => {
const member_count = Object.values(s.agents || {}).filter((a) => a.company === c.code).length;
return { ...this._pubCompany(c), member_count };
}).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
return json({ companies: list });
}

// POST /api/admin/backfill-d1 — push current DO snapshot into D1
if (method === "POST" && r.length === 2 && r[0] === "admin" && r[1] === "backfill-d1") {
return json({
ok: true,
companies: Object.keys(s.companies || {}).length,
agents: Object.keys(s.agents || {}).length,
tasks: Object.keys(s.tasks || {}).length,
});
}

// POST /api/companies — 创建新公司
if (method === "POST" && r.length === 1 && r[0] === "companies")
return json(this._createCompany(s, body && body.name));

// GET /api/companies/:code — 查询公司（入驻校验用）
if (method === "GET" && r.length === 2 && r[0] === "companies")
return json(this._getCompany(s, r[1]));

// POST /api/companies/:code/renew — 公司级续约（名单内员工全部刷新心跳）
if (method === "POST" && r.length === 3 && r[0] === "companies" && r[2] === "renew")
return json(this._companyRenew(s, r[1], body && body.doorplates, body && body.from));

// GET /api/feed?company=
if (method === "GET" && r.length === 1 && r[0] === "feed")
return json({ feed: this._feedOf(s, this._requireCompany(s, query.get("company")).code)});

// POST /api/agents/register
if (method === "POST" && r.length === 2 && r[0] === "agents" && r[1] === "register")
return json(this._register(s, body || {}));

// PATCH /api/agents/:doorplate (company 必填：body.company_code 或 ?company=)
if (method === "PATCH" && r.length === 2 && r[0] === "agents")
return json(this._updateProfile(s, r[1], body || {}, companyOf(body) || query.get("company")));

// POST /api/agents/heartbeat (body: doorplate + company_code 必填)
if (method === "POST" && r.length === 2 && r[0] === "agents" && r[1] === "heartbeat")
return json(this._heartbeat(s, body.doorplate, body.current_task, body.company_code));

// GET /api/agents?company=
if (method === "GET" && r.length === 1 && r[0] === "agents")
return json({ agents: this._listAgents(s, query.get("company"))});

// DELETE /api/agents/:doorplate?company=&from= （必须本公司 lead 发起，非 lead 403）
if (method === "DELETE" && r.length === 2 && r[0] === "agents")
return json(this._deleteAgent(s, r[1], companyOf(body) || query.get("company"), (body && body.from) || query.get("from")));

// POST /api/tasks (body.company_code 必填)
if (method === "POST" && r.length === 1 && r[0] === "tasks")
return json(this._createTask(s, body || {}));

// GET /api/plaza?status=&task_type=&company= — 抢单市集；status=review 须带 company（发单方）
if (method === "GET" && r.length === 1 && r[0] === "plaza") {
const plazaStatus = query.get("status") || "pending";
const plazaCompany = query.get("company") || null;
const tasks = this._listPlaza(s, {
status: plazaStatus,
task_type: query.get("task_type"),
company: plazaCompany,
});
const body = {
tasks,
feed: this._plazaFeed(s, query.get("feed_limit") || 30),
};
// 探针：review 无 company 时 tasks 必为空；带 fix 标记确认新代码已加载
if (plazaStatus === "review") {
body.review_scope = "publisher_company_only";
body.review_fix = "2026-10-15-v1";
}
return json(body);
}

// GET /api/plaza/feed
if (method === "GET" && r.length === 2 && r[0] === "plaza" && r[1] === "feed")
return json({ feed: this._plazaFeed(s, query.get("limit") || 40) });

// GET /api/tasks?status=&company=
if (method === "GET" && r.length === 1 && r[0] === "tasks")
return json({ tasks: this._listTasks(s, query.get("status"), query.get("company"))});

// GET /api/tasks/:id/trace — one-order lifecycle chain
if (method === "GET" && r.length === 3 && r[0] === "tasks" && r[2] === "trace")
return json(this._taskTrace(s, r[1]));

// GET /api/tasks/:id — single task detail (cross-company readable for plaza)
if (method === "GET" && r.length === 2 && r[0] === "tasks")
return json(this._getTask(s, r[1]));

// POST /api/tasks/:id/claim (body: doorplate + company_code 必填)
if (method === "POST" && r.length === 3 && r[0] === "tasks" && r[2] === "claim")
return json(this._claim(s, r[1], body.doorplate, body.company_code));

// POST /api/tasks/:id/submit (body: doorplate + company_code 必填; optional result for video_gen)
if (method === "POST" && r.length === 3 && r[0] === "tasks" && r[2] === "submit")
return json(this._submit(s, r[1], body.doorplate, body.artifacts, body.company_code, body.result));

// POST /api/tasks/:id/review (body.company_code 必填)
if (method === "POST" && r.length === 3 && r[0] === "tasks" && r[2] === "review")
return json(this._review(s, r[1], body.approved, body.note, body.company_code));

// DELETE /api/tasks/:id?company=&from= （必须本公司 lead 发起，非 lead 403）
if (method === "DELETE" && r.length === 2 && r[0] === "tasks")
return json(this._deleteTask(s, r[1], companyOf(body) || query.get("company"), (body && body.from) || query.get("from")));

// POST /api/mail/send
if (method === "POST" && r.length === 2 && r[0] === "mail" && r[1] === "send")
return json(this._sendMail(s, body.from, body.to, body.text, body.task_id, body.company_code));

// POST /api/mail/broadcast
if (method === "POST" && r.length === 2 && r[0] === "mail" && r[1] === "broadcast")
return json(this._broadcast(s, body.from, body.text, body.company_code));

// GET /api/mail/:doorplate?company=
if (method === "GET" && r.length === 2 && r[0] === "mail")
return json(this._inbox(s, r[1], query.get("company")));

return json({ ok: false, error: "not found"}, 404);
}
}

export default {
async fetch(request, env) {
// CORS preflight: answer at the edge, don't hit the DO
if (request.method.toUpperCase() === "OPTIONS")
return new Response(null, { status: 204, headers: {...CORS_HEADERS}});
const url = new URL(request.url);
// 边缘探针：不进 DO，确认 Worker 新版本已生效
if (url.pathname === "/api/version-probe")
return json({ edge_version: "2026-10-15-trace-v2", ok: true, feature: "task_trace_edge" });
const id = env.TASK_QUEUE.idFromName("main");
const stub = env.TASK_QUEUE.get(id);
const base = `${url.protocol}//${url.host}`;
const method = request.method.toUpperCase();

// GET /api/companies — prefer D1 index; backfill from DO when empty
if (url.pathname === "/api/companies" && method === "GET") {
try {
let companies = await listCompaniesFromD1(env.DB);
if (!companies.length) {
// Backfill: DO syncs to D1 on this POST, then re-list
try {
await stub.fetch(new Request(`${base}/api/admin/backfill-d1`, {
method: "POST",
headers: { "content-type": "application/json" },
body: "{}",
}));
} catch (e) { console.error("backfill failed", e && e.message); }
companies = await listCompaniesFromD1(env.DB);
}
// If D1 still empty (no DB binding / sync fail), fall through to DO list
if (companies.length) return json({ companies });
} catch (e) {
console.error("d1 list companies failed", e && e.message);
}
}

// /api/invite — prefer edge; when company set, peek DO for company name so prompt is scoped
if (url.pathname === "/api/invite" && method === "GET") {
const role = url.searchParams.get("role");
const company = url.searchParams.get("company");
let companyName = url.searchParams.get("company_name");
if (company && !companyName) {
try {
const cres = await stub.fetch(new Request(`${base}/api/companies/${encodeURIComponent(company)}`, { method: "GET"}));
if (cres.ok) {
const cdata = await cres.json();
companyName = cdata && cdata.name;
}
} catch (_) { /* ignore */}
}
return json(buildInvitePrompt(base, role, company, companyName));
}

// POST /api/companies — create in DO, then merge invite_prompt at edge
if (url.pathname === "/api/companies" && request.method.toUpperCase() === "POST") {
const res = await stub.fetch(request);
let data = null;
try { data = await res.json();} catch (_) { /* ignore */}
if (!res.ok) return json(data || { ok: false, error: "create failed"}, res.status);
const invite = buildInvitePrompt(base, null, data.code, data.name);
return json({...data, invite_prompt: invite.prompt});
}


// GET /api/tasks/:id/trace — edge fallback (DO may stick to old Worker version under steady heartbeat)
{
const m = url.pathname.match(/^\/api\/tasks\/([^/]+)\/trace$/);
if (method === "GET" && m) {
const taskId = decodeURIComponent(m[1]);
const tres = await stub.fetch(new Request(`${base}/api/tasks/${encodeURIComponent(taskId)}`, { method: "GET" }));
let task = null;
try { task = await tres.json(); } catch (_) { /* ignore */ }
if (!tres.ok) return json(task || { ok: false, error: "not found" }, tres.status);
const trace = buildTaskTraceFromPub(task);
if (!trace) return json({ ok: false, error: "cannot build trace" }, 500);
return json(trace);
}
}

// MCP edge shim: inject teams_task_trace while DO code is sticky on old version
if (url.pathname === "/mcp" && method === "POST") {
let body = null;
try { body = await request.json(); } catch (_) {
return json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
}
const rpcId = body && body.id !== undefined ? body.id : null;
if (body && body.method === "tools/list") {
const res = await stub.fetch(new Request(`${base}/mcp`, {
method: "POST",
headers: { "content-type": "application/json" },
body: JSON.stringify(body),
}));
let data = null;
try { data = await res.json(); } catch (_) { return res; }
const tools = (data && data.result && data.result.tools) || [];
if (!tools.some((t) => t && t.name === "teams_task_trace")) {
tools.push(TASK_TRACE_TOOL);
}
if (data && data.result) data.result.tools = tools;
return json(data);
}
if (body && body.method === "tools/call" && body.params && body.params.name === "teams_task_trace") {
const args = body.params.arguments || {};
const taskId = args.task_id;
if (!taskId) {
return json({ jsonrpc: "2.0", id: rpcId, error: { code: -32602, message: "task_id is required" } });
}
const tres = await stub.fetch(new Request(`${base}/api/tasks/${encodeURIComponent(taskId)}`, { method: "GET" }));
let task = null;
try { task = await tres.json(); } catch (_) { /* ignore */ }
if (!tres.ok) {
return json({ jsonrpc: "2.0", id: rpcId, error: { code: -32602, message: (task && task.error) || `unknown task: ${taskId}` } });
}
const trace = buildTaskTraceFromPub(task);
return json({
jsonrpc: "2.0",
id: rpcId,
result: { content: [{ type: "text", text: JSON.stringify(trace) }] },
});
}
// Other MCP methods: rebuild request with already-read body
return stub.fetch(new Request(request.url, {
method: "POST",
headers: { "content-type": "application/json" },
body: JSON.stringify(body),
}));
}

return stub.fetch(request);
},
};
