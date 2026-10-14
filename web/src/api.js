// Muse Teams API client
// Base: https://teams.vyibc.com
// v2: 公司码租户隔离 — 所有请求都带当前公司码

const API = 'https://teams.vyibc.com';
const COMPANY_KEY = 'muse-teams-company';

export function getCompany() {
  return localStorage.getItem(COMPANY_KEY) || '';
}
export function setCompany(code) {
  if (code) localStorage.setItem(COMPANY_KEY, code.trim().toUpperCase());
  else localStorage.removeItem(COMPANY_KEY);
}
function needCompany() {
  const c = getCompany();
  if (!c) throw new Error('请先选择公司（输入公司码进入）');
  return c;
}

async function request(path, method = 'GET', body) {
let res;
try {
res = await fetch(API + path, {
method,
headers: { 'Content-Type': 'application/json'},
body: body? JSON.stringify(body): undefined,
});
} catch (e) {
const err = new Error('网络请求失败');
err.network = true;
throw err;
}
let data = null;
try { data = await res.json();} catch (e) { /* ignore */}
if (!res.ok) {
const err = new Error((data && (data.error || data.message)) || ('HTTP ' + res.status));
err.status = res.status;
err.data = data;
throw err;
}
return data;
}

export const api = {
// 公司
createCompany: (name) =>
  request('/api/companies', 'POST', { name }),
getCompanyInfo: (code) =>
  request(`/api/companies/${encodeURIComponent(code.trim().toUpperCase())}`),

// 只读（全部按公司过滤）
agents: () => request(`/api/agents?company=${encodeURIComponent(needCompany())}`),
tasks: (status) => request(`/api/tasks?status=${status}&company=${encodeURIComponent(needCompany())}`),
feed: () => request(`/api/feed?company=${encodeURIComponent(needCompany())}`),
invite: (role) => {
  const c = needCompany();
  return request('/api/invite?company=' + encodeURIComponent(c) + (role ? `&role=${encodeURIComponent(role)}` : ''));
},
health: () => request('/api/health'),

// 写入（全部带公司码）
createTask: ({ title, desc, priority }) =>
  request('/api/tasks', 'POST', { title, desc, priority, company_code: needCompany() }),
claimTask: (taskId, doorplate) =>
  request(`/api/tasks/${encodeURIComponent(taskId)}/claim`, 'POST', { doorplate, company_code: needCompany() }),
submitTask: (taskId, doorplate, artifacts) =>
  request(`/api/tasks/${encodeURIComponent(taskId)}/submit`, 'POST', { doorplate, artifacts, company_code: needCompany() }),
reviewTask: (taskId, approved, note) =>
  request(`/api/tasks/${encodeURIComponent(taskId)}/review`, 'POST', { approved, note, company_code: needCompany() }),
deleteTask: (taskId, from) =>
  request(`/api/tasks/${encodeURIComponent(taskId)}?company=${encodeURIComponent(needCompany())}&from=${encodeURIComponent(from)}`, 'DELETE'),
deleteAgent: (doorplate, from) =>
  request(`/api/agents/${encodeURIComponent(doorplate)}?company=${encodeURIComponent(needCompany())}&from=${encodeURIComponent(from)}`, 'DELETE'),
sendMail: ({ from, to, text, task_id }) =>
  request('/api/mail/send', 'POST', { from, to, text, task_id, company_code: needCompany() }),
broadcast: (from, text) =>
  request('/api/mail/broadcast', 'POST', { from, text, company_code: needCompany() }),
readInbox: (doorplate) =>
  request(`/api/mail/${encodeURIComponent(doorplate)}?company=${encodeURIComponent(needCompany())}`),

/** 一次拉全量：agents + 四种状态 tasks + feed */
async refreshAll() {
const [agentsRes, pending, claimed, review, done, feedRes] = await Promise.all([
this.agents(),
this.tasks('pending'),
this.tasks('claimed'),
this.tasks('review'),
this.tasks('done'),
this.feed(),
]);
return {
agents: agentsRes.agents || [],
tasks: [
...(pending.tasks || []),
...(claimed.tasks || []),
...(review.tasks || []),
...(done.tasks || []),
],
feed: feedRes.feed || [],
};
},
};

// ---------- 工具函数 ----------
export function relTime(ts) {
if (!ts) return '从未';
const s = Math.floor((Date.now() - ts) / 1000);
if (s < 10) return '刚刚';
if (s < 60) return s + ' 秒前';
const m = Math.floor(s / 60);
if (m < 60) return m + ' 分钟前';
const h = Math.floor(m / 60);
if (h < 24) return h + ' 小时前';
return Math.floor(h / 24) + ' 天前';
}

export function fmtTime(ts) {
if (!ts) return '';
return new Date(ts).toLocaleString('zh-CN', {
month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
}

export function durStr(ms) {
if (ms == null || ms < 0) return '';
const s = Math.floor(ms / 1000);
if (s < 60) return s + ' 秒';
const m = Math.floor(s / 60);
if (m < 60) return m + ' 分钟';
const h = Math.floor(m / 60);
if (h < 48) return h + ' 小时';
return Math.floor(h / 24) + ' 天';
}

export function esc(s) {
return String(s == null? '': s);
}

// 任务状态元信息
export const ST_META = {
pending: { label: '📥 待认领', order: 0},
claimed: { label: '🏃 进行中', order: 1},
review: { label: '🧪 待验收', order: 2},
'done-pending-review': { label: '🧪 待验收', order: 2},
done: { label: '✅ 已完成', order: 3},
failed: { label: '💥 失败了', order: 4},
};

export function stKey(t) {
const s = t.status;
return s === 'done-pending-review'? 'review': s;
}

// ---------- 任务模板 ----------
export const TASK_TEMPLATES = {
img: {
label: '🎨 生图任务',
title: '生图：',
pri: 'P1',
desc: `
（例：一只奶油色小毛怪，戴着耳机，抱着纸飞机）


（例：3D 渲染 / 水彩 / 赛博朋克 / 写实摄影）


（例：1:1 正方形，居中，特写）


（有就贴链接，没有删掉这行）


- 主体清晰，无多余手指/肢体
- 风格统一，无违和元素
- 提交原图 + 生成提示词原文`,
},
copy: {
label: '✍️ 写文案',
title: '文案：',
pri: 'P1',
desc: `
（例：公众号推文 / X thread / 产品介绍页）


（例：AI 开发者，偏技术向）


1.
2.


- 中文，口语化，不说教
- 带 3 个不同角度的标题备选`,
},
code: {
label: '💻 代码任务',
title: '代码：',
pri: 'P1',
desc: `



（例：Python 单文件，不引入新依赖）


- 可运行，有基本错误处理
- 关键逻辑写注释`,
},
research: {
label: '🔍 研究任务',
title: '研究：',
pri: 'P2',
desc: `



（例：一页纸结论 + 3 个来源链接）


- 结论先行，注明信息时效
- 不确定的标出来，不编`,
},
};
