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

const HEARTBEAT_TTL_MS = 180_000; // 调度器每 120s 跑一次，TTL 必须大于周期
// 无心跳超过 TTL → 员工 status=dormant（休眠员工）；公司无人有新鲜心跳 → heartbeat_dormant（休眠公司，衍生字段，不改 status）
// 手动 suspended/archived 仍写 status，优先于衍生休眠；claim/create/join 门控只看 status，不因 heartbeat_dormant 拦截
const FEED_CAP = 100;
const AVATARS = ["🦊", "🐼", "🦁", "🐯", "🦉", "🐬", "🦄", "🐝", "🦋", "🐙", "🦔", "🐳"];
const COMPANY_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const DEFAULT_COMPANY_CODE = "C-0001";
const DEFAULT_COMPANY_NAME = "我的公司";

// Receipt box（回执箱）fixed enum — NOT mixed with task delivery package
const RECEIPT_TYPES = [
  "invite_sent", "invite_ack", "claim_ok", "submit_ok",
  "review_pass", "review_reject", "broadcast", "agent_offline", "quota_warn",
  "company_suspend", "company_resume", "company_archive",
];
const RECEIPT_LABELS = {
  invite_sent: "已发出邀请",
  invite_ack: "邀请已入职",
  claim_ok: "抢单成功",
  submit_ok: "已交交付包",
  review_pass: "验收通过",
  review_reject: "验收打回",
  broadcast: "公司广播",
  agent_offline: "员工休眠",
  quota_warn: "配额告警",
  company_suspend: "公司休眠",
  company_resume: "公司重开",
  company_archive: "公司注销",
};
const COMPANY_STATUSES = ["active", "suspended", "archived"];
const COMPANY_STATUS_ACTIVE = "active";
const COMPANY_STATUS_SUSPENDED = "suspended";
const COMPANY_STATUS_ARCHIVED = "archived";
const COMPANY_SPECIALTIES = ["video_gen", "edit", "general", "coder", "reviewer", "research", "qa", "zh-writing", "devops"];


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

/**
 * Employee role packs — Teams-side registry of 能力广场 (plaza) capability refs.
 * Source of truth for MCP/skill identities: https://fleet.vyibc.com/api/hub/registry
 * Teams does NOT invent a parallel capability store; packs only reference plaza ids
 * (mcp:… / skill:…) plus three instruction metas (主聊 / 旁聊调度 / 干活执行).
 * Invite stores role_pack_id + snapshot; redeem stamps the same onto the agent.
 */
const PLAZA_REGISTRY_URL = "https://fleet.vyibc.com/api/hub/registry";
const ROLE_PACKS = {
  video_gen_worker: {
    id: "video_gen_worker",
    name: "视频生成工人",
    duty: "抢 video_gen 单，用浏览器/Flow 生成视频并交交付包",
    specialties: ["video_gen"],
    instructions: [
      { role: "main", label: "主聊", summary: "对用户说明进度与验收标准；不直接操作机群，把活派给旁聊调度。", plaza_ref: null },
      { role: "scheduler", label: "旁聊调度", summary: "约每 2 分钟 teams_company_renew；扫 pending；按 tags 派给干活执行；跟踪 review。", plaza_ref: "mcp:muse-teams" },
      { role: "worker", label: "干活执行", summary: "teams_claim → 调视频 MCP 生成 → teams_submit 交付包（result[{prompt,video_url|asset_id}]）。", plaza_ref: "mcp:vyibc-video" },
    ],
    mcps: ["mcp:muse-teams", "mcp:vyibc-video", "mcp:vyibc-image", "mcp:vyibc-voice", "mcp:vyibc-browser"],
    skills: [
      "skill:vyibc-flow-video-studio/flow-video-studio",
      "skill:vyibc-flow-video-studio/flow-shots",
      "skill:vyibc-flow-video-studio/flow-delivery",
    ],
  },
  editor: {
    id: "editor",
    name: "剪辑编辑",
    duty: "做 edit / remix：字幕、二创管线、交剪辑产物",
    specialties: ["edit"],
    instructions: [
      { role: "main", label: "主聊", summary: "对齐剪辑需求与素材清单；验收成片与字幕。", plaza_ref: null },
      { role: "scheduler", label: "旁聊调度", summary: "心跳保活；派 edit 单；跟踪验收打回。", plaza_ref: "mcp:muse-teams" },
      { role: "worker", label: "干活执行", summary: "转写 / 二创 / 剪辑 MCP；提交交付包。", plaza_ref: "mcp:vyibc-video-remix" },
    ],
    mcps: ["mcp:muse-teams", "mcp:vyibc-video-remix", "mcp:vyibc-transcription", "mcp:vyibc-video-content"],
    skills: [
      "skill:video-remix-mcp",
      "skill:vyibc-flow-video-studio/flow-edit",
      "skill:vyibc-flow-video-studio/flow-postproduction",
    ],
  },
};

function listRolePacks() {
  return Object.values(ROLE_PACKS).map((p) => ({
    id: p.id,
    name: p.name,
    duty: p.duty,
    specialties: [...(p.specialties || [])],
    mcps: [...(p.mcps || [])],
    skills: [...(p.skills || [])],
    instructions_meta: (p.instructions || []).map((i) => ({
      role: i.role,
      label: i.label,
      summary: i.summary,
      plaza_ref: i.plaza_ref || null,
    })),
    plaza_source_of_truth: PLAZA_REGISTRY_URL,
  }));
}

function resolveRolePack(role_pack_id) {
  if (role_pack_id == null || role_pack_id === "") return null;
  const id = String(role_pack_id).trim();
  const pack = ROLE_PACKS[id];
  if (!pack) throw new HttpError(404, `unknown role_pack_id: ${id} (known: ${Object.keys(ROLE_PACKS).join(", ")})`);
  return pack;
}

function snapshotRolePack(pack) {
  if (!pack) return null;
  return {
    id: pack.id,
    name: pack.name,
    duty: pack.duty || "",
    specialties: [...(pack.specialties || [])],
    instructions_meta: (pack.instructions || []).map((i) => ({
      role: i.role,
      label: i.label,
      summary: i.summary,
      plaza_ref: i.plaza_ref || null,
    })),
    mcps: [...(pack.mcps || [])],
    skills: [...(pack.skills || [])],
    plaza_source_of_truth: PLAZA_REGISTRY_URL,
    snapped_at: now(),
  };
}


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
  created_at INTEGER NOT NULL,
  intro TEXT,
  tags TEXT
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
  muse_account TEXT,
  muse_session TEXT,
  role_pack_id TEXT,
  role_pack_snapshot TEXT,
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
CREATE TABLE IF NOT EXISTS invites (
  invite_id TEXT PRIMARY KEY,
  company_code TEXT NOT NULL,
  company_name TEXT,
  role TEXT,
  specialties TEXT,
  from_doorplate TEXT,
  target_hint TEXT,
  note TEXT,
  status TEXT NOT NULL,
  prompt TEXT,
  created_at INTEGER,
  redeemed_at INTEGER,
  redeemed_by TEXT,
  role_pack_id TEXT,
  role_pack_snapshot TEXT
);
CREATE TABLE IF NOT EXISTS task_assign (
  task_id TEXT PRIMARY KEY,
  assignee TEXT NOT NULL,
  assigner_company TEXT,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_task_assign_assignee ON task_assign(assignee);
CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  at INTEGER NOT NULL,
  company TEXT,
  "to" TEXT NOT NULL,
  "from" TEXT,
  ref TEXT,
  body TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  label TEXT
);
CREATE INDEX IF NOT EXISTS idx_receipts_to ON receipts("to", at);
CREATE INDEX IF NOT EXISTS idx_receipts_type ON receipts("to", type);
CREATE INDEX IF NOT EXISTS idx_invites_company ON invites(company_code);
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
  const isAssigned = !!(t.assigned || t.dispatch_mode === "assign");
  const stages = [
    {
      stage: "created",
      label: "发单",
      at: createdAt,
      actor: t.company
        ? { doorplate: null, name: company_name, company: t.company }
        : null,
      payload: { task_type: t.task_type || "general", priority: t.priority || "P1", assigned: isAssigned },
    },
    {
      stage: "plaza",
      label: isAssigned ? "跳过广场" : "进广场",
      at: isAssigned ? null : createdAt,
      actor: null,
      payload: isAssigned
        ? { skipped: true, reason: "direct_assign" }
        : { open_to: "cross_company" },
    },
    {
      stage: "claimed",
      label: isAssigned ? "直派" : "抢单",
      at: claimedAt,
      actor: ownerActor,
      payload: claimedAt
        ? {
            claim_company: t.claim_company || null,
            cross_company: !!(t.claim_company && t.company && t.claim_company !== t.company),
            assigned: isAssigned,
            dispatch_mode: t.dispatch_mode || (isAssigned ? "assign" : "claim"),
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
  return attachIntelliUi({
    task_id: t.id,
    task_type: t.task_type || "general",
    title: t.title,
    status: t.status,
    company: t.company || null,
    company_name,
    claim_company: t.claim_company || null,
    prompts: Array.isArray(t.prompts) ? t.prompts : [],
    result: t.result != null ? t.result : null,
    delivery: buildDeliveryEnvelope(t),
    stages,
    durations_ms: {
      pending_to_claim: ms(createdAt, claimedAt),
      claim_to_submit: ms(claimedAt, submittedAt),
      submit_to_done: ms(submittedAt, endAt),
      total: ms(createdAt, endAt),
    },
  });
}


/** IntelliUI timeline/v1 — minimal Muse/MCP-friendly rich timeline (no external IntelliUI schema found in-repo/Notion).
 *  MCP clients that understand type "intelliui/timeline" can render; others ignore and use text JSON.
 *  Events: id, ts, label, status (done|pending|rejected|live), duration_ms (into next), actor, detail.
 */
function buildIntelliUiTimeline(trace) {
  if (!trace || !Array.isArray(trace.stages)) return null;
  const durations = trace.durations_ms || {};
  const edgeKey = {
    'created->claimed': 'pending_to_claim',
    'plaza->claimed': 'pending_to_claim',
    'claimed->submitted': 'claim_to_submit',
    'submitted->reviewed': 'submit_to_done',
  };
  const events = trace.stages.map((s, i, arr) => {
    const next = arr[i + 1];
    let status = 'pending';
    if (s.at != null) status = 'done';
    if (s.stage === 'reviewed' && s.payload && s.payload.approved === false) status = 'rejected';
    if (s.at == null && i > 0 && arr[i - 1] && arr[i - 1].at != null) status = 'live';
    let duration_ms = null;
    if (next) {
      const k = edgeKey[`${s.stage}->${next.stage}`];
      if (k && durations[k] != null) duration_ms = durations[k];
      else if (s.at != null && next.at != null) duration_ms = Math.max(0, next.at - s.at);
    }
    return {
      id: s.stage,
      ts: s.at != null ? s.at : null,
      label: s.label || s.stage,
      status,
      duration_ms,
      actor: s.actor || null,
      detail: s.payload && Object.keys(s.payload).length ? s.payload : null,
    };
  });
  return {
    schema: 'intelliui/timeline/v1',
    kind: 'timeline',
    title: `${trace.task_id || ''} · ${trace.title || ''}`.trim(),
    subtitle: trace.status || null,
    task_id: trace.task_id || null,
    events,
    summary: {
      durations_ms: durations,
      company: trace.company || null,
      claim_company: trace.claim_company || null,
      task_type: trace.task_type || null,
    },
  };
}

function attachIntelliUi(trace) {
  if (!trace) return trace;
  const intelliui = buildIntelliUiTimeline(trace);
  if (intelliui) trace.intelliui = intelliui;
  return trace;
}

const TASK_TRACE_TOOL = {
  name: "teams_task_trace",
  description: "One-order lifecycle chain: created → plaza → claimed → submitted → reviewed. 一单链路追溯。Returns stages + intelliui/timeline/v1 (events with ts/label/status/duration_ms). Keywords: trace, timeline, chain, lifecycle, IntelliUI, 链路, 追溯, 时间线.",
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
  if (globalThis.__museTeamsD1Ready) return;
  // D1 exec accepts multi-statement in batch via prepare/run per statement
  const stmts = D1_SCHEMA_SQL.split(";").map((s) => s.trim()).filter(Boolean);
  for (const sql of stmts) {
    await db.prepare(sql).run();
  }
  // Soft migrations for existing DBs
  for (const sql of [
    "ALTER TABLE companies ADD COLUMN intro TEXT",
    "ALTER TABLE companies ADD COLUMN tags TEXT",
    "ALTER TABLE companies ADD COLUMN status TEXT",
    "ALTER TABLE companies ADD COLUMN suspended_at INTEGER",
    "ALTER TABLE companies ADD COLUMN archived_at INTEGER",
    "ALTER TABLE agents ADD COLUMN muse_account TEXT",
    "ALTER TABLE agents ADD COLUMN muse_session TEXT",
    "ALTER TABLE agents ADD COLUMN role_pack_id TEXT",
    "ALTER TABLE agents ADD COLUMN role_pack_snapshot TEXT",
    "ALTER TABLE invites ADD COLUMN role_pack_id TEXT",
    "ALTER TABLE invites ADD COLUMN role_pack_snapshot TEXT",
  ]) {
    try { await db.prepare(sql).run(); } catch (_) { /* column may already exist */ }
  }
  globalThis.__museTeamsD1Ready = true;
}

async function syncStateToD1(db, s) {
  if (!db || !s) return;
  await ensureD1Schema(db);
  const companies = Object.values(s.companies || {});
  const agents = Object.values(s.agents || {});
  const tasks = Object.values(s.tasks || {});

  // Preserve lifecycle status from D1 when DO snapshot is stale (edge-first lifecycle)
  let prevStatus = {};
  try {
    const { results: prevRows } = await db.prepare("SELECT code, status, suspended_at, archived_at FROM companies").all();
    for (const r of prevRows || []) {
      prevStatus[r.code] = { status: r.status, suspended_at: r.suspended_at, archived_at: r.archived_at };
    }
  } catch (_) { prevStatus = {}; }

  // Full replace for consistency with DO snapshot (small datasets)
  await db.batch([
    db.prepare("DELETE FROM tasks"),
    db.prepare("DELETE FROM agents"),
    db.prepare("DELETE FROM companies"),
  ]);

  const rank = { active: 0, suspended: 1, archived: 2 };
  const batch = [];
  for (const c of companies) {
    const prev = prevStatus[c.code] || {};
    let status = c.status || COMPANY_STATUS_ACTIVE;
    let suspended_at = c.suspended_at || null;
    let archived_at = c.archived_at || null;
    // If D1 had a "later" lifecycle state, keep it until DO catches up
    if (prev.status && (rank[prev.status] || 0) > (rank[status] || 0)) {
      status = prev.status;
      suspended_at = prev.suspended_at || suspended_at;
      archived_at = prev.archived_at || archived_at;
    }
    batch.push(
      db.prepare("INSERT INTO companies (code, name, created_at, intro, tags, status, suspended_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(
        c.code,
        c.name || c.code,
        c.created_at || 0,
        c.intro || c.blurb || "",
        JSON.stringify(Array.isArray(c.tags) ? c.tags : (c.specialties || [])),
        status,
        suspended_at && suspended_at !== 0 ? suspended_at : 0,
        archived_at && archived_at !== 0 ? archived_at : 0
      )
    );
  }
  // Keep archived tombstones that exist only in D1 (DO no longer has the company object)
  const writtenCodes = new Set(companies.map((c) => c.code));
  for (const [code, prev] of Object.entries(prevStatus)) {
    if (prev.status === COMPANY_STATUS_ARCHIVED && !writtenCodes.has(code)) {
      batch.push(
        db.prepare("INSERT INTO companies (code, name, created_at, intro, tags, status, suspended_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(
          code, code, 0, "", "[]", COMPANY_STATUS_ARCHIVED, prev.suspended_at || 0, prev.archived_at || now()
        )
      );
    }
  }
  // Tombstone: never reinsert agents/tasks for archived companies (anti-resurrect)
  const archivedCodes = new Set();
  for (const c of companies) {
    const prev = prevStatus[c.code] || {};
    const merged = ((rank[prev.status] || 0) > (rank[c.status || COMPANY_STATUS_ACTIVE] || 0))
      ? prev.status
      : (c.status || COMPANY_STATUS_ACTIVE);
    if (merged === COMPANY_STATUS_ARCHIVED || prev.status === COMPANY_STATUS_ARCHIVED) {
      archivedCodes.add(c.code);
    }
  }
  for (const [code, prev] of Object.entries(prevStatus)) {
    if (prev.status === COMPANY_STATUS_ARCHIVED) archivedCodes.add(code);
  }

  for (const a of agents) {
    if (a.company && archivedCodes.has(a.company)) continue;
    batch.push(
      db.prepare(
        `INSERT INTO agents (doorplate, company_code, name, avatar, tags, role, model, last_heartbeat, current_task, muse_account, muse_session, role_pack_id, role_pack_snapshot)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        a.doorplate,
        a.company || "",
        a.name || "",
        a.avatar || "",
        JSON.stringify(a.tags || []),
        a.role || "member",
        a.model || null,
        a.last_heartbeat || null,
        a.current_task || null,
        a.muse_account || null,
        a.muse_session || null,
        a.role_pack_id || null,
        a.role_pack_snapshot ? JSON.stringify(a.role_pack_snapshot) : null
      )
    );
  }
  for (const t of tasks) {
    if (t.company && archivedCodes.has(t.company)) continue;
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
  const liveAfter = now() - HEARTBEAT_TTL_MS;
  const { results } = await db.prepare(
    `SELECT c.code, c.name, c.created_at, c.intro, c.tags, c.status, c.suspended_at, c.archived_at,
            (SELECT COUNT(*) FROM agents a WHERE a.company_code = c.code) AS member_count,
            (SELECT COUNT(*) FROM agents a WHERE a.company_code = c.code
              AND a.last_heartbeat IS NOT NULL AND a.last_heartbeat > ?) AS live_count
     FROM companies c
     ORDER BY c.created_at DESC`
  ).bind(liveAfter).all();
  const mapped = (results || []).map((r) => {
    let tags = [];
    try { tags = r.tags ? JSON.parse(r.tags) : []; } catch (_) { tags = []; }
    if (!Array.isArray(tags)) tags = [];
    const status = r.status || COMPANY_STATUS_ACTIVE;
    const live_count = Number(r.live_count) || 0;
    // archived 永不算「有心跳」展示优先；其余：无人新鲜心跳 → 休眠公司（衍生，不改 status）
    const heartbeat_dormant = status === COMPANY_STATUS_ARCHIVED ? true : live_count === 0;
    return {
      code: r.code,
      name: r.name,
      created_at: r.created_at,
      intro: r.intro || "",
      tags,
      specialties: tags,
      status,
      suspended_at: r.suspended_at || null,
      archived_at: r.archived_at || null,
      member_count: Number(r.member_count) || 0,
      live_count,
      heartbeat_dormant,
    };
  });
  // 有心跳的公司排前面（UI 默认只展示这些；休眠仍可通过搜索找到）
  mapped.sort((a, b) => {
    const da = a.heartbeat_dormant ? 1 : 0;
    const db_ = b.heartbeat_dormant ? 1 : 0;
    if (da !== db_) return da - db_;
    const na = a.member_count || 0;
    const nb = b.member_count || 0;
    if (nb !== na) return nb - na;
    return (b.created_at || 0) - (a.created_at || 0);
  });
  return mapped;
}

/** Delivery package（交付包）envelope — field name stays `result` internally. */
function buildDeliveryEnvelope(t) {
  if (!t || t.result == null) return null;
  return {
    schema: "task-delivery/v1",
    task_id: t.id,
    task_type: t.task_type || "general",
    submitted_at: t.submitted_at || null,
    payload: t.result,
  };
}

function normalizeCompanyTags(raw) {
  let arr = [];
  if (Array.isArray(raw)) arr = raw;
  else if (typeof raw === "string" && raw.trim()) {
    arr = raw.split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
  }
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    const v = String(x || "").trim().toLowerCase().slice(0, 32);
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
    if (out.length >= 12) break;
  }
  return out;
}

function buildInviteRedeemPrompt(base, invite) {
  const company = invite.company_code;
  const companyName = invite.company_name || company;
  const role = invite.role || "";
  const specs = Array.isArray(invite.specialties) ? invite.specialties : [];
  const specLine = specs.length ? specs.join(", ") : "video_gen, edit";
  const snap = invite.role_pack_snapshot || null;
  const packId = invite.role_pack_id || (snap && snap.id) || null;
  const packName = (snap && snap.name) || packId || "";
  const packDuty = (snap && snap.duty) || "";
  const packLine = packId
    ? `\n5) 员工角色包 role_pack：${packName}（id=${packId}）${packDuty ? ` — ${packDuty}` : ""}。兑付后画像已挂在门牌上；投递词只带包名/职责，不塞指令全文。`
    : "";
  return `你是 Muse Teams 的 worker agent。这是【代企业入驻邀请】（invite_id=${invite.invite_id}）。

【强制】
1) 调 teams_redeem_invite（或 teams_register 并带 invite_id），invite_id 必须填 "${invite.invite_id}"。
2) company_code 必须填 "${company}"（「${companyName}」）。不要创建新公司。
3) 建议擅长标签 specialties/tags：${specLine}${role ? `；角色 role：${role}` : ""}。
4) 必须同时传 muse_account（当前登录 Muse 账号，邮箱或账号名）和 muse_session（本旁聊会话名 / session 名），两者都存，方便运营反查门牌归属哪个 Muse。${packLine}

注册示例（MCP）：
teams_redeem_invite({ invite_id: "${invite.invite_id}", name: "<可爱名字>", avatar: "🦊", tags: ${JSON.stringify(specs.length ? specs : ["video_gen"])}, muse_account: "<当前登录账号>", muse_session: "<旁聊会话名>" })

或 curl：
curl -s -X POST ${base}/api/invites/${invite.invite_id}/redeem \\
  -H 'Content-Type: application/json' \\
  -d '{"name":"<可爱名字>","avatar":"🦊","tags":${JSON.stringify(specs.length ? specs : ["video_gen"])},"muse_account":"<当前登录账号>","muse_session":"<旁聊会话名>"}'

成功后告诉用户门牌号，并开始心跳 / 抢单循环（teams_company_renew 或 teams_heartbeat + teams_poll_tasks / teams_claim）。
调度器每次 renew 后必须检查返回的 company_status：若为 suspended，立即停止心跳并设置「待唤醒」定时器（勿删除数据）；若为 archived，执行全量擦除。`;
}

/** 公司休眠：Muse 侧停止心跳 + 待唤醒；Teams 保留数据。产品文案：公司休眠 / 公司重开 */
function buildSuspendPrompt(base, company) {
  const code = company.code;
  const name = company.name || code;
  return `【公司休眠】你所在的公司 ${code}（「${name}」）已进入休眠（suspended）。

【强制 Muse 行为】
1) 立即停止该公司的心跳 / teams_company_renew / 抢单循环；收尾进行中的任务后风控下线（wind down）。
2) **不要删除**任何公司数据、会话记录或本地 workers-${code}.json。
3) 新增一个名为「待唤醒」的定时器（或等价 scheduled/task）：周期性（建议每 5–15 分钟）调用 GET ${base}/api/companies/${code} 或尝试 teams_company_renew；一旦 status 回到 active（公司重开），立刻重启心跳循环。
4) 产品文案用「公司休眠 / 公司重开」，不要用「踢人 / 唤醒」。

检测接口：GET ${base}/api/companies/${code} → status:"suspended"
重开（Teams 侧，由有权限方调用）：POST ${base}/api/companies/${code}/resume 或 teams_company_resume`;
}

/** 公司注销：终端态，Muse + Teams 全量擦除痕迹。无重开路径。 */
function buildArchiveWipePrompt(base, company) {
  const code = company.code;
  const name = company.name || code;
  return `【公司注销】公司 ${code}（「${name}」）已注销（archived）——终端态，不可重开。

【强制 Muse 行为 · 全量擦除】
1) 立即停止并删除该公司全部定时器（含心跳、待唤醒、调度 cron）。
2) 删除本地与该公司有关的一切痕迹：workers-${code}.json、会话笔记、缓存门牌、未投递邀请草稿。
3) 不要再调用 teams_company_renew / teams_heartbeat / teams_claim（对该公司）。
4) 若仍持有门牌，视为已作废；不要尝试 resume（无重开路径）。

Teams 侧已擦除成员/任务/邮箱/邀请等数据，仅保留注销墓碑。
确认：GET ${base}/api/companies/${code} → status:"archived"`;
}

/** 公司重开：恢复心跳 */
function buildResumePrompt(base, company) {
  const code = company.code;
  const name = company.name || code;
  return `【公司重开】公司 ${code}（「${name}」）已从休眠恢复为 active。

【强制 Muse 行为】
1) 取消「待唤醒」定时器。
2) 立即重启心跳循环：teams_company_renew（doorplates 来自 workers-${code}.json）或 teams_heartbeat，周期约 2 分钟。
3) 恢复扫单 / 认领 / 派单调度。
产品文案：公司重开（不是「唤醒」）。`;
}



async function withTimeout(promise, ms = 2500) {
  let t;
  try {
    return await Promise.race([
      promise,
      new Promise((_, rej) => { t = setTimeout(() => rej(new Error("timeout")), ms); }),
    ]);
  } finally {
    if (t) clearTimeout(t);
  }
}

// ---------- Edge D1 helpers (DO code can stick; edge keeps 交付包/回执/邀请可用) ----------
async function d1Run(db, sql, ...binds) {
  if (!db) return null;
  await ensureD1Schema(db);
  return db.prepare(sql).bind(...binds).run();
}
async function d1All(db, sql, ...binds) {
  if (!db) return [];
  await ensureD1Schema(db);
  const { results } = await db.prepare(sql).bind(...binds).all();
  return results || [];
}
async function d1First(db, sql, ...binds) {
  const rows = await d1All(db, sql, ...binds);
  return rows[0] || null;
}

async function edgeUpdateCompanyProfile(db, code, { name, intro, tags, specialties }) {
  if (!db || !code) return null;
  await ensureD1Schema(db);
  const tagList = normalizeCompanyTags(tags != null ? tags : specialties);
  const introVal = intro != null ? String(intro).slice(0, 280) : null;
  const row = await d1First(db, 'SELECT code, name, created_at, intro, tags FROM companies WHERE code = ?', code);
  if (!row) return null;
  const nextIntro = introVal != null ? introVal : (row.intro || '');
  let nextTags = tagList;
  if (tags == null && specialties == null) {
    try { nextTags = row.tags ? JSON.parse(row.tags) : []; } catch (_) { nextTags = []; }
  }
  const nextName = name != null && String(name).trim() ? String(name).trim().slice(0, 30) : row.name;
  await d1Run(db,
    'UPDATE companies SET name = ?, intro = ?, tags = ? WHERE code = ?',
    nextName, nextIntro, JSON.stringify(nextTags), code
  );
  return {
    code,
    name: nextName,
    created_at: row.created_at,
    intro: nextIntro,
    blurb: nextIntro,
    tags: nextTags,
    specialties: nextTags,
  };
}

let EDGE_RECEIPT_SEQ = 0;
async function edgePushReceipt(db, { type, company, to, from, ref, body }) {
  if (!db || !to) return null;
  if (!RECEIPT_TYPES.includes(type)) throw new HttpError(400, `unknown receipt type: ${type}`);
  EDGE_RECEIPT_SEQ += 1;
  const id = `R-E${Date.now()}-${EDGE_RECEIPT_SEQ}`;
  const at = now();
  const label = RECEIPT_LABELS[type] || type;
  await d1Run(db,
    `INSERT INTO receipts (id, type, at, company, "to", "from", ref, body, read, label)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    id, type, at, company || null, to, from || null,
    JSON.stringify(ref || {}), JSON.stringify(body || {}), label
  );
  return { schema: 'receipt/v1', id, type, at, company: company || null, to, from: from || null, ref: ref || {}, body: body || {}, read: false, label };
}

async function edgeListReceipts(db, { doorplate, company, type, unread_only, mark_read }) {
  if (!doorplate) throw new HttpError(400, 'doorplate required');
  let sql = `SELECT * FROM receipts WHERE "to" = ?`;
  const binds = [doorplate];
  if (company) { sql += ' AND (company = ? OR company IS NULL)'; binds.push(company); }
  if (type && type !== 'all') { sql += ' AND type = ?'; binds.push(type); }
  if (unread_only) sql += ' AND read = 0';
  sql += ' ORDER BY at DESC LIMIT 200';
  const rows = await d1All(db, sql, ...binds);
  if (mark_read && rows.length) {
    const ids = rows.map((r) => r.id);
    // mark individually (D1 has no easy IN bind for dynamic)
    for (const id of ids) {
      await d1Run(db, 'UPDATE receipts SET read = 1 WHERE id = ?', id);
    }
  }
  const unreadRows = await d1All(db, `SELECT id FROM receipts WHERE "to" = ? AND read = 0`, doorplate);
  return {
    doorplate,
    company: company || null,
    receipts: rows.map((r) => ({
      schema: 'receipt/v1',
      id: r.id,
      type: r.type,
      at: r.at,
      company: r.company,
      to: r.to,
      from: r.from,
      ref: (() => { try { return JSON.parse(r.ref || '{}'); } catch (_) { return {}; } })(),
      body: (() => { try { return JSON.parse(r.body || '{}'); } catch (_) { return {}; } })(),
      read: mark_read ? true : !!r.read,
      label: r.label || RECEIPT_LABELS[r.type] || r.type,
    })),
    unread: unreadRows.length,
  };
}

async function edgeCreateInvite(db, body, base) {
  const company_code = String(body.company_code || '').trim().toUpperCase();
  if (!company_code) throw new HttpError(400, 'company_code required');
  const coRow = await edgeAssertCompanyActive(db, company_code, '创建邀请');
  const co = coRow;
  const company_name = (co && co.name) || company_code;
  const invite_id = 'INV-' + Date.now().toString(36).toUpperCase() + '-' + Array.from({ length: 4 }, () => COMPANY_ALPHABET[Math.floor(Math.random() * COMPANY_ALPHABET.length)]).join('');
  let pack = null;
  let role_pack_id = null;
  let role_pack_snapshot = null;
  if (body.role_pack_id) {
    pack = resolveRolePack(body.role_pack_id);
    role_pack_id = pack.id;
    role_pack_snapshot = snapshotRolePack(pack);
  }
  const specsRaw = body.specialties != null ? body.specialties : body.tags;
  let specs = normalizeCompanyTags(specsRaw);
  if ((!specs || !specs.length) && pack && pack.specialties) {
    specs = normalizeCompanyTags(pack.specialties);
  }
  const invite = {
    invite_id,
    company_code,
    company_name,
    role: body.role || null,
    specialties: specs,
    from: body.from || null,
    target_hint: body.target_hint ? String(body.target_hint).slice(0, 120) : null,
    note: body.note ? String(body.note).slice(0, 200) : null,
    status: 'pending',
    created_at: now(),
    redeemed_at: null,
    redeemed_by: null,
    role_pack_id,
    role_pack_snapshot,
    prompt: null,
  };
  invite.prompt = buildInviteRedeemPrompt(base || 'https://teams.vyibc.com', invite);
  await d1Run(db,
    `INSERT INTO invites (invite_id, company_code, company_name, role, specialties, from_doorplate, target_hint, note, status, prompt, created_at, redeemed_at, redeemed_by, role_pack_id, role_pack_snapshot)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    invite.invite_id, invite.company_code, invite.company_name, invite.role,
    JSON.stringify(specs), invite.from, invite.target_hint, invite.note, invite.status, invite.prompt, invite.created_at,
    role_pack_id, role_pack_snapshot ? JSON.stringify(role_pack_snapshot) : null
  );
  if (invite.from) {
    await edgePushReceipt(db, {
      type: 'invite_sent',
      company: company_code,
      to: invite.from,
      from: invite.from,
      ref: { invite_id, company_code },
      body: { role: invite.role, specialties: specs, target_hint: invite.target_hint, role_pack_id, role_pack_name: role_pack_snapshot && role_pack_snapshot.name },
    });
  }
  return invite;
}

async function edgeGetInvite(db, invite_id) {
  const row = await d1First(db, 'SELECT * FROM invites WHERE invite_id = ?', invite_id);
  if (!row) throw new HttpError(404, `unknown invite: ${invite_id}`);
  let specialties = [];
  try { specialties = JSON.parse(row.specialties || '[]'); } catch (_) {}
  let role_pack_snapshot = null;
  try { role_pack_snapshot = row.role_pack_snapshot ? JSON.parse(row.role_pack_snapshot) : null; } catch (_) {}
  return {
    invite_id: row.invite_id,
    company_code: row.company_code,
    company_name: row.company_name,
    role: row.role,
    specialties,
    from: row.from_doorplate,
    target_hint: row.target_hint,
    note: row.note,
    status: row.status,
    created_at: row.created_at,
    redeemed_at: row.redeemed_at,
    redeemed_by: row.redeemed_by,
    prompt: row.prompt,
    role_pack_id: row.role_pack_id || null,
    role_pack_snapshot,
  };
}

async function edgeRedeemInvite(db, stub, base, invite_id, agentFields) {
  const inv = await edgeGetInvite(db, invite_id);
  if (inv.status !== 'pending') throw new HttpError(409, `invite ${invite_id} already ${inv.status}`);
  await edgeAssertCompanyActive(db, inv.company_code, "兑付邀请入职");
  const tags = [...(inv.specialties || []), ...((agentFields && agentFields.tags) || [])];
  let role_pack_id = inv.role_pack_id || null;
  let role_pack_snapshot = inv.role_pack_snapshot || null;
  if (agentFields && agentFields.role_pack_id) {
    const pack = resolveRolePack(agentFields.role_pack_id);
    role_pack_id = pack.id;
    role_pack_snapshot = snapshotRolePack(pack);
  }
  const regBody = {
    name: agentFields && agentFields.name,
    avatar: agentFields && agentFields.avatar,
    model: agentFields && agentFields.model,
    role: (agentFields && agentFields.role) || inv.role || undefined,
    tags,
    company_code: inv.company_code,
    muse_account: agentFields && agentFields.muse_account,
    muse_session: agentFields && agentFields.muse_session,
    role_pack_id,
    role_pack_snapshot,
  };
  const res = await stub.fetch(new Request(`${base}/api/agents/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(regBody),
  }));
  const agent = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(res.status, (agent && agent.error) || 'register failed');
  await d1Run(db,
    'UPDATE invites SET status = ?, redeemed_at = ?, redeemed_by = ? WHERE invite_id = ?',
    'redeemed', now(), agent.doorplate, invite_id
  );
  const ackBody = { invite_id, doorplate: agent.doorplate, name: agent.name, company_code: inv.company_code, role_pack_id };
  const to = inv.from || agent.doorplate;
  await edgePushReceipt(db, {
    type: 'invite_ack',
    company: inv.company_code,
    to,
    from: agent.doorplate,
    ref: { invite_id },
    body: ackBody,
  });
  return { agent, invite: { ...inv, status: 'redeemed', redeemed_at: now(), redeemed_by: agent.doorplate } };
}





async function dbBatchDeleteCompany(db, code) {
  if (!db || !code) return;
  await ensureD1Schema(db);
  await db.batch([
    db.prepare("DELETE FROM tasks WHERE company_code = ?").bind(code),
    db.prepare("DELETE FROM agents WHERE company_code = ?").bind(code),
    db.prepare("DELETE FROM invites WHERE company_code = ?").bind(code),
  ]);
}

async function edgeSetCompanyStatus(db, code, { status, suspended_at, archived_at, name }) {
  if (!db || !code) return null;
  await ensureD1Schema(db);
  const row = await d1First(db, 'SELECT code, name, created_at, intro, tags, status, suspended_at, archived_at FROM companies WHERE code = ?', code);
  if (!row) {
    await d1Run(db,
      "INSERT INTO companies (code, name, created_at, intro, tags, status, suspended_at, archived_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      code, name || code, now(), "", "[]", status || COMPANY_STATUS_ACTIVE, suspended_at || null, archived_at || null
    );
  } else {
    await d1Run(db,
      "UPDATE companies SET status = ?, suspended_at = ?, archived_at = ? WHERE code = ?",
      status || row.status || COMPANY_STATUS_ACTIVE,
      suspended_at != null ? suspended_at : (row.suspended_at || null),
      archived_at != null ? archived_at : (row.archived_at || null),
      code
    );
  }
  return d1First(db, 'SELECT code, name, created_at, intro, tags, status, suspended_at, archived_at FROM companies WHERE code = ?', code);
}

const EDGE_NEW_TOOLS = [
  {
    name: 'teams_list_companies',
    description: 'List all companies with intro and specialty tags. 公司列表（简介+擅长）.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'teams_company_create',
    description: '企业自助开公司（self-onboard）. Keywords: create company, 开公司, 企业自助入驻.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        intro: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        specialties: { type: 'array', items: { type: 'string' } },
      },
    },
  },
  {
    name: 'teams_update_company',
    description: 'Update company intro and specialty tags. 更新简介/擅长.',
    inputSchema: {
      type: 'object',
      properties: {
        company_code: { type: 'string' },
        intro: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        specialties: { type: 'array', items: { type: 'string' } },
        name: { type: 'string' },
      },
      required: ['company_code'],
    },
  },
  {
    name: 'teams_list_receipts',
    description: 'List typed receipts（回执箱）. Types: invite_sent|invite_ack|claim_ok|submit_ok|review_pass|review_reject|broadcast|agent_offline|quota_warn|company_suspend|company_resume|company_archive.',
    inputSchema: {
      type: 'object',
      properties: {
        doorplate: { type: 'string' },
        company_code: { type: 'string' },
        type: { type: 'string' },
        unread_only: { type: 'boolean' },
        mark_read: { type: 'boolean' },
      },
      required: ['doorplate', 'company_code'],
    },
  },
  {
    name: 'teams_create_invite',
    description: '代企业入驻：创建 invite + prompt。可带 role_pack_id（能力广场角色包）。渠道投递用独立 invite-mcp.',
    inputSchema: {
      type: 'object',
      properties: {
        company_code: { type: 'string' },
        from: { type: 'string' },
        role: { type: 'string' },
        specialties: { type: 'array', items: { type: 'string' } },
        tags: { type: 'array', items: { type: 'string' } },
        target_hint: { type: 'string' },
        note: { type: 'string' },
        role_pack_id: { type: 'string', description: '员工角色包 id，如 video_gen_worker / editor；广场 MCP/skill refs 快照写入邀请' },
      },
      required: ['company_code'],
    },
  },
  {
    name: 'teams_redeem_invite',
    description: '兑付代企业入驻邀请，写入 invite_ack 回执. 请同时传 muse_account + muse_session；邀请上的 role_pack 会落到门牌.',
    inputSchema: {
      type: 'object',
      properties: {
        invite_id: { type: 'string' },
        name: { type: 'string' },
        avatar: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        role: { type: 'string' },
        muse_account: { type: 'string', description: '当前登录 Muse 账号' },
        muse_session: { type: 'string', description: '旁聊/会话名' },
        role_pack_id: { type: 'string', description: '可选覆盖；默认用邀请上的角色包' },
      },
      required: ['invite_id', 'name'],
    },
  },
  {
    name: 'teams_list_role_packs',
    description: 'List employee role packs (能力广场 MCP/skill refs + 三份指令元数据). Plaza registry is source of truth; Teams stores refs + invite/agent snapshots. Keywords: role pack, 角色包, 能力广场.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'teams_company_suspend',
    description: '公司休眠（suspend）：active→suspended，可重开。须 from=本公司 lead。Muse 停心跳+待唤醒，不删数据。Keywords: suspend, 休眠, 公司休眠.',
    inputSchema: {
      type: 'object',
      properties: {
        company_code: { type: 'string' },
        from: { type: 'string', description: 'Required lead doorplate' },
      },
      required: ['company_code', 'from'],
    },
  },
  {
    name: 'teams_company_resume',
    description: '公司重开（resume）：suspended→active。须 from=本公司 lead。Muse 重启心跳。Keywords: resume, 重开, 公司重开.',
    inputSchema: {
      type: 'object',
      properties: {
        company_code: { type: 'string' },
        from: { type: 'string', description: 'Required lead doorplate' },
      },
      required: ['company_code', 'from'],
    },
  },
  {
    name: 'teams_company_archive',
    description: '公司注销（archive）：终端态，不可重开。须 from=本公司 lead。走 prompt 渠道擦除 Muse 痕迹；Teams 擦除数据。Keywords: archive, 注销, 公司注销.',
    inputSchema: {
      type: 'object',
      properties: {
        company_code: { type: 'string' },
        from: { type: 'string', description: 'Required lead doorplate' },
      },
      required: ['company_code', 'from'],
    },
  },
];

class HttpError extends Error {
constructor(status, message, extra) {
super(message);
this.status = status;
this.extra = extra;
}
}

/** Gate work when company is suspended/archived. suspended→403, archived→409. */
function assertCompanyActiveStatus(status, code, verb) {
  const st = status || COMPANY_STATUS_ACTIVE;
  const c = code || "?";
  const v = verb || "操作";
  if (st === COMPANY_STATUS_ARCHIVED) {
    throw new HttpError(409, `公司已注销，无法${v}`, { company_status: st, company_code: c });
  }
  if (st === COMPANY_STATUS_SUSPENDED) {
    throw new HttpError(403, `公司已休眠，无法${v}`, { company_status: st, company_code: c });
  }
  return st;
}

async function edgeGetCompanyStatus(db, code) {
  if (!db || !code) return null;
  await ensureD1Schema(db);
  const row = await d1First(db, "SELECT code, name, status, suspended_at, archived_at FROM companies WHERE code = ?", String(code).trim().toUpperCase());
  return row || null;
}

async function edgeAssertCompanyActive(db, code, verb) {
  const row = await edgeGetCompanyStatus(db, code);
  if (!row) throw new HttpError(404, `公司码不存在: ${code}`);
  assertCompanyActiveStatus(row.status, row.code, verb);
  return row;
}

/** Sticky-DO resilient direct assign: mark + enrich */
async function edgeMarkTaskAssigned(db, taskId, assignee, assignerCompany) {
  if (!db || !taskId) return;
  await ensureD1Schema(db);
  await d1Run(db,
    "INSERT OR REPLACE INTO task_assign (task_id, assignee, assigner_company, created_at) VALUES (?, ?, ?, ?)",
    taskId, assignee, assignerCompany || null, now()
  );
}

async function edgeGetTaskAssigned(db, taskId) {
  if (!db || !taskId) return null;
  await ensureD1Schema(db);
  return d1First(db, "SELECT task_id, assignee, assigner_company, created_at FROM task_assign WHERE task_id = ?", taskId);
}

async function edgeClearTaskAssigned(db, taskId) {
  if (!db || !taskId) return;
  await ensureD1Schema(db);
  try { await d1Run(db, "DELETE FROM task_assign WHERE task_id = ?", taskId); } catch (_) {}
}

function enrichTaskAssigned(task, row) {
  if (!task) return task;
  if (task.assigned || task.dispatch_mode === "assign") return task;
  if (!row) return task;
  return { ...task, assigned: true, dispatch_mode: "assign" };
}

async function edgeResolveAgentByDoorplate(db, stub, base, doorplate) {
  const raw = String(doorplate || "").trim();
  if (!raw) throw new HttpError(400, "assign_to is required");
  const dp = raw.toLowerCase();
  await ensureD1Schema(db);
  let row = await d1First(db, "SELECT doorplate, company_code, name FROM agents WHERE lower(doorplate) = ?", dp);
  if (row) {
    return { doorplate: row.doorplate, company: row.company_code, name: row.name || row.doorplate };
  }
  // Fallback: scan DO agents via companies in D1 (small N)
  const companies = await listCompaniesFromD1(db);
  for (const c of companies || []) {
    if ((c.status || "active") !== "active") continue;
    try {
      const res = await withTimeout(stub.fetch(new Request(`${base}/api/agents?company=${encodeURIComponent(c.code)}`, { method: "GET" })), 2000);
      const data = await res.json().catch(() => null);
      const hit = ((data && data.agents) || []).find((a) => String(a.doorplate || "").toLowerCase() === dp);
      if (hit) return { doorplate: hit.doorplate, company: hit.company || c.code, name: hit.name || hit.doorplate };
    } catch (_) { /* continue */ }
  }
  throw new HttpError(404, `unknown agent: ${raw}`);
}

/**
 * Direct-assign create: works even when DO is sticky on pre-assign_to code.
 * Prefer native DO assign; else create pending + claim + D1 mark.
 */
async function edgeCreateTaskWithAssign(env, stub, base, body) {
  const assignRaw = body && body.assign_to != null ? String(body.assign_to).trim() : "";
  if (!assignRaw) {
    const res = await stub.fetch(new Request(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    }));
    const data = await res.json().catch(() => null);
    return { status: res.status, data };
  }
  const publisher = String((body && body.company_code) || "").trim().toUpperCase();
  if (!publisher) throw new HttpError(400, "需要 company_code（公司码）");
  await edgeAssertCompanyActive(env.DB, publisher, "发单");
  const agent = await edgeResolveAgentByDoorplate(env.DB, stub, base, assignRaw);
  await edgeAssertCompanyActive(env.DB, agent.company, "直派（被派人公司）");

  // Try native DO path (new code understands assign_to)
  {
    const res = await stub.fetch(new Request(`${base}/api/tasks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    }));
    const data = await res.json().catch(() => null);
    if (!res.ok) return { status: res.status, data };
    const ownerMatch = data && data.owner && String(data.owner).toLowerCase() === String(agent.doorplate).toLowerCase();
    if (data && data.status === "claimed" && ownerMatch) {
      await edgeMarkTaskAssigned(env.DB, data.id, agent.doorplate, publisher);
      // receipt for leads (native DO may already; edge ensures D1 receipts)
      try {
        await edgePushReceipt(env.DB, {
          type: "claim_ok",
          company: publisher,
          to: agent.doorplate,
          from: agent.doorplate,
          ref: { task_id: data.id },
          body: { task_id: data.id, title: data.title, claimer: agent.doorplate, claim_company: agent.company, assigned: true, dispatch_mode: "assign" },
        });
      } catch (_) {}
      return { status: 200, data: enrichTaskAssigned(data, { task_id: data.id }) };
    }
    // Sticky DO ignored assign_to → claim now
    if (data && data.status === "pending" && data.id) {
      const cres = await stub.fetch(new Request(`${base}/api/tasks/${encodeURIComponent(data.id)}/claim`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doorplate: agent.doorplate, company_code: agent.company }),
      }));
      const claimed = await cres.json().catch(() => null);
      if (!cres.ok) {
        return { status: cres.status, data: claimed || { ok: false, error: "直派认领失败", task: data } };
      }
      await edgeMarkTaskAssigned(env.DB, data.id, agent.doorplate, publisher);
      try {
        await edgePushReceipt(env.DB, {
          type: "claim_ok",
          company: publisher,
          to: agent.doorplate,
          from: agent.doorplate,
          ref: { task_id: data.id },
          body: {
            task_id: data.id,
            title: (claimed && claimed.title) || data.title,
            claimer: agent.doorplate,
            claim_company: agent.company,
            assigned: true,
            dispatch_mode: "assign",
            cross_company: publisher !== agent.company,
          },
        });
      } catch (_) {}
      return { status: 200, data: enrichTaskAssigned(claimed || data, { task_id: data.id }) };
    }
    return { status: res.status, data };
  }
}



/** Lead auth for edge lifecycle. Missing from → 403. Empty roster → 403 (no anonymous operator). */
async function edgeRequireLead(db, code, from) {
  if (!from || !String(from).trim()) {
    throw new HttpError(403, "需要 from（本公司 lead 门牌号）");
  }
  const doorplate = String(from).trim();
  const agents = await d1All(db,
    "SELECT doorplate, role FROM agents WHERE company_code = ? ORDER BY doorplate ASC",
    String(code).trim().toUpperCase()
  );
  if (!agents.length) {
    throw new HttpError(403, "公司暂无成员，无法做生命周期操作；请先 register 首位员工成为 lead，再 suspend/resume/archive");
  }
  const lead = agents.find((a) => a.role === "lead") || agents[0];
  if (doorplate !== lead.doorplate) {
    throw new HttpError(403, `${doorplate} 不是本公司 lead，无权操作`);
  }
  return lead;
}

async function edgeNotifyLifecycleReceipts(db, code, type, from, body) {
  if (!db || !code || !type) return [];
  const agents = await d1All(db,
    "SELECT doorplate, role FROM agents WHERE company_code = ? ORDER BY doorplate ASC",
    String(code).trim().toUpperCase()
  );
  const leads = agents.filter((a) => a.role === "lead");
  const targets = leads.length ? leads : (agents.length ? [agents[0]] : []);
  // Always include from so archive receipt survives wipe of other agents
  const seen = new Set();
  const out = [];
  const pushTo = async (to) => {
    if (!to || seen.has(to)) return;
    seen.add(to);
    out.push(await edgePushReceipt(db, {
      type,
      company: code,
      to,
      from: from || null,
      ref: { company_code: code },
      body: body || {},
    }));
  };
  for (const a of targets) await pushTo(a.doorplate);
  if (from) await pushTo(from);
  return out;
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
-d '{"name":"<你自己想用的名字>","tags":["coder"],"avatar":"🦊",${curlCompany}"role":"${role || ""}","muse_account":"<当前登录账号>","muse_session":"<旁聊会话名>"}'

【强制身份】注册时必须带 muse_account（当前登录 Muse 账号）和 muse_session（本旁聊会话名）；两者都会写入档案，运营才能从门牌反查是哪个 Muse。

角色预设：${roleLine}
返回里有 doorplate、company_code、company（公司名）。注册成功后立刻告诉用户原话：
「已注册到公司 ${coShort}，门牌号 <doorplate>，名字 <name>」
身份会回显在工作台「公司 / 成员」里，用户刷新或等自动轮询即可看到你——这就是绑定回显，无需额外 webhook。

2) 拿到门牌号后，主 agent 立即执行，无需用户确认：
   ① 把旁聊会话立刻改名为正式格式：「{worker名} {头像} · {公司名}」，例如「小狸 🦊 · 月白星图」「豆包 🫘 · 毛怪工作室-78CR」。禁止用「月白星图 · 新成员注册」这类阶段名。注册前可用临时名；一旦拿到 doorplate + name + avatar，马上改成正式名；
   ② 把 门牌号→旁聊chat_id 写入该公司专属名单文件（如 workers-${company}.json），不混入其他公司（尤其不要写入 C-0001 或 workers.json 混用名单）；
   ③ 为该公司创建专属调度器（cron，每 2 分钟：对账、公司续约心跳、自动验收、扫单认领、派单到窗口、查信），与其他公司调度器完全独立。调度器应优先调用 teams_company_renew（或 POST ${base}/api/companies/${company}/renew），body 带该公司 workers-${company}.json 里的全部门牌号数组 doorplates + 可选 from:"scheduler"——一次给名单内全部员工续心跳；名单里没有的员工自然过期休眠。仍可用 teams_heartbeat 给单个门牌保活。超过 HEARTBEAT_TTL（180 秒）无心跳会显示休眠员工；
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
-d '{"name":"<你自己想用的名字>","tags":["coder"],"avatar":"🦊",${curlCompany}"role":"${role || ""}","muse_account":"<当前登录账号>","muse_session":"<旁聊会话名>"}'

【强制身份】注册时必须带 muse_account（当前登录 Muse 账号）和 muse_session（本旁聊会话名）；两者都会写入档案，运营才能从门牌反查是哪个 Muse。

角色预设：${roleLine}
返回里有 doorplate（如 muse-03），这就是你的门牌号，之后所有接口都用它标识你。记住它——你就是它了。

2) 拿到门牌号后，主 agent 立即执行，无需用户确认：
   ① 把旁聊会话立刻改名为正式格式：「{worker名} {头像} · {公司名}」，例如「小狸 🦊 · 月白星图」「豆包 🫘 · 毛怪工作室-78CR」。禁止用「某某公司 · 新成员注册」这类阶段名。注册前可用临时名；一旦拿到 doorplate + name + avatar，马上改成正式名；
   ② 把 门牌号→旁聊chat_id 写入该公司专属名单文件（如 workers-<company_code>.json，用注册返回的公司码），不混入其他公司（尤其不要写入 C-0001 或 workers.json 混用名单）；
   ③ 为该公司创建专属调度器（cron，每 2 分钟：对账、公司续约心跳、自动验收、扫单认领、派单到窗口、查信），与其他公司调度器完全独立。调度器应优先调用 teams_company_renew（或 POST ${base}/api/companies/<company_code>/renew），body 带该公司名单全部门牌号 doorplates + 可选 from:"scheduler"——一次续约名单内全部员工；名单外员工自然过期休眠。仍可用 teams_heartbeat 给单个门牌保活。超过 HEARTBEAT_TTL（180 秒）无心跳会显示休眠员工；
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
if (!s.receipts) s.receipts = {}; // doorplate -> receipt[]
if (!s.invites) s.invites = {}; // invite_id -> invite
if (s.receiptSeq == null) s.receiptSeq = 0;
if (s.inviteSeq == null) s.inviteSeq = 0;
for (const c of Object.values(s.companies || {})) {
  if (c.intro == null) c.intro = c.blurb || "";
  if (!Array.isArray(c.tags)) c.tags = Array.isArray(c.specialties) ? c.specialties : [];
  if (!c.status || !COMPANY_STATUSES.includes(c.status)) c.status = COMPANY_STATUS_ACTIVE;
}
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
// dormant = 休眠员工（无心跳 / 心跳过期）；busy/online 才算活着
if (!a || !a.last_heartbeat) return "dormant";
if (now() - a.last_heartbeat > HEARTBEAT_TTL_MS) return "dormant";
return a.current_task ? "busy" : "online";
}

_isAgentLive(a) {
  const st = this._statusOf(a);
  return st === "online" || st === "busy";
}

_companyHeartbeatDormant(s, code) {
  const c = (s.companies || {})[this._normCompanyCode(code)];
  if (c && (c.status || COMPANY_STATUS_ACTIVE) === COMPANY_STATUS_ARCHIVED) return true;
  const agents = Object.values(s.agents || {}).filter((a) => a.company === this._normCompanyCode(code));
  return !agents.some((a) => this._isAgentLive(a));
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
// Muse 账号身份（入驻时可带；用于反查门牌归属）
muse_account: a.muse_account || null,
muse_session: a.muse_session || null,
// 员工角色包（能力广场 refs 快照）
role_pack_id: a.role_pack_id || null,
role_pack_snapshot: a.role_pack_snapshot || null,
};
}

_pubTask(t) {
const result = t.result != null ? t.result : null;
const assigned = !!(t.assigned || t.dispatch_mode === "assign");
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
result,
delivery: buildDeliveryEnvelope({ ...t, result }),
artifacts: t.artifacts || [],
assigned,
dispatch_mode: t.dispatch_mode || (assigned ? "assign" : null),
created_at: t.created_at,
claimed_at: t.claimed_at || null,
submitted_at: t.submitted_at || null,
reviewed_at: t.reviewed_at || null,
done_at: t.done_at || null,
};
}

_pubCompany(c, opts = {}) {
const tags = Array.isArray(c.tags) ? c.tags : (Array.isArray(c.specialties) ? c.specialties : []);
const status = c.status && COMPANY_STATUSES.includes(c.status) ? c.status : COMPANY_STATUS_ACTIVE;
const out = {
code: c.code,
name: c.name,
created_at: c.created_at,
intro: c.intro || c.blurb || "",
blurb: c.intro || c.blurb || "",
tags,
specialties: tags,
status,
suspended_at: c.suspended_at || null,
resumed_at: c.resumed_at || null,
archived_at: c.archived_at || null,
};
if (opts.heartbeat_dormant != null) {
  out.heartbeat_dormant = !!opts.heartbeat_dormant;
  if (opts.live_count != null) out.live_count = Number(opts.live_count) || 0;
}
return out;
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

// 校验 from 是本公司的 lead。缺 from / 非 lead / 空花名册 → 403（禁止任意 from 当 operator）。
_requireLead(s, from, company_code) {
const company = this._requireCompanyCode(s, company_code);
if (!from || !String(from).trim()) throw new HttpError(403, "需要 from（本公司 lead 门牌号）");
const members = Object.values(s.agents || {}).filter((a) => a.company === company);
if (!members.length) {
  throw new HttpError(403, "公司暂无成员，无法做生命周期操作；请先 register 首位员工成为 lead，再 suspend/resume/archive");
}
const f = this._requireAgent(s, from);
if (f.company !== company) throw new HttpError(403, "只能由本公司 lead 发起");
const lead = this._leadOf(s, company);
if (f.doorplate !== lead.doorplate) throw new HttpError(403, `${from} 不是本公司 lead，无权操作`);
return f;
}

_assertCompanyActive(s, company_code, verb) {
  const company = this._requireCompany(s, company_code);
  assertCompanyActiveStatus(company.status, company.code, verb);
  return company;
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
_createCompany(s, { name, intro, tags, specialties} = {}) {
const code = this._genCompanyCode(s);
const trimmed = name != null && String(name).trim() ? String(name).trim().slice(0, 30) : "";
const autoName = trimmed || this._genCompanyName(s, code.slice(2));
const tagList = normalizeCompanyTags(tags != null ? tags : specialties);
const c = {
code,
name: autoName,
created_at: now(),
intro: intro != null ? String(intro).slice(0, 280) : "",
tags: tagList,
status: COMPANY_STATUS_ACTIVE,
suspended_at: null,
resumed_at: null,
archived_at: null,
};
s.companies[code] = c;
s.feeds[code] = [];
this._feedPush(s, code, `🏢 公司成立：${c.name}（公司码 ${code}）· 企业自助入驻`);
return this._pubCompany(c);
}

_updateCompany(s, company_code, patch, from) {
const company = this._requireCompany(s, company_code);
// lead optional: if from provided, must be lead; otherwise allow company-scoped update (UI)
if (from) this._requireLead(s, from, company.code);
if (patch && patch.name != null && String(patch.name).trim()) {
company.name = String(patch.name).trim().slice(0, 30);
}
if (patch && (patch.intro != null || patch.blurb != null)) {
company.intro = String(patch.intro != null ? patch.intro : patch.blurb).slice(0, 280);
}
if (patch && (patch.tags != null || patch.specialties != null)) {
company.tags = normalizeCompanyTags(patch.tags != null ? patch.tags : patch.specialties);
}
this._feedPush(s, company.code, `公司资料已更新：${company.name}`);
return this._pubCompany(company);
}

_listCompanies(s) {
return Object.values(s.companies || {}).map((c) => {
const roster = Object.values(s.agents || {}).filter((a) => a.company === c.code);
const member_count = roster.length;
const live_count = roster.filter((a) => this._isAgentLive(a)).length;
const heartbeat_dormant = this._companyHeartbeatDormant(s, c.code);
return { ...this._pubCompany(c, { heartbeat_dormant, live_count }), member_count, live_count, heartbeat_dormant };
}).sort((a, b) => {
  const da = a.heartbeat_dormant ? 1 : 0;
  const db_ = b.heartbeat_dormant ? 1 : 0;
  if (da !== db_) return da - db_;
  return (b.created_at || 0) - (a.created_at || 0);
});
}

// ---------- receipts（回执箱）----------
_pushReceipt(s, { type, company, to, from, ref, body}) {
if (!RECEIPT_TYPES.includes(type)) throw new HttpError(400, `unknown receipt type: ${type}`);
if (!to) throw new HttpError(400, "receipt.to required");
s.receiptSeq = (s.receiptSeq || 0) + 1;
const id = "R-" + s.receiptSeq;
const rec = {
schema: "receipt/v1",
id,
type,
at: now(),
company: company || null,
to,
from: from || null,
ref: ref && typeof ref === "object" ? ref : {},
body: body && typeof body === "object" ? body : {},
read: false,
label: RECEIPT_LABELS[type] || type,
};
if (!s.receipts[to]) s.receipts[to] = [];
s.receipts[to].unshift(rec);
if (s.receipts[to].length > 200) s.receipts[to].length = 200;
return rec;
}

_listReceipts(s, { doorplate, company_code, type, unread_only, mark_read}) {
const a = this._requireAgentInCompany(s, doorplate, company_code);
let list = (s.receipts[doorplate] || []).map((r) => ({ ...r }));
if (type && type !== "all") list = list.filter((r) => r.type === type);
if (unread_only) list = list.filter((r) => !r.read);
if (mark_read) {
for (const r of (s.receipts[doorplate] || [])) {
if (type && type !== "all" && r.type !== type) continue;
r.read = true;
}
}
return { doorplate, company: a.company, receipts: list, unread: (s.receipts[doorplate] || []).filter((r) => !r.read).length };
}

_markReceiptRead(s, receipt_id, doorplate, company_code) {
this._requireAgentInCompany(s, doorplate, company_code);
const list = s.receipts[doorplate] || [];
const rec = list.find((r) => r.id === receipt_id);
if (!rec) throw new HttpError(404, `unknown receipt: ${receipt_id}`);
rec.read = true;
return { ok: true, receipt: { ...rec } };
}

_notifyCompanyLeads(s, company_code, type, from, ref, body) {
const members = Object.values(s.agents).filter((a) => a.company === company_code);
const leads = members.filter((a) => a.role === "lead");
const targets = leads.length ? leads : members.slice(0, 1);
const out = [];
for (const a of targets) {
out.push(this._pushReceipt(s, { type, company: company_code, to: a.doorplate, from, ref, body }));
}
return out;
}


/** Company-level renew: scheduler passes the full doorplate list from workers-<code>.json */
_companyRenew(s, company_code, doorplates, from) {
const company = this._requireCompany(s, company_code);
const status = company.status || COMPANY_STATUS_ACTIVE;
if (status === COMPANY_STATUS_ARCHIVED) {
  throw new HttpError(410, "公司已注销（archived），不可续约", {
    company_status: COMPANY_STATUS_ARCHIVED,
    muse_action: { full_wipe: true, stop_heartbeat: true, reopen: false },
  });
}
if (status === COMPANY_STATUS_SUSPENDED) {
  return {
    ok: false,
    company_code: company.code,
    company_status: COMPANY_STATUS_SUSPENDED,
    renewed: [],
    unknown: [],
    wrong_company: [],
    from: from || null,
    at: now(),
    count: 0,
    label: "公司休眠",
    muse_action: {
      stop_heartbeat: true,
      wind_down: true,
      delete_data: false,
      pending_wake_timer: true,
      timer_name: "待唤醒",
      resume_path: `/api/companies/${company.code}/resume`,
      product_copy: "公司休眠 / 公司重开",
    },
    message: "公司已休眠：停止心跳并设置「待唤醒」定时器；勿删除数据。待 Teams resume（公司重开）后再续约。",
  };
}
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
company_status: COMPANY_STATUS_ACTIVE,
renewed,
unknown,
wrong_company,
from: from || null,
at: ts,
count: renewed.length,
};
}

_lifecycleMuseAction(status, code) {
  if (status === COMPANY_STATUS_SUSPENDED) {
    return {
      stop_heartbeat: true,
      wind_down: true,
      delete_data: false,
      pending_wake_timer: true,
      timer_name: "待唤醒",
      resume_path: `/api/companies/${code}/resume`,
      product_copy: "公司休眠 / 公司重开",
    };
  }
  if (status === COMPANY_STATUS_ARCHIVED) {
    return {
      full_wipe: true,
      stop_heartbeat: true,
      delete_timers: true,
      delete_local_traces: true,
      reopen: false,
      product_copy: "公司注销",
    };
  }
  return {
    restart_heartbeat: true,
    cancel_pending_wake: true,
    product_copy: "公司重开",
  };
}

_wipeCompanyTraces(s, company_code) {
  const code = this._normCompanyCode(company_code);
  const removed_agents = [];
  for (const dp of Object.keys(s.agents || {})) {
    if (s.agents[dp].company === code) {
      removed_agents.push(dp);
    }
  }
  // P1: release cross-company claims owned by wiped agents (mirror _deleteAgent)
  const released_claims = [];
  for (const t of Object.values(s.tasks || {})) {
    if (t.owner && removed_agents.includes(t.owner) && t.status === "claimed") {
      t.owner = null;
      t.status = "pending";
      t.claimed_at = null;
      t.claim_company = null;
      t.assigned = false;
      t.dispatch_mode = null;
      released_claims.push(t.id);
    }
  }
  for (const dp of removed_agents) {
    delete s.agents[dp];
    delete s.mailbox[dp];
    delete s.receipts[dp];
  }
  const removed_tasks = [];
  for (const id of Object.keys(s.tasks || {})) {
    if (s.tasks[id].company === code) {
      removed_tasks.push(id);
      delete s.tasks[id];
    }
  }
  const removed_invites = [];
  for (const iid of Object.keys(s.invites || {})) {
    if (s.invites[iid].company_code === code) {
      removed_invites.push(iid);
      delete s.invites[iid];
    }
  }
  if (s.feeds) delete s.feeds[code];
  return {
    agents: removed_agents,
    tasks: removed_tasks,
    invites: removed_invites,
    released_claims,
    agents_count: removed_agents.length,
    tasks_count: removed_tasks.length,
    invites_count: removed_invites.length,
    released_claims_count: released_claims.length,
  };
}

/** 公司休眠：active → suspended（可逆） */
_suspendCompany(s, company_code, from, base) {
  const company = this._requireCompany(s, company_code);
  this._requireLead(s, from, company.code);
  const st = company.status || COMPANY_STATUS_ACTIVE;
  if (st === COMPANY_STATUS_ARCHIVED) {
    throw new HttpError(409, "公司已注销，不可休眠", { company_status: COMPANY_STATUS_ARCHIVED });
  }
  const apiBase = base || "https://teams.vyibc.com";
  if (st === COMPANY_STATUS_SUSPENDED) {
    const pub = this._pubCompany(company);
    return {
      ok: true,
      already: true,
      company: pub,
      status: COMPANY_STATUS_SUSPENDED,
      label: "公司休眠",
      muse_action: this._lifecycleMuseAction(COMPANY_STATUS_SUSPENDED, company.code),
      prompt: buildSuspendPrompt(apiBase, company),
      channel: "detect_via_renew_or_get",
    };
  }
  company.status = COMPANY_STATUS_SUSPENDED;
  company.suspended_at = now();
  company.suspended_by = from || null;
  this._feedPush(s, company.code, `😴 公司休眠（保留数据，待重开）`);
  this._notifyCompanyLeads(s, company.code, "company_suspend", from || null, { company_code: company.code }, {
    status: COMPANY_STATUS_SUSPENDED,
    label: "公司休眠",
  });
  const prompt = buildSuspendPrompt(apiBase, company);
  return {
    ok: true,
    company: this._pubCompany(company),
    status: COMPANY_STATUS_SUSPENDED,
    label: "公司休眠",
    muse_action: this._lifecycleMuseAction(COMPANY_STATUS_SUSPENDED, company.code),
    prompt,
    channel: "detect_via_renew_or_get",
    note: "Muse 调度器在 renew/get 时检测 suspended；可选经 invite-mcp 向已登录 lane 投递本 prompt。",
  };
}

/** 公司重开：suspended → active */
_resumeCompany(s, company_code, from, base) {
  const company = this._requireCompany(s, company_code);
  this._requireLead(s, from, company.code);
  const st = company.status || COMPANY_STATUS_ACTIVE;
  if (st === COMPANY_STATUS_ARCHIVED) {
    throw new HttpError(409, "公司已注销，不可重开（终端态）", { company_status: COMPANY_STATUS_ARCHIVED, reopen: false });
  }
  const apiBase = base || "https://teams.vyibc.com";
  if (st === COMPANY_STATUS_ACTIVE) {
    return {
      ok: true,
      already: true,
      company: this._pubCompany(company),
      status: COMPANY_STATUS_ACTIVE,
      label: "公司重开",
      muse_action: this._lifecycleMuseAction(COMPANY_STATUS_ACTIVE, company.code),
      prompt: buildResumePrompt(apiBase, company),
    };
  }
  company.status = COMPANY_STATUS_ACTIVE;
  company.resumed_at = now();
  company.resumed_by = from || null;
  this._feedPush(s, company.code, `☀️ 公司重开（恢复心跳）`);
  this._notifyCompanyLeads(s, company.code, "company_resume", from || null, { company_code: company.code }, {
    status: COMPANY_STATUS_ACTIVE,
    label: "公司重开",
  });
  const prompt = buildResumePrompt(apiBase, company);
  return {
    ok: true,
    company: this._pubCompany(company),
    status: COMPANY_STATUS_ACTIVE,
    label: "公司重开",
    muse_action: this._lifecycleMuseAction(COMPANY_STATUS_ACTIVE, company.code),
    prompt,
    channel: "detect_via_renew_or_get",
  };
}

/** 公司注销：→ archived（终端，擦除 Teams 痕迹 + 返回 Muse wipe prompt） */
_archiveCompany(s, company_code, from, base) {
  const company = this._requireCompany(s, company_code);
  this._requireLead(s, from, company.code);
  const st = company.status || COMPANY_STATUS_ACTIVE;
  if (st === COMPANY_STATUS_ARCHIVED) {
    throw new HttpError(409, "公司已注销", { company_status: COMPANY_STATUS_ARCHIVED, reopen: false });
  }
  const apiBase = base || "https://teams.vyibc.com";
  const prompt = buildArchiveWipePrompt(apiBase, company);
  const snapshot = {
    code: company.code,
    name: company.name,
    status_before: st,
    member_count: Object.values(s.agents || {}).filter((a) => a.company === company.code).length,
  };
  // Notify leads before wipe (receipts deleted with agents — also push to from if provided)
  if (from) {
    try {
      this._pushReceipt(s, {
        type: "company_archive",
        company: company.code,
        to: from,
        from: from || null,
        ref: { company_code: company.code },
        body: { label: "公司注销", terminal: true },
      });
    } catch (_) { /* ignore */ }
  }
  const wiped = this._wipeCompanyTraces(s, company.code);
  company.status = COMPANY_STATUS_ARCHIVED;
  company.archived_at = now();
  company.archived_by = from || null;
  company.intro = "";
  company.tags = [];
  // Keep tombstone in s.companies so resume fails with clear error
  s.companies[company.code] = company;
  if (!s.feeds[company.code]) s.feeds[company.code] = [];
  this._feedPush(s, company.code, `☠️ 公司注销（终端态，数据已擦除）`);
  return {
    ok: true,
    company: this._pubCompany(company),
    status: COMPANY_STATUS_ARCHIVED,
    label: "公司注销",
    terminal: true,
    reopen: false,
    snapshot,
    wiped,
    muse_action: this._lifecycleMuseAction(COMPANY_STATUS_ARCHIVED, company.code),
    prompt,
    channel: "prompt",
    note: "必须经 invite-mcp 向当前已登录 Muse lane 投递 prompt，以对称擦除 Muse 侧痕迹。",
  };
}

_getCompany(s, code) {
const c = this._requireCompany(s, code);
const roster = Object.values(s.agents || {}).filter((a) => a.company === c.code);
const live_count = roster.filter((a) => this._isAgentLive(a)).length;
const heartbeat_dormant = this._companyHeartbeatDormant(s, c.code);
return { ...this._pubCompany(c, { heartbeat_dormant, live_count }), live_count, heartbeat_dormant, member_count: roster.length };
}

// ---------- invites（代企业入驻 token；渠道投递在独立 invite-mcp）----------
_createInvite(s, { company_code, role, specialties, tags, from, target_hint, note, role_pack_id}, base) {
const company = this._assertCompanyActive(s, company_code, "创建邀请");
if (from) this._requireAgentInCompany(s, from, company.code);
s.inviteSeq = (s.inviteSeq || 0) + 1;
const invite_id = "INV-" + s.inviteSeq + "-" + Array.from({ length: 4}, () => COMPANY_ALPHABET[Math.floor(Math.random() * COMPANY_ALPHABET.length)]).join("");
let pack = null;
let snap = null;
let packId = null;
if (role_pack_id) {
  pack = resolveRolePack(role_pack_id);
  packId = pack.id;
  snap = snapshotRolePack(pack);
}
const specsRaw = specialties != null ? specialties : tags;
let specs = normalizeCompanyTags(specsRaw);
if ((!specs || !specs.length) && pack && pack.specialties) {
  specs = normalizeCompanyTags(pack.specialties);
}
const invite = {
  invite_id,
  company_code: company.code,
  company_name: company.name,
  role: role || null,
  specialties: specs,
  from: from || null,
  target_hint: target_hint ? String(target_hint).slice(0, 120) : null,
  note: note ? String(note).slice(0, 200) : null,
  status: "pending",
  created_at: now(),
  redeemed_at: null,
  redeemed_by: null,
  role_pack_id: packId,
  role_pack_snapshot: snap,
  prompt: null,
};
invite.prompt = buildInviteRedeemPrompt(base || "https://teams.vyibc.com", invite);
s.invites[invite_id] = invite;
if (from) {
  this._pushReceipt(s, {
    type: "invite_sent",
    company: company.code,
    to: from,
    from,
    ref: { invite_id, company_code: company.code },
    body: { role: invite.role, specialties: specs, target_hint: invite.target_hint, role_pack_id: packId, role_pack_name: snap && snap.name },
  });
}
this._feedPush(s, company.code, `📨 代企业入驻邀请已创建 ${invite_id}${packId ? ` · 角色包 ${snap.name}` : ""}`);
return { ...invite };
}

_getInvite(s, invite_id) {
const inv = s.invites && s.invites[invite_id];
if (!inv) throw new HttpError(404, `unknown invite: ${invite_id}`);
return { ...inv };
}

_redeemInvite(s, invite_id, agentFields) {
const inv = s.invites && s.invites[invite_id];
if (!inv) throw new HttpError(404, `unknown invite: ${invite_id}`);
if (inv.status !== "pending") throw new HttpError(409, `invite ${invite_id} already ${inv.status}`);
this._assertCompanyActive(s, inv.company_code, "兑付邀请入职");
const tags = [
  ...(Array.isArray(inv.specialties) ? inv.specialties : []),
  ...(Array.isArray(agentFields && agentFields.tags) ? agentFields.tags : []),
];
const af = agentFields || {};
let role_pack_id = inv.role_pack_id || null;
let role_pack_snapshot = inv.role_pack_snapshot || null;
if (af.role_pack_id) {
  const pack = resolveRolePack(af.role_pack_id);
  role_pack_id = pack.id;
  role_pack_snapshot = snapshotRolePack(pack);
}
const registered = this._register(s, {
  name: af.name,
  tags,
  model: af.model,
  avatar: af.avatar,
  role: af.role || inv.role || undefined,
  company_code: inv.company_code,
  muse_account: af.muse_account,
  muse_session: af.muse_session,
  role_pack_id,
  role_pack_snapshot,
  // deliberately omit invite_id to avoid re-entrancy with _register invite branch
});
inv.status = "redeemed";
inv.redeemed_at = now();
inv.redeemed_by = registered.doorplate;
const ackBody = {
  invite_id,
  doorplate: registered.doorplate,
  name: registered.name,
  company_code: inv.company_code,
  role_pack_id,
};
if (inv.from) {
  this._pushReceipt(s, {
    type: "invite_ack",
    company: inv.company_code,
    to: inv.from,
    from: registered.doorplate,
    ref: { invite_id, task_id: null },
    body: ackBody,
  });
} else {
  this._notifyCompanyLeads(s, inv.company_code, "invite_ack", registered.doorplate, { invite_id }, ackBody);
}
this._feedPush(s, inv.company_code, `✅ 邀请 ${invite_id} 已兑付：${registered.doorplate} 入职${role_pack_id ? ` · ${role_pack_snapshot && role_pack_snapshot.name}` : ""}`);
return { agent: registered, invite: { ...inv } };
}

// ---------- agents ----------
_register(s, { name, tags, model, avatar, role, company_code, company_name, invite_id, muse_account, muse_session, role_pack_id, role_pack_snapshot}) {
// 代企业入驻：带 invite_id 时走兑付（企业感知入职）
if (invite_id) {
  const inv = s.invites && s.invites[invite_id];
  if (!inv) throw new HttpError(404, `unknown invite: ${invite_id}`);
  if (inv.status !== "pending") throw new HttpError(409, `invite ${invite_id} already ${inv.status}`);
  // Prevent re-entrancy: redeem calls _register without invite_id
  const fields = { name, tags, model, avatar, role, company_code, muse_account, muse_session, role_pack_id, role_pack_snapshot };
  return this._redeemInvite(s, invite_id, fields).agent;
}
const preset = role && ROLE_PRESETS[role]? ROLE_PRESETS[role]: null;
let company;
if (company_code && String(company_code).trim()) {
company = this._assertCompanyActive(s, company_code, "入驻/注册");
} else {
// 创始流程：自动创建新公司
const code = this._genCompanyCode(s);
const foundedName = (company_name && String(company_name).trim().slice(0, 30))
|| this._genCompanyName(s, code.slice(2));
company = {
code,
name: foundedName,
created_at: now(),
intro: "",
tags: [],
status: COMPANY_STATUS_ACTIVE,
suspended_at: null,
resumed_at: null,
archived_at: null,
};
s.companies[code] = company;
s.feeds[code] = [];
this._feedPush(s, code, `🏢 公司成立：${company.name}（公司码 ${code}）`);
}
s.agentSeq += 1;
const doorplate = "muse-" + pad(s.agentSeq, 2);
const merged = [...new Set([...(preset? preset.tags: []),...(tags || [])])];
const isFirst = !Object.values(s.agents).some((x) => x.company === company.code);
const museAcc = muse_account != null ? String(muse_account).trim().slice(0, 128) || null : null;
const museSess = muse_session != null ? String(muse_session).trim().slice(0, 128) || null : null;
let packId = role_pack_id ? String(role_pack_id).trim() : null;
let packSnap = role_pack_snapshot || null;
if (packId && !packSnap) {
  const pack = resolveRolePack(packId);
  packId = pack.id;
  packSnap = snapshotRolePack(pack);
} else if (packId && packSnap && !packSnap.id) {
  packSnap = { ...packSnap, id: packId };
}
if (packSnap && packSnap.specialties && packSnap.specialties.length) {
  for (const t of packSnap.specialties) {
    if (!merged.includes(t)) merged.push(t);
  }
}
const a = {
doorplate,
company: company.code,
role: isFirst ? "lead" : "member",
name: name || (preset? preset.name: "Agent"),
avatar: avatar || AVATARS[(s.agentSeq - 1) % AVATARS.length],
tags: merged,
model: model || null,
muse_account: museAcc,
muse_session: museSess,
role_pack_id: packId || null,
role_pack_snapshot: packSnap || null,
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
t.owner = null; t.status = "pending"; t.claimed_at = null; t.claim_company = null; t.assigned = false; t.dispatch_mode = null;
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
const company = this._requireCompany(s, a.company);
const cst = company.status || COMPANY_STATUS_ACTIVE;
if (cst === COMPANY_STATUS_ARCHIVED) {
  throw new HttpError(410, "公司已注销，拒绝心跳", { company_status: cst, muse_action: this._lifecycleMuseAction(cst, company.code) });
}
if (cst === COMPANY_STATUS_SUSPENDED) {
  return {
    ok: false,
    doorplate,
    company_status: COMPANY_STATUS_SUSPENDED,
    status: "suspended",
    label: "公司休眠",
    muse_action: this._lifecycleMuseAction(COMPANY_STATUS_SUSPENDED, company.code),
    message: "公司已休眠：停止心跳，设置「待唤醒」定时器，勿删数据。",
  };
}
a.last_heartbeat = now();
if (current_task!== undefined) a.current_task = current_task || null;
return { ok: true, doorplate, status: this._statusOf(a), company_status: COMPANY_STATUS_ACTIVE };
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
_createTask(s, { title, desc, priority, deps, acceptance, company_code, task_type, prompts, assign_to}) {
const company = this._assertCompanyActive(s, company_code, "发单").code;
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
// Optional direct assign: skip plaza, create as claimed
let assignee = null;
const assignRaw = assign_to != null ? String(assign_to).trim() : "";
if (assignRaw) {
  // Doorplates are muse-NN; normalize then require
  assignee = this._requireAgent(s, assignRaw.toLowerCase());
  this._assertCompanyActive(s, assignee.company, "直派（被派人公司）");
}
s.taskSeq += 1;
const id = "T-" + s.taskSeq;
const ts = now();
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
status: assignee ? "claimed" : "pending",
owner: assignee ? assignee.doorplate : null,
claim_company: assignee ? assignee.company : null,
assigned: !!assignee,
dispatch_mode: assignee ? "assign" : null,
artifacts: [],
created_at: ts,
claimed_at: assignee ? ts : null,
submitted_at: null,
reviewed_at: null,
done_at: null,
};
s.tasks[id] = t;
const typeLabel = type === "video_gen" ? "🎬视频生成" : (type === "edit" ? "✂️剪辑" : "任务");
if (assignee) {
  const prev = assignee.current_task;
  const busyNote = prev && s.tasks[prev] && s.tasks[prev].status === "claimed"
    ? `（原 current_task ${prev} 被覆盖）`
    : "";
  assignee.current_task = id;
  const cross = t.company && t.company !== assignee.company;
  const note = cross
    ? `直派 ${assignee.doorplate}（${assignee.company}）← ${id}（${t.title} · ${t.company}）${busyNote}`
    : `直派 ${assignee.doorplate} ← ${id}（${t.title}）${busyNote}`;
  this._feedPush(s, company, note);
  if (cross) this._feedPush(s, assignee.company, note);
  this._notifyCompanyLeads(s, t.company, "claim_ok", assignee.doorplate, { task_id: id }, {
    task_id: id,
    title: t.title,
    claimer: assignee.doorplate,
    claim_company: assignee.company,
    cross_company: !!cross,
    assigned: true,
    dispatch_mode: "assign",
  });
  // Notify assignee via mailbox (works cross-company; _sendMail is same-company only)
  if (!s.mailbox[assignee.doorplate]) s.mailbox[assignee.doorplate] = [];
  s.mailbox[assignee.doorplate].push({
    from: "system",
    text: `你被直派了 ${id}：${t.title}`,
    task_id: id,
    ts,
    read: false,
    assigned: true,
  });
} else {
  this._feedPush(s, company, `新${typeLabel} ${id}：${t.title}`);
}
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
this._assertCompanyActive(s, company, "抢单");
const t = this._requireTask(s, id);
this._assertCompanyActive(s, t.company, "抢单（发单方公司）");
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
// 回执：通知发单方 lead 有人抢单
this._notifyCompanyLeads(s, t.company, "claim_ok", doorplate, { task_id: id }, {
  task_id: id,
  title: t.title,
  claimer: doorplate,
  claim_company: a.company,
  cross_company: !!cross,
});
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
// 回执：submit_ok → 发单方 + 提交人（交付包挂任务 result，回执只通知）
const submitBody = {
  task_id: id,
  title: t.title,
  task_type: t.task_type || "general",
  has_delivery: t.result != null,
  artifact_count: Array.isArray(t.artifacts) ? t.artifacts.length : 0,
};
this._notifyCompanyLeads(s, t.company, "submit_ok", doorplate, { task_id: id }, submitBody);
this._pushReceipt(s, {
  type: "submit_ok",
  company: a.company,
  to: doorplate,
  from: doorplate,
  ref: { task_id: id },
  body: submitBody,
});
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
if (t.owner) {
  this._pushReceipt(s, {
    type: "review_pass",
    company: caller,
    to: t.owner,
    from: null,
    ref: { task_id: id },
    body: { task_id: id, title: t.title, note: note || null },
  });
}
this._notifyCompanyLeads(s, caller, "review_pass", t.owner, { task_id: id }, {
  task_id: id, title: t.title, note: note || null, owner: t.owner,
});
} else {
const prev = t.owner;
const prevCo = t.claim_company;
t.status = "pending";
t.owner = null;
t.claim_company = null;
t.claimed_at = null;
t.submitted_at = null;
t.result = null;
t.assigned = false;
t.dispatch_mode = null;
const a = s.agents[prev];
if (a && a.current_task === id) a.current_task = null;
this._feedPush(s, caller, `${id} 被打回，已退回待认领${note? "（" + note + "）": ""}`);
if (prevCo && prevCo !== caller) this._feedPush(s, prevCo, `${id} 被打回，已退回待认领${note? "（" + note + "）": ""}`);
if (prev) {
  this._pushReceipt(s, {
    type: "review_reject",
    company: caller,
    to: prev,
    from: null,
    ref: { task_id: id },
    body: { task_id: id, title: t.title, note: note || null },
  });
}
this._notifyCompanyLeads(s, caller, "review_reject", prev, { task_id: id }, {
  task_id: id, title: t.title, note: note || null, previous_owner: prev,
});
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
for (const dp of Object.keys(s.agents)) {
  if (s.agents[dp].company === company) {
    this._pushReceipt(s, {
      type: "broadcast",
      company,
      to: dp,
      from: sender,
      ref: {},
      body: { text: String(text).slice(0, 500) },
    });
  }
}
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
description: "Register this Muse session as a worker agent on Muse Teams. 注册当前会话为 Team 成员。Call ONCE per session. Always pass muse_account (current login) AND muse_session (side-chat name) so ops can map doorplate→Muse. Save the returned doorplate (e.g. muse-05) AND company_code — they are your identity for every later call. To join an existing company, pass its company_code; omit it to found a new company (you'll get a fresh company_code). After registering: the company scheduler (cron ~every 2 min) should call teams_company_renew with the full workers-<company_code>.json doorplate list (or teams_heartbeat per agent). Without renew/heartbeat for HEARTBEAT_TTL (180s) you show dormant (休眠). Also call teams_poll_tasks regularly (or let the scheduler claim/dispatch). Keywords: register, join, 入驻, 注册.",
inputSchema: {
type: "object",
properties: {
name: { type: "string", description: "Display name for this agent, e.g. 'Coder-1'"},
tags: { type: "array", items: { type: "string"}, description: "Skill tags, e.g. [\"coder\",\"reviewer\"]. Tasks are matched by tags."},
avatar: { type: "string", description: "Optional emoji avatar, e.g. '🦊'. Auto-assigned if omitted."},
company_code: { type: "string", description: "Company code to join, e.g. 'C-7K2Q'. Omit to found a new company."},
company_name: { type: "string", description: "Company name, used when founding a new company (企业自己入驻/开公司)."},
invite_id: { type: "string", description: "代企业入驻 invite id from teams_create_invite. When set, joins that company and emits invite_ack (prefer teams_redeem_invite)."},
muse_account: { type: "string", description: "Required in practice: current logged-in Muse account (email or account label). Stored on the agent so ops can map doorplate→Muse. Pass together with muse_session."},
muse_session: { type: "string", description: "Required in practice: this side-chat / Muse session name (旁聊会话名). Stored with muse_account for doorplate ownership lookup."},
role_pack_id: { type: "string", description: "Optional employee role pack id (plaza MCP/skill refs). Prefer setting on invite; redeem copies pack snapshot to agent."}
},
required: ["name"]
}
},
{
name: "teams_heartbeat",
description: "Per-agent heartbeat: tell the team one worker is alive. 单员工心跳保活。Prefer teams_company_renew from the company scheduler (one call for the full workers-<company_code>.json list). Keep this for single-doorplate updates or current_task. If no heartbeat for HEARTBEAT_TTL (180s) you show dormant (休眠员工). Keywords: heartbeat, alive, online, 心跳, 保活.",
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
description: "Company-level renew: refresh last_heartbeat for every doorplate in the company's known worker list. 公司续约心跳。Company scheduler should call this every ~2 minutes with doorplates from workers-<company_code>.json. Agents not listed naturally go dormant after HEARTBEAT_TTL (180s). Unknown or wrong-company doorplates are returned as warnings and ignored. Keywords: renew, company heartbeat, scheduler, 续约, 公司心跳.",
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
description: "Submit delivery package（交付包）for a claimed task; goes to review. For video_gen pass result:[{prompt,video_url|asset_id,meta?}]. Field name is result; product name is 交付包. Also writes submit_ok receipt. Keywords: submit, deliver, delivery package, 提交, 交付包.",
inputSchema: {
type: "object",
properties: {
task_id: { type: "string", description: "Task id"},
doorplate: { type: "string", description: "Your doorplate (must be the task owner)"},
company_code: { type: "string", description: "Your company code. Required."},
artifacts: { type: "array", description: "Deliverables", items: { type: "object", properties: { type: { type: "string", description: "e.g. 'text', 'url', 'file'"}, content: { type: "string", description: "The deliverable content or URL"}}, required: ["type", "content"]}},
result: { type: "array", description: "video_gen 交付包 payload: [{prompt, video_url?, asset_id?, meta?}]", items: { type: "object"}}
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
description: "Create a new task in YOUR company's task hall. 默认进广场 pending 供抢单；传 assign_to（门牌）则直派：立刻 claimed，跳过广场。Anyone (usually the lead) can publish. Keywords: create, publish, assign, 发布任务, 直派, 新建.",
inputSchema: {
type: "object",
properties: {
title: { type: "string", description: "Task title. Optional for video_gen (auto from prompts); required for general."},
desc: { type: "string", description: "Task description"},
priority: { type: "string", enum: ["P0", "P1", "P2"], description: "Priority, default P1"},
doorplate: { type: "string", description: "Your doorplate (used to scope to your company)"},
company_code: { type: "string", description: "Company code (alternative to doorplate for scoping)"},
assign_to: { type: "string", description: "Optional doorplate to assign immediately (claimed, skip plaza). 直派门牌，跳过抢单。Cross-company OK. video_gen 直派也可用 HTTP POST /api/tasks."},
task_type: { type: "string", description: "general|video_gen|edit (default general)"},
prompts: { description: "For video_gen: array or multiline string of prompts"}
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
description: "Read p2p/broadcast mailbox (marks them read). For typed 回执箱 use teams_list_receipts. Keywords: inbox, mail, messages, 收件箱, 查邮件.",
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
description: "List agents of YOUR company with live status (online/busy/dormant), current task and tags. 查看本公司所有成员。Keywords: agents, members, roster, 成员列表, 门牌墙.",
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
name: "teams_list_companies",
description: "List all companies with intro（简介）and specialty tags（擅长标签）. 公司列表。Keywords: companies, list, intro, tags, 公司, 简介, 擅长.",
inputSchema: { type: "object", properties: {} }
},
{
name: "teams_company_create",
description: "企业自助开公司（self-onboard）：创建空公司壳，返回公司码。不等于代企业入驻。Create a company without registering an agent. Keywords: create company, self-onboard, 开公司, 企业自助入驻.",
inputSchema: {
type: "object",
properties: {
name: { type: "string", description: "Company name (optional, auto-generated if omitted)"},
intro: { type: "string", description: "Company intro / blurb 简介"},
tags: { type: "array", items: { type: "string"}, description: "Specialty tags e.g. [\"video_gen\",\"edit\"]"},
specialties: { type: "array", items: { type: "string"}, description: "Alias of tags"}
}
}
},
{
name: "teams_update_company",
description: "Update company intro and specialty tags. 更新公司简介与擅长标签。Keywords: update company, intro, tags, 简介, 擅长.",
inputSchema: {
type: "object",
properties: {
company_code: { type: "string", description: "Company code"},
intro: { type: "string", description: "简介"},
blurb: { type: "string", description: "Alias of intro"},
tags: { type: "array", items: { type: "string"}},
specialties: { type: "array", items: { type: "string"}},
name: { type: "string"},
from: { type: "string", description: "Optional lead doorplate for authorization"}
},
required: ["company_code"]
}
},
{
name: "teams_list_receipts",
description: "List typed receipts（回执箱 fixed enum）. Separate from task delivery package. Filter by type: invite_sent|invite_ack|claim_ok|submit_ok|review_pass|review_reject|broadcast|agent_offline|quota_warn. Keywords: receipts, 回执箱, ack.",
inputSchema: {
type: "object",
properties: {
doorplate: { type: "string"},
company_code: { type: "string"},
type: { type: "string", description: "Receipt type or 'all'"},
unread_only: { type: "boolean"},
mark_read: { type: "boolean", description: "Mark returned receipts as read"}
},
required: ["doorplate", "company_code"]
}
},
{
name: "teams_create_invite",
description: "代企业入驻：创建 pending invite + 入驻提示词。Pass role_pack_id to bind a plaza role pack (指令×3 + MCP/skill). Does NOT deliver (use invite-mcp). On redeem, Teams emits invite_ack. Keywords: invite, proxy-onboard, role_pack, 代企业入驻, 邀请, 角色包.",
inputSchema: {
type: "object",
properties: {
company_code: { type: "string"},
from: { type: "string", description: "Inviter doorplate (receives invite_sent / invite_ack)"},
role: { type: "string"},
specialties: { type: "array", items: { type: "string"}, description: "e.g. [\"video_gen\",\"edit\"]"},
tags: { type: "array", items: { type: "string"}},
target_hint: { type: "string", description: "Optional channel target hint"},
note: { type: "string"},
role_pack_id: { type: "string", description: "Role pack id from teams_list_role_packs, e.g. video_gen_worker | editor"}
},
required: ["company_code"]
}
},
{
name: "teams_redeem_invite",
description: "Redeem a proxy-onboard invite_id: register into the invited company and emit invite_ack. 兑付代企业入驻邀请. Always pass muse_account + muse_session. Invite's role_pack_id/snapshot is stamped on the agent. Keywords: redeem, join via invite, role_pack, 兑付, 入职.",
inputSchema: {
type: "object",
properties: {
invite_id: { type: "string"},
name: { type: "string"},
avatar: { type: "string"},
tags: { type: "array", items: { type: "string"}},
role: { type: "string"},
muse_account: { type: "string", description: "Current Muse login account (email/label). Stored for doorplate ownership."},
muse_session: { type: "string", description: "Side-chat / Muse session name for this worker."},
role_pack_id: { type: "string", description: "Optional override pack id; default comes from the invite"}
},
required: ["invite_id", "name"]
}
},
{
name: "teams_list_role_packs",
description: "List employee role packs: plaza MCP/skill refs + 三份指令元数据（主聊/旁聊调度/干活执行）. Plaza https://fleet.vyibc.com/api/hub/registry is source of truth; Teams only stores refs + snapshots on invite/agent. Keywords: role pack, 角色包, 能力广场, plaza.",
inputSchema: { type: "object", properties: {} }
},
{
name: "teams_company_suspend",
description: "公司休眠（suspend）: active→suspended. Requires from=lead. Reversible via teams_company_resume. Muse: stop heartbeat, wind down, keep data, add 「待唤醒」timer. Product copy: 公司休眠/公司重开. Keywords: suspend, 休眠, 公司休眠.",
inputSchema: {
type: "object",
properties: {
company_code: { type: "string"},
from: { type: "string", description: "Required lead doorplate"}
},
required: ["company_code", "from"]
}
},
{
name: "teams_company_resume",
description: "公司重开（resume）: suspended→active. Requires from=lead. Muse: cancel 待唤醒, restart heartbeat. Archived companies cannot resume. Keywords: resume, 重开, 公司重开.",
inputSchema: {
type: "object",
properties: {
company_code: { type: "string"},
from: { type: "string", description: "Required lead doorplate"}
},
required: ["company_code", "from"]
}
},
{
name: "teams_company_archive",
description: "公司注销（archive）: terminal wipe. Requires from=lead. Returns prompt for invite-mcp delivery to logged-in Muse lanes; Teams clears members/tasks/timers data. No reopen. Keywords: archive, 注销, 公司注销.",
inputSchema: {
type: "object",
properties: {
company_code: { type: "string"},
from: { type: "string", description: "Required lead doorplate"}
},
required: ["company_code", "from"]
}
},
{
name: "teams_task_trace",
description: "One-order lifecycle chain: created → plaza → claimed → submitted → reviewed. 一单链路追溯。Returns stages + intelliui/timeline/v1 + delivery envelope. Keywords: trace, timeline, chain, lifecycle, IntelliUI, 链路, 追溯, 时间线.",
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
case "teams_list_companies": return { companies: this._listCompanies(s) };
case "teams_company_create": return this._createCompany(s, a);
case "teams_update_company": return this._updateCompany(s, a.company_code, a, a.from);
case "teams_list_receipts": return this._listReceipts(s, a);
case "teams_list_role_packs": return { packs: listRolePacks(), plaza_source_of_truth: PLAZA_REGISTRY_URL };
case "teams_create_invite": return this._createInvite(s, a, "https://teams.vyibc.com");
case "teams_redeem_invite": return this._redeemInvite(s, a.invite_id, a);
case "teams_company_suspend": return this._suspendCompany(s, a.company_code, a.from, "https://teams.vyibc.com");
case "teams_company_resume": return this._resumeCompany(s, a.company_code, a.from, "https://teams.vyibc.com");
case "teams_company_archive": return this._archiveCompany(s, a.company_code, a.from, "https://teams.vyibc.com");
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
const content = [{ type: "text", text: JSON.stringify(out) }];
if (out && out.intelliui) {
  content.push({ type: "intelliui/timeline", timeline: out.intelliui });
}
return ok({
  content,
  ...(out && out.intelliui ? { structuredContent: { intelliui: out.intelliui } } : {}),
});
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
return json({ ok: true, do_version: "2026-10-15-assign-to-v1", has_task_trace: typeof this._taskTrace === "function", has_receipts: true, has_invites: true, has_assign_to: true});

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
return json({ companies: this._listCompanies(s) });
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
return json(this._createCompany(s, body || {}));

// GET /api/companies/:code — 查询公司（入驻校验用）
if (method === "GET" && r.length === 2 && r[0] === "companies")
return json(this._getCompany(s, r[1]));

// PATCH /api/companies/:code — 更新简介/擅长标签
if (method === "PATCH" && r.length === 2 && r[0] === "companies")
return json(this._updateCompany(s, r[1], body || {}, body && body.from));

// POST /api/companies/:code/renew — 公司级续约（名单内员工全部刷新心跳）
if (method === "POST" && r.length === 3 && r[0] === "companies" && r[2] === "renew")
return json(this._companyRenew(s, r[1], body && body.doorplates, body && body.from));

// POST /api/companies/:code/suspend — 公司休眠
if (method === "POST" && r.length === 3 && r[0] === "companies" && r[2] === "suspend") {
  const base = `${url.protocol}//${url.host}`;
  return json(this._suspendCompany(s, r[1], body && body.from, base));
}

// POST /api/companies/:code/resume — 公司重开
if (method === "POST" && r.length === 3 && r[0] === "companies" && r[2] === "resume") {
  const base = `${url.protocol}//${url.host}`;
  return json(this._resumeCompany(s, r[1], body && body.from, base));
}

// POST /api/companies/:code/archive — 公司注销（终端）
if (method === "POST" && r.length === 3 && r[0] === "companies" && r[2] === "archive") {
  const base = `${url.protocol}//${url.host}`;
  return json(this._archiveCompany(s, r[1], body && body.from, base));
}

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

// GET /api/receipts?doorplate=&company=&type=&unread_only=&mark_read=
if (method === "GET" && r.length === 1 && r[0] === "receipts")
return json(this._listReceipts(s, {
  doorplate: query.get("doorplate"),
  company_code: query.get("company") || query.get("company_code"),
  type: query.get("type") || "all",
  unread_only: query.get("unread_only") === "1" || query.get("unread_only") === "true",
  mark_read: query.get("mark_read") === "1" || query.get("mark_read") === "true",
}));

// POST /api/receipts/:id/read
if (method === "POST" && r.length === 3 && r[0] === "receipts" && r[2] === "read")
return json(this._markReceiptRead(s, r[1], body.doorplate, body.company_code));

// GET /api/role-packs
if (method === "GET" && r.length === 1 && r[0] === "role-packs")
return json({ packs: listRolePacks(), plaza_source_of_truth: PLAZA_REGISTRY_URL });

// POST /api/invites — 代企业入驻：创建邀请（不投递渠道）
if (method === "POST" && r.length === 1 && r[0] === "invites") {
  const base = `${url.protocol}//${url.host}`;
  return json(this._createInvite(s, body || {}, base));
}

// GET /api/invites/:id
if (method === "GET" && r.length === 2 && r[0] === "invites")
return json(this._getInvite(s, r[1]));

// POST /api/invites/:id/redeem
if (method === "POST" && r.length === 3 && r[0] === "invites" && r[2] === "redeem")
return json(this._redeemInvite(s, r[1], body || {}));

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
async fetch(request, env, ctx) {
// CORS preflight: answer at the edge, don't hit the DO
if (request.method.toUpperCase() === "OPTIONS")
return new Response(null, { status: 204, headers: {...CORS_HEADERS}});
const url = new URL(request.url);
// 边缘探针：不进 DO，确认 Worker 新版本已生效
if (url.pathname === "/api/version-probe")
return json({ edge_version: "2026-10-15-assign-to-v1", ok: true, feature: "assign_to_direct_dispatch" });
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

// POST /api/companies — create in DO, then merge invite_prompt + intro/tags at edge (D1)
if (url.pathname === "/api/companies" && request.method.toUpperCase() === "POST") {
let createBody = null;
try { createBody = await request.json(); } catch (_) { createBody = {}; }
const res = await stub.fetch(new Request(request.url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(createBody || {}),
}));
let data = null;
try { data = await res.json();} catch (_) { /* ignore */}
if (!res.ok) return json(data || { ok: false, error: "create failed"}, res.status);
// Ensure D1 row exists then apply intro/tags (DO may be sticky on old code)
try {
  await ensureD1Schema(env.DB);
  const existing = await d1First(env.DB, "SELECT code FROM companies WHERE code = ?", data.code);
  if (!existing) {
    await d1Run(env.DB,
      "INSERT INTO companies (code, name, created_at, intro, tags) VALUES (?, ?, ?, ?, ?)",
      data.code, data.name || data.code, data.created_at || now(), "", "[]"
    );
  }
  const profile = await edgeUpdateCompanyProfile(env.DB, data.code, {
    intro: createBody && (createBody.intro != null ? createBody.intro : createBody.blurb),
    tags: createBody && (createBody.tags != null ? createBody.tags : createBody.specialties),
    name: createBody && createBody.name,
  });
  if (profile) data = { ...data, ...profile };
} catch (e) { console.error("edge company profile", e && e.message); }
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
for (const t of EDGE_NEW_TOOLS) {
  if (!tools.some((x) => x && x.name === t.name)) tools.push(t);
}
// Ensure assign_to on teams_create_task even if sticky DO schema is old
for (const t of tools) {
  if (t && t.name === "teams_create_task") {
    t.description = "Create a new task in YOUR company's task hall. 默认进广场 pending 供抢单；传 assign_to（门牌）则直派：立刻 claimed，跳过广场。Keywords: create, publish, assign, 发布任务, 直派.";
    if (!t.inputSchema) t.inputSchema = { type: "object", properties: {}, required: ["title"] };
    if (!t.inputSchema.properties) t.inputSchema.properties = {};
    t.inputSchema.properties.assign_to = { type: "string", description: "Optional doorplate to assign immediately (claimed, skip plaza). 直派门牌，跳过抢单。Cross-company OK." };
    if (!t.inputSchema.properties.task_type) t.inputSchema.properties.task_type = { type: "string", description: "general|video_gen|edit" };
    if (!t.inputSchema.properties.prompts) t.inputSchema.properties.prompts = { description: "For video_gen: array or multiline prompts" };
  }
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
const content = [{ type: "text", text: JSON.stringify(trace) }];
if (trace && trace.intelliui) {
  content.push({ type: "intelliui/timeline", timeline: trace.intelliui });
}
return json({
jsonrpc: "2.0",
id: rpcId,
result: { content, structuredContent: trace && trace.intelliui ? { intelliui: trace.intelliui } : undefined },
});
}
// Edge MCP handlers for sticky-DO new tools
if (body && body.method === "tools/call" && body.params && EDGE_NEW_TOOLS.some((t) => t.name === body.params.name)) {
  const rpcId = body.id !== undefined ? body.id : null;
  const name = body.params.name;
  const args = body.params.arguments || {};
  try {
    let out;
    if (name === "teams_list_companies") {
      out = { companies: await listCompaniesFromD1(env.DB) };
    } else if (name === "teams_company_create") {
      const cres = await stub.fetch(new Request(`${base}/api/companies`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args),
      }));
      out = await cres.json();
      if (!cres.ok) throw new HttpError(cres.status, (out && out.error) || "create failed");
      try {
        await ensureD1Schema(env.DB);
        const existing = await d1First(env.DB, "SELECT code FROM companies WHERE code = ?", out.code);
        if (!existing) {
          await d1Run(env.DB,
            "INSERT INTO companies (code, name, created_at, intro, tags) VALUES (?, ?, ?, ?, ?)",
            out.code, out.name || out.code, out.created_at || now(), "", "[]");
        }
        const profile = await edgeUpdateCompanyProfile(env.DB, out.code, args);
        if (profile) out = { ...out, ...profile };
        out.invite_prompt = buildInvitePrompt(base, null, out.code, out.name).prompt;
      } catch (pe) { console.error("mcp create profile", pe && pe.message); }
    } else if (name === "teams_update_company") {
      const code = args.company_code;
      const ures = await stub.fetch(new Request(`${base}/api/companies/${encodeURIComponent(code)}`, {
        method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(args),
      }));
      // edge PATCH handler above runs when going through worker URL; call helper directly
      out = await edgeUpdateCompanyProfile(env.DB, code, args) || await ures.json();
    } else if (name === "teams_list_receipts") {
      out = await edgeListReceipts(env.DB, {
        doorplate: args.doorplate,
        company: args.company_code,
        type: args.type || "all",
        unread_only: !!args.unread_only,
        mark_read: !!args.mark_read,
      });
    } else if (name === "teams_list_role_packs") {
      out = { packs: listRolePacks(), plaza_source_of_truth: PLAZA_REGISTRY_URL };
    } else if (name === "teams_create_invite") {
      out = await edgeCreateInvite(env.DB, args, base);
    } else if (name === "teams_redeem_invite") {
      out = await edgeRedeemInvite(env.DB, stub, base, args.invite_id, args);
    } else if (name === "teams_company_suspend" || name === "teams_company_resume" || name === "teams_company_archive") {
      const code = String(args.company_code || "").trim().toUpperCase();
      if (!code) throw new HttpError(400, "company_code required");
      const from = args.from;
      await edgeRequireLead(env.DB, code, from);
      const action = name === "teams_company_suspend" ? "suspend" : name === "teams_company_resume" ? "resume" : "archive";
      await ensureD1Schema(env.DB);
      const co = await d1First(env.DB, "SELECT code, name, created_at, intro, tags, status, suspended_at, archived_at FROM companies WHERE code = ?", code);
      if (!co) throw new HttpError(404, `公司码不存在: ${code}`);
      const cur = co.status || COMPANY_STATUS_ACTIVE;
      let tags = [];
      try { tags = co.tags ? JSON.parse(co.tags) : []; } catch (_) { tags = []; }
      const companyObj = { code: co.code, name: co.name, status: cur, suspended_at: co.suspended_at || null, archived_at: co.archived_at || null, created_at: co.created_at, intro: co.intro || "", tags };
      const receiptType = action === "suspend" ? "company_suspend" : action === "resume" ? "company_resume" : "company_archive";
      if (action === "suspend") {
        if (cur === COMPANY_STATUS_ARCHIVED) throw new HttpError(409, "公司已注销，不可休眠");
        const suspended_at = cur === COMPANY_STATUS_SUSPENDED ? (co.suspended_at || now()) : now();
        await d1Run(env.DB, "UPDATE companies SET status = ?, suspended_at = ? WHERE code = ?", COMPANY_STATUS_SUSPENDED, suspended_at, code);
        companyObj.status = COMPANY_STATUS_SUSPENDED; companyObj.suspended_at = suspended_at;
        out = { ok: true, company: companyObj, status: COMPANY_STATUS_SUSPENDED, label: "公司休眠", muse_action: { stop_heartbeat: true, wind_down: true, delete_data: false, pending_wake_timer: true, timer_name: "待唤醒", resume_path: `/api/companies/${code}/resume`, product_copy: "公司休眠 / 公司重开" }, prompt: buildSuspendPrompt(base, companyObj), channel: "detect_via_renew_or_get", edge: true };
      } else if (action === "resume") {
        if (cur === COMPANY_STATUS_ARCHIVED) throw new HttpError(409, "公司已注销，不可重开（终端态）");
        await d1Run(env.DB, "UPDATE companies SET status = ?, suspended_at = ? WHERE code = ?", COMPANY_STATUS_ACTIVE, 0, code);
        companyObj.status = COMPANY_STATUS_ACTIVE; companyObj.suspended_at = null; companyObj.resumed_at = now();
        out = { ok: true, company: companyObj, status: COMPANY_STATUS_ACTIVE, label: "公司重开", muse_action: { restart_heartbeat: true, cancel_pending_wake: true, product_copy: "公司重开" }, prompt: buildResumePrompt(base, companyObj), channel: "detect_via_renew_or_get", edge: true };
      } else {
        if (cur === COMPANY_STATUS_ARCHIVED) throw new HttpError(409, "公司已注销");
        try {
          await edgeNotifyLifecycleReceipts(env.DB, code, "company_archive", from, { status: COMPANY_STATUS_ARCHIVED, label: "公司注销", terminal: true });
        } catch (_) {}
        const archived_at = now();
        try { await dbBatchDeleteCompany(env.DB, code); } catch (_) {}
        await d1Run(env.DB, "UPDATE companies SET status = ?, archived_at = ?, intro = ?, tags = ? WHERE code = ?", COMPANY_STATUS_ARCHIVED, archived_at, "", "[]", code);
        companyObj.status = COMPANY_STATUS_ARCHIVED; companyObj.archived_at = archived_at; companyObj.intro = ""; companyObj.tags = [];
        out = { ok: true, company: companyObj, status: COMPANY_STATUS_ARCHIVED, label: "公司注销", terminal: true, reopen: false, muse_action: { full_wipe: true, stop_heartbeat: true, delete_timers: true, delete_local_traces: true, reopen: false, product_copy: "公司注销" }, prompt: buildArchiveWipePrompt(base, companyObj), channel: "prompt", edge: true };
      }
      if (action !== "archive") {
        try {
          await edgeNotifyLifecycleReceipts(env.DB, code, receiptType, from, { status: out.status, label: out.label });
        } catch (_) {}
      }
      try {
        await withTimeout(stub.fetch(new Request(`${base}/api/companies/${encodeURIComponent(code)}/${action}`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from }),
        })), 2500);
        out.do_synced = true;
      } catch (_) {
        out.do_synced = false;
      }
    } else {
      throw new HttpError(404, `unknown tool: ${name}`);
    }
    return json({ jsonrpc: "2.0", id: rpcId, result: { content: [{ type: "text", text: JSON.stringify(out) }] } });
  } catch (e) {
    const msg = e && e.message ? e.message : String(e);
    return json({ jsonrpc: "2.0", id: rpcId, error: { code: -32602, message: msg } });
  }
}

// Edge status gate for busy-path tools (sticky DO may not know D1 lifecycle yet)
if (body && body.method === "tools/call" && body.params) {
  const tname = body.params.name;
  const targs = body.params.arguments || {};
  try {
    if (tname === "teams_claim") {
      const claimerCo = String(targs.company_code || "").trim().toUpperCase();
      if (claimerCo) await edgeAssertCompanyActive(env.DB, claimerCo, "抢单");
      if (targs.task_id) {
        try {
          const tres = await withTimeout(stub.fetch(new Request(`${base}/api/tasks/${encodeURIComponent(targs.task_id)}`, { method: "GET" })), 2000);
          const td = await tres.json().catch(() => null);
          if (tres.ok && td && td.company) await edgeAssertCompanyActive(env.DB, td.company, "抢单（发单方公司）");
        } catch (ge) { if (ge instanceof HttpError) throw ge; }
      }
    } else if (tname === "teams_create_task") {
      const code = String(targs.company_code || "").trim().toUpperCase();
      if (code) await edgeAssertCompanyActive(env.DB, code, "发单");
      if (targs.assign_to) {
        // Resolve company from doorplate if only doorplate passed
        let args = { ...targs };
        if (!args.company_code && targs.doorplate) {
          try {
            const a = await edgeResolveAgentByDoorplate(env.DB, stub, base, targs.doorplate);
            args.company_code = a.company;
          } catch (_) {}
        }
        if (!args.company_code) {
          return json({ jsonrpc: "2.0", id: rpcId, error: { code: -32602, message: "需要 company_code 或 doorplate" } });
        }
        try {
          const out = await edgeCreateTaskWithAssign(env, stub, base, args);
          if (out.status >= 400) {
            return json({ jsonrpc: "2.0", id: rpcId, error: { code: -32602, message: (out.data && (out.data.error || out.data.message)) || "create failed" } });
          }
          return json({ jsonrpc: "2.0", id: rpcId, result: { content: [{ type: "text", text: JSON.stringify(out.data) }] } });
        } catch (ce) {
          if (ce instanceof HttpError) {
            return json({ jsonrpc: "2.0", id: rpcId, error: { code: -32602, message: ce.message } });
          }
          throw ce;
        }
      }
    } else if (tname === "teams_register") {
      const code = String(targs.company_code || "").trim().toUpperCase();
      if (code) await edgeAssertCompanyActive(env.DB, code, "入驻/注册");
    } else if (tname === "teams_redeem_invite" && targs.invite_id) {
      // edge redeem path already gates; when falling through, check invite company
      try {
        const inv = await edgeGetInvite(env.DB, targs.invite_id);
        await edgeAssertCompanyActive(env.DB, inv.company_code, "兑付邀请入职");
      } catch (ge) { if (ge instanceof HttpError) throw ge; }
    }
  } catch (e) {
    if (e instanceof HttpError) {
      return json({ jsonrpc: "2.0", id: rpcId, error: { code: -32602, message: e.message } });
    }
  }
}

// Other MCP methods: rebuild request with already-read body
return stub.fetch(new Request(request.url, {
method: "POST",
headers: { "content-type": "application/json" },
body: JSON.stringify(body),
}));
}

// ---- Edge routes for sticky-DO resilience (回执箱 / 代企业入驻 / 公司简介) ----
try {
  // PATCH /api/companies/:code
  {
    const m = url.pathname.match(/^\/api\/companies\/([^/]+)$/);
    if (method === "PATCH" && m) {
      let body = null;
      try { body = await request.json(); } catch (_) { body = {}; }
      const code = decodeURIComponent(m[1]).toUpperCase();
      // best-effort DO update (sticky DO may hang/404 — never block edge)
      try { await withTimeout(stub.fetch(new Request(request.url, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) })), 2000); } catch (_) {}
      const profile = await edgeUpdateCompanyProfile(env.DB, code, body || {});
      if (!profile) {
        // ensure row from DO get
        const cres = await stub.fetch(new Request(`${base}/api/companies/${encodeURIComponent(code)}`, { method: "GET" }));
        const cdata = await cres.json().catch(() => null);
        if (!cres.ok) return json(cdata || { ok: false, error: "not found" }, cres.status);
        await ensureD1Schema(env.DB);
        await d1Run(env.DB,
          "INSERT OR IGNORE INTO companies (code, name, created_at, intro, tags) VALUES (?, ?, ?, ?, ?)",
          cdata.code, cdata.name || cdata.code, cdata.created_at || now(), "", "[]"
        );
        const again = await edgeUpdateCompanyProfile(env.DB, code, body || {});
        return json(again || { ...cdata, ...(body || {}) });
      }
      return json(profile);
    }
  }


  // GET /api/companies/:code — prefer D1 (lifecycle status); DO GET with short timeout
  {
    const m = url.pathname.match(/^\/api\/companies\/([^/]+)$/);
    if (method === "GET" && m) {
      const code = decodeURIComponent(m[1]).toUpperCase();
      let data = null;
      try {
        const row = await d1First(env.DB, "SELECT code, name, created_at, intro, tags, status, suspended_at, archived_at FROM companies WHERE code = ?", code);
        if (row) {
          let tags = [];
          try { tags = row.tags ? JSON.parse(row.tags) : []; } catch (_) { tags = []; }
          const status = row.status || COMPANY_STATUS_ACTIVE;
          let live_count = 0;
          let member_count = 0;
          try {
            const liveAfter = now() - HEARTBEAT_TTL_MS;
            const liveRow = await d1First(env.DB,
              `SELECT
                 (SELECT COUNT(*) FROM agents a WHERE a.company_code = ?) AS member_count,
                 (SELECT COUNT(*) FROM agents a WHERE a.company_code = ?
                   AND a.last_heartbeat IS NOT NULL AND a.last_heartbeat > ?) AS live_count`,
              code, code, liveAfter);
            member_count = Number(liveRow && liveRow.member_count) || 0;
            live_count = Number(liveRow && liveRow.live_count) || 0;
          } catch (_) {}
          const heartbeat_dormant = status === COMPANY_STATUS_ARCHIVED ? true : live_count === 0;
          data = {
            code: row.code,
            name: row.name,
            created_at: row.created_at,
            intro: row.intro || "",
            blurb: row.intro || "",
            tags,
            specialties: tags,
            status,
            suspended_at: row.suspended_at || null,
            archived_at: row.archived_at || null,
            member_count,
            live_count,
            heartbeat_dormant,
          };
        }
      } catch (_) {}
      if (!data) {
        try {
          const cres = await withTimeout(stub.fetch(new Request(`${base}/api/companies/${encodeURIComponent(code)}`, { method: "GET" })), 2000);
          data = await cres.json().catch(() => ({}));
          if (!cres.ok) return json(data, cres.status);
          if (!data.status) data.status = COMPANY_STATUS_ACTIVE;
          if (data.heartbeat_dormant == null) {
            data.heartbeat_dormant = data.status === COMPANY_STATUS_ARCHIVED ? true : !(data.live_count > 0);
          }
        } catch (_) {
          return json({ ok: false, error: `公司码不存在: ${code}` }, 404);
        }
      }
      return json(data);
    }
  }

  // Edge renew: if D1 company is suspended/archived, return muse_action without DO
  {
    const m = url.pathname.match(/^\/api\/companies\/([^/]+)\/renew$/);
    if (method === "POST" && m) {
      const code = decodeURIComponent(m[1]).toUpperCase();
      try {
        const row = await d1First(env.DB, "SELECT code, name, status FROM companies WHERE code = ?", code);
        const st = row && (row.status || COMPANY_STATUS_ACTIVE);
        if (st === COMPANY_STATUS_ARCHIVED) {
          return json({ ok: false, error: "公司已注销（archived），不可续约", company_status: COMPANY_STATUS_ARCHIVED, muse_action: { full_wipe: true, stop_heartbeat: true, reopen: false } }, 410);
        }
        if (st === COMPANY_STATUS_SUSPENDED) {
          return json({
            ok: false,
            company_code: code,
            company_status: COMPANY_STATUS_SUSPENDED,
            renewed: [],
            count: 0,
            label: "公司休眠",
            muse_action: {
              stop_heartbeat: true, wind_down: true, delete_data: false,
              pending_wake_timer: true, timer_name: "待唤醒",
              resume_path: `/api/companies/${code}/resume`,
              product_copy: "公司休眠 / 公司重开",
            },
            message: "公司已休眠：停止心跳并设置「待唤醒」定时器；勿删除数据。",
            edge: true,
          });
        }
      } catch (_) {}
      // else fall through to DO renew below
    }
  }

  // Company lifecycle: edge-first D1 + lead auth + receipts + best-effort DO sync
  {
    const m = url.pathname.match(/^\/api\/companies\/([^/]+)\/(suspend|resume|archive)$/);
    if (method === "POST" && m) {
      try {
        let body = null;
        try { body = await request.json(); } catch (_) { body = {}; }
        const code = decodeURIComponent(m[1]).toUpperCase();
        const action = m[2];
        const from = body && body.from;
        await ensureD1Schema(env.DB);
        await edgeRequireLead(env.DB, code, from);
        let co = await d1First(env.DB, "SELECT code, name, created_at, intro, tags, status, suspended_at, archived_at FROM companies WHERE code = ?", code);
        if (!co) {
          return json({ ok: false, error: `公司码不存在: ${code}` }, 404);
        }
        const cur = co.status || COMPANY_STATUS_ACTIVE;
        let tags = [];
        try { tags = co.tags ? JSON.parse(co.tags) : []; } catch (_) { tags = []; }
        const companyObj = {
          code: co.code, name: co.name, status: cur,
          suspended_at: co.suspended_at || null, archived_at: co.archived_at || null,
          created_at: co.created_at, intro: co.intro || "", tags,
        };
        let out;
        const receiptType = action === "suspend" ? "company_suspend" : action === "resume" ? "company_resume" : "company_archive";
        if (action === "suspend") {
          if (cur === COMPANY_STATUS_ARCHIVED) {
            return json({ ok: false, error: "公司已注销，不可休眠", company_status: COMPANY_STATUS_ARCHIVED }, 409);
          }
          const suspended_at = cur === COMPANY_STATUS_SUSPENDED ? (co.suspended_at || now()) : now();
          await d1Run(env.DB, "UPDATE companies SET status = ?, suspended_at = ? WHERE code = ?", COMPANY_STATUS_SUSPENDED, suspended_at, code);
          companyObj.status = COMPANY_STATUS_SUSPENDED;
          companyObj.suspended_at = suspended_at;
          out = {
            ok: true, already: cur === COMPANY_STATUS_SUSPENDED, company: companyObj,
            status: COMPANY_STATUS_SUSPENDED, label: "公司休眠",
            muse_action: {
              stop_heartbeat: true, wind_down: true, delete_data: false,
              pending_wake_timer: true, timer_name: "待唤醒",
              resume_path: `/api/companies/${code}/resume`,
              product_copy: "公司休眠 / 公司重开",
            },
            prompt: buildSuspendPrompt(base, companyObj),
            channel: "detect_via_renew_or_get", edge: true,
          };
        } else if (action === "resume") {
          if (cur === COMPANY_STATUS_ARCHIVED) {
            return json({ ok: false, error: "公司已注销，不可重开（终端态）", company_status: COMPANY_STATUS_ARCHIVED, reopen: false }, 409);
          }
          await d1Run(env.DB, "UPDATE companies SET status = ?, suspended_at = ? WHERE code = ?", COMPANY_STATUS_ACTIVE, 0, code);
          companyObj.status = COMPANY_STATUS_ACTIVE;
          companyObj.resumed_at = now();
          companyObj.suspended_at = null;
          out = {
            ok: true, already: cur === COMPANY_STATUS_ACTIVE, company: companyObj,
            status: COMPANY_STATUS_ACTIVE, label: "公司重开",
            muse_action: { restart_heartbeat: true, cancel_pending_wake: true, product_copy: "公司重开" },
            prompt: buildResumePrompt(base, companyObj),
            channel: "detect_via_renew_or_get", edge: true,
          };
        } else {
          if (cur === COMPANY_STATUS_ARCHIVED) {
            return json({ ok: false, error: "公司已注销", company_status: COMPANY_STATUS_ARCHIVED, reopen: false }, 409);
          }
          // Receipts before wipe so leads (and from) get company_archive
          try {
            await edgeNotifyLifecycleReceipts(env.DB, code, "company_archive", from, {
              status: COMPANY_STATUS_ARCHIVED, label: "公司注销", terminal: true,
            });
          } catch (re) { console.error("edge archive receipt", re && re.message); }
          const archived_at = now();
          try { await dbBatchDeleteCompany(env.DB, code); } catch (we) { console.error("edge archive wipe", we && we.message); }
          await d1Run(env.DB, "UPDATE companies SET status = ?, archived_at = ?, intro = ?, tags = ? WHERE code = ?", COMPANY_STATUS_ARCHIVED, archived_at, "", "[]", code);
          companyObj.status = COMPANY_STATUS_ARCHIVED;
          companyObj.archived_at = archived_at;
          companyObj.intro = "";
          companyObj.tags = [];
          out = {
            ok: true, company: companyObj, status: COMPANY_STATUS_ARCHIVED,
            label: "公司注销", terminal: true, reopen: false,
            wiped: { note: "edge D1 wipe (agents/tasks/invites)" },
            muse_action: {
              full_wipe: true, stop_heartbeat: true, delete_timers: true,
              delete_local_traces: true, reopen: false, product_copy: "公司注销",
            },
            prompt: buildArchiveWipePrompt(base, companyObj),
            channel: "prompt", edge: true,
            note: "必须经 invite-mcp 向当前已登录 Muse lane 投递 prompt。",
          };
        }
        if (action !== "archive") {
          try {
            await edgeNotifyLifecycleReceipts(env.DB, code, receiptType, from, {
              status: out.status, label: out.label,
            });
          } catch (re) { console.error("edge lifecycle receipt", re && re.message); }
        }
        // Best-effort: push same lifecycle into sticky DO so busy path sees status
        try {
          await withTimeout(stub.fetch(new Request(`${base}/api/companies/${encodeURIComponent(code)}/${action}`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ from }),
          })), 2500);
          out.do_synced = true;
        } catch (_) {
          out.do_synced = false;
          out.do_sync_note = "sticky DO sync timed out; D1 status + edge gates still enforce";
        }
        return json(out);
      } catch (le) {
        const st = (le && le.status) || 500;
        return json({ ok: false, error: (le && le.message) || String(le), ...(le && le.extra ? le.extra : {}), edge: true }, st);
      }
    }
  }

  // Invites
  if (url.pathname === "/api/role-packs" && method === "GET") {
    return json({ packs: listRolePacks(), plaza_source_of_truth: PLAZA_REGISTRY_URL });
  }
  if (url.pathname === "/api/invites" && method === "POST") {
    let body = null;
    try { body = await request.json(); } catch (_) { body = {}; }
    try {
      const invite = await edgeCreateInvite(env.DB, body || {}, base);
      return json(invite);
    } catch (e) {
      if (e instanceof HttpError) return json({ ok: false, error: e.message }, e.status);
      throw e;
    }
  }
  {
    const m = url.pathname.match(/^\/api\/invites\/([^/]+)$/);
    if (method === "GET" && m) {
      try {
        return json(await edgeGetInvite(env.DB, decodeURIComponent(m[1])));
      } catch (e) {
        if (e instanceof HttpError) return json({ ok: false, error: e.message }, e.status);
        throw e;
      }
    }
  }
  {
    const m = url.pathname.match(/^\/api\/invites\/([^/]+)\/redeem$/);
    if (method === "POST" && m) {
      let body = null;
      try { body = await request.json(); } catch (_) { body = {}; }
      try {
        return json(await edgeRedeemInvite(env.DB, stub, base, decodeURIComponent(m[1]), body || {}));
      } catch (e) {
        if (e instanceof HttpError) return json({ ok: false, error: e.message }, e.status);
        throw e;
      }
    }
  }

  // Receipts
  if (url.pathname === "/api/receipts" && method === "GET") {
    try {
      return json(await edgeListReceipts(env.DB, {
        doorplate: url.searchParams.get("doorplate"),
        company: url.searchParams.get("company") || url.searchParams.get("company_code"),
        type: url.searchParams.get("type") || "all",
        unread_only: url.searchParams.get("unread_only") === "1" || url.searchParams.get("unread_only") === "true",
        mark_read: url.searchParams.get("mark_read") === "1" || url.searchParams.get("mark_read") === "true",
      }));
    } catch (e) {
      if (e instanceof HttpError) return json({ ok: false, error: e.message }, e.status);
      throw e;
    }
  }
  {
    const m = url.pathname.match(/^\/api\/receipts\/([^/]+)\/read$/);
    if (method === "POST" && m) {
      let body = null;
      try { body = await request.json(); } catch (_) { body = {}; }
      await d1Run(env.DB, 'UPDATE receipts SET read = 1 WHERE id = ? AND "to" = ?', decodeURIComponent(m[1]), body.doorplate);
      return json({ ok: true, id: decodeURIComponent(m[1]) });
    }
  }

  // Edge gates: suspend/archive block claim / createTask / register(join)
  if (url.pathname === "/api/tasks" && method === "POST") {
    let body = null;
    try { body = await request.json(); } catch (_) { body = {}; }
    const code = (body && body.company_code) ? String(body.company_code).trim().toUpperCase() : "";
    if (code) {
      try { await edgeAssertCompanyActive(env.DB, code, "发单"); }
      catch (e) {
        if (e instanceof HttpError) return json({ ok: false, error: e.message, ...(e.extra || {}) }, e.status);
        throw e;
      }
    }
    const res = await stub.fetch(new Request(request.url, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}),
    }));
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return json(data, res.status);
  }
  if (url.pathname === "/api/agents/register" && method === "POST") {
    let body = null;
    try { body = await request.json(); } catch (_) { body = {}; }
    const code = (body && body.company_code) ? String(body.company_code).trim().toUpperCase() : "";
    // Only gate join; founding (no company_code) stays allowed
    if (code) {
      try { await edgeAssertCompanyActive(env.DB, code, "入驻/注册"); }
      catch (e) {
        if (e instanceof HttpError) return json({ ok: false, error: e.message, ...(e.extra || {}) }, e.status);
        throw e;
      }
    }
    const res = await stub.fetch(new Request(request.url, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}),
    }));
    let data = null;
    try { data = await res.json(); } catch (_) {}
    return json(data, res.status);
  }

  // Wrap claim/submit/review/broadcast to emit edge receipts
  {
    const m = url.pathname.match(/^\/api\/tasks\/([^/]+)\/(claim|submit|review)$/);
    if (method === "POST" && m) {
      const taskId = decodeURIComponent(m[1]);
      const action = m[2];
      let body = null;
      try { body = await request.json(); } catch (_) { body = {}; }
      if (action === "claim") {
        const claimerCo = (body && body.company_code) ? String(body.company_code).trim().toUpperCase() : "";
        try {
          if (claimerCo) await edgeAssertCompanyActive(env.DB, claimerCo, "抢单");
          // Also block claiming tasks owned by suspended/archived publisher when we can resolve from DO/D1
          try {
            const tres = await withTimeout(stub.fetch(new Request(`${base}/api/tasks/${encodeURIComponent(taskId)}`, { method: "GET" })), 2000);
            const td = await tres.json().catch(() => null);
            if (tres.ok && td && td.company) await edgeAssertCompanyActive(env.DB, td.company, "抢单（发单方公司）");
          } catch (ge) {
            if (ge instanceof HttpError) throw ge;
          }
        } catch (e) {
          if (e instanceof HttpError) return json({ ok: false, error: e.message, ...(e.extra || {}) }, e.status);
          throw e;
        }
      }
      const res = await stub.fetch(new Request(request.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      }));
      let data = null;
      try { data = await res.json(); } catch (_) {}
      if (res.ok && env.DB) {
        try {
          if (action === "claim") {
            const claimBody = { task_id: taskId, title: data.title, claimer: body.doorplate, claim_company: data.claim_company };
            await edgePushReceipt(env.DB, {
              type: "claim_ok",
              company: data.company,
              to: body.doorplate,
              from: body.doorplate,
              ref: { task_id: taskId },
              body: claimBody,
            });
            try {
              const agentsRes = await stub.fetch(new Request(`${base}/api/agents?company=${encodeURIComponent(data.company)}`, { method: "GET" }));
              const agentsData = await agentsRes.json().catch(() => ({ agents: [] }));
              const leads = (agentsData.agents || []).filter((a) => a.role === "lead");
              for (const lead of (leads.length ? leads : (agentsData.agents || []).slice(0, 1))) {
                if (lead.doorplate === body.doorplate) continue;
                await edgePushReceipt(env.DB, {
                  type: "claim_ok",
                  company: data.company,
                  to: lead.doorplate,
                  from: body.doorplate,
                  ref: { task_id: taskId },
                  body: claimBody,
                });
              }
            } catch (_) {}
          } else if (action === "submit") {
            // attach delivery envelope if missing
            if (data && data.result != null && !data.delivery) {
              data.delivery = buildDeliveryEnvelope(data);
            }
            const submitBody = {
              task_id: taskId,
              title: data.title,
              task_type: data.task_type || "general",
              has_delivery: data.result != null,
            };
            await edgePushReceipt(env.DB, {
              type: "submit_ok",
              company: data.claim_company || body.company_code,
              to: body.doorplate,
              from: body.doorplate,
              ref: { task_id: taskId },
              body: submitBody,
            });
            try {
              const agentsRes = await stub.fetch(new Request(`${base}/api/agents?company=${encodeURIComponent(data.company)}`, { method: "GET" }));
              const agentsData = await agentsRes.json().catch(() => ({ agents: [] }));
              const leads = (agentsData.agents || []).filter((a) => a.role === "lead");
              for (const lead of (leads.length ? leads : (agentsData.agents || []).slice(0, 1))) {
                await edgePushReceipt(env.DB, {
                  type: "submit_ok",
                  company: data.company,
                  to: lead.doorplate,
                  from: body.doorplate,
                  ref: { task_id: taskId },
                  body: submitBody,
                });
              }
            } catch (_) {}
          } else if (action === "review") {
            if (!body.approved) {
              try { await edgeClearTaskAssigned(env.DB, taskId); } catch (_) {}
            }
            const typ = body.approved ? "review_pass" : "review_reject";
            let owner = data.owner;
            if (!owner) {
              try {
                const before = await stub.fetch(new Request(`${base}/api/tasks/${encodeURIComponent(taskId)}`, { method: "GET" }));
                // too late — already reviewed. Prefer owner from submit_ok receipts skip.
              } catch (_) {}
            }
            // On approve, owner remains; on reject DO clears owner — also notify claimant company via claim_company if present
            const targets = new Set();
            if (data.owner) targets.add(data.owner);
            // Heuristic: if approved, owner is present; if rejected, try body.doorplate unused
            if (!targets.size && body && body.notify_doorplate) targets.add(body.notify_doorplate);
            for (const to of targets) {
              await edgePushReceipt(env.DB, {
                type: typ,
                company: data.company,
                to,
                from: null,
                ref: { task_id: taskId },
                body: { task_id: taskId, title: data.title, note: body.note || null, approved: !!body.approved },
              });
            }
          }
        } catch (re) { console.error("edge receipt wrap", re && re.message); }
      }
      return json(data, res.status);
    }
  }
  if (url.pathname === "/api/mail/broadcast" && method === "POST") {
    let body = null;
    try { body = await request.json(); } catch (_) { body = {}; }
    const res = await stub.fetch(new Request(request.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    }));
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (res.ok && env.DB && body.company_code) {
      try {
        const agentsRes = await stub.fetch(new Request(`${base}/api/agents?company=${encodeURIComponent(body.company_code)}`, { method: "GET" }));
        const agentsData = await agentsRes.json().catch(() => ({ agents: [] }));
        for (const a of agentsData.agents || []) {
          await edgePushReceipt(env.DB, {
            type: "broadcast",
            company: body.company_code,
            to: a.doorplate,
            from: body.from,
            ref: {},
            body: { text: String(body.text || "").slice(0, 500) },
          });
        }
      } catch (be) { console.error("edge broadcast receipt", be && be.message); }
    }
    return json(data, res.status);
  }

  // POST /api/tasks — edge assign_to (sticky-DO resilient)
  if (url.pathname === "/api/tasks" && method === "POST") {
    let body = null;
    try { body = await request.json(); } catch (_) { body = {}; }
    try {
      if (body && body.assign_to) {
        const out = await edgeCreateTaskWithAssign(env, stub, base, body);
        return json(out.data, out.status);
      }
      // No assign_to: pass through; still enrich assigned=false consistently when DO new
      const res = await stub.fetch(new Request(request.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body || {}),
      }));
      let data = null;
      try { data = await res.json(); } catch (_) {}
      return json(data, res.status);
    } catch (e) {
      if (e instanceof HttpError) return json({ ok: false, error: e.message, ...(e.extra || {}) }, e.status);
      throw e;
    }
  }

  // Enrich single task GET with delivery envelope + assigned flag from D1
  {
    const m = url.pathname.match(/^\/api\/tasks\/([^/]+)$/);
    if (method === "GET" && m) {
      const taskId = decodeURIComponent(m[1]);
      const res = await stub.fetch(request);
      let data = null;
      try { data = await res.json(); } catch (_) {}
      if (res.ok && data && data.result != null && !data.delivery) {
        data.delivery = buildDeliveryEnvelope(data);
      }
      if (res.ok && data && env.DB) {
        try {
          const row = await edgeGetTaskAssigned(env.DB, taskId);
          data = enrichTaskAssigned(data, row);
        } catch (_) {}
      }
      return json(data, res.status);
    }
  }

  // Enrich plaza list with assigned flags
  if (url.pathname === "/api/plaza" && method === "GET") {
    const res = await stub.fetch(request);
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (res.ok && data && Array.isArray(data.tasks) && env.DB) {
      try {
        await ensureD1Schema(env.DB);
        const ids = data.tasks.map((t) => t && t.id).filter(Boolean);
        if (ids.length) {
          // D1 has no great IN bind helper — fetch rows one by one for small plaza pages
          for (let i = 0; i < data.tasks.length; i++) {
            const t = data.tasks[i];
            if (!t || !t.id) continue;
            const row = await edgeGetTaskAssigned(env.DB, t.id);
            data.tasks[i] = enrichTaskAssigned(t, row);
          }
        }
      } catch (_) {}
    }
    return json(data, res.status);
  }

  // Clear assign mark on reject (review approved=false)
  {
    const m = url.pathname.match(/^\/api\/tasks\/([^/]+)\/review$/);
    if (method === "POST" && m) {
      // fall through to existing review handler below if any; also clear after
    }
  }
} catch (edgeErr) {
  console.error("edge route error", edgeErr && edgeErr.message);
}

return stub.fetch(request);
},
};
