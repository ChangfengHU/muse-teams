/** Pure state-machine + gate/anti-resurrect expectations for company lifecycle (no CF runtime). */
import assert from "node:assert/strict";

const ACTIVE = "active";
const SUSPENDED = "suspended";
const ARCHIVED = "archived";

function nextStatus(current, action) {
  if (action === "suspend") {
    if (current === ARCHIVED) throw Object.assign(new Error("不可休眠"), { status: 409 });
    return SUSPENDED;
  }
  if (action === "resume") {
    if (current === ARCHIVED) throw Object.assign(new Error("不可重开"), { status: 409 });
    if (current === ACTIVE) return ACTIVE;
    return ACTIVE;
  }
  if (action === "archive") {
    if (current === ARCHIVED) throw Object.assign(new Error("已注销"), { status: 409 });
    return ARCHIVED;
  }
  throw new Error("unknown action");
}

/** Mirror assertCompanyActiveStatus: suspended→403, archived→409 */
function assertCompanyActiveStatus(status, verb) {
  const st = status || ACTIVE;
  if (st === ARCHIVED) {
    const e = new Error(`公司已注销，无法${verb}`);
    e.status = 409;
    throw e;
  }
  if (st === SUSPENDED) {
    const e = new Error(`公司已休眠，无法${verb}`);
    e.status = 403;
    throw e;
  }
  return st;
}

function requireFrom(from) {
  if (!from || !String(from).trim()) {
    const e = new Error("需要 from（本公司 lead 门牌号）");
    e.status = 403;
    throw e;
  }
  return String(from).trim();
}

/** Mirror syncStateToD1 anti-resurrect: skip agents/tasks for archived codes; keep tombstone */
function syncPreview({ companiesDo, agentsDo, tasksDo, prevStatus }) {
  const rank = { active: 0, suspended: 1, archived: 2 };
  const archivedCodes = new Set();
  const outCompanies = [];
  for (const c of companiesDo) {
    const prev = prevStatus[c.code] || {};
    let status = c.status || ACTIVE;
    if (prev.status && (rank[prev.status] || 0) > (rank[status] || 0)) status = prev.status;
    if (status === ARCHIVED || prev.status === ARCHIVED) archivedCodes.add(c.code);
    outCompanies.push({ code: c.code, status });
  }
  for (const [code, prev] of Object.entries(prevStatus)) {
    if (prev.status === ARCHIVED) {
      archivedCodes.add(code);
      if (!outCompanies.some((c) => c.code === code)) {
        outCompanies.push({ code, status: ARCHIVED });
      }
    }
  }
  const agents = agentsDo.filter((a) => !(a.company && archivedCodes.has(a.company)));
  const tasks = tasksDo.filter((t) => !(t.company && archivedCodes.has(t.company)));
  return { companies: outCompanies, agents, tasks, archivedCodes: [...archivedCodes] };
}

assert.equal(nextStatus(ACTIVE, "suspend"), SUSPENDED);
assert.equal(nextStatus(SUSPENDED, "resume"), ACTIVE);
assert.equal(nextStatus(SUSPENDED, "archive"), ARCHIVED);
assert.equal(nextStatus(ACTIVE, "archive"), ARCHIVED);
assert.throws(() => nextStatus(ARCHIVED, "resume"), /不可重开/);
assert.throws(() => nextStatus(ARCHIVED, "suspend"), /不可休眠/);

assert.equal(assertCompanyActiveStatus(ACTIVE, "抢单"), ACTIVE);
assert.throws(() => assertCompanyActiveStatus(SUSPENDED, "抢单"), (e) => e.status === 403 && /休眠/.test(e.message));
assert.throws(() => assertCompanyActiveStatus(ARCHIVED, "发单"), (e) => e.status === 409 && /注销/.test(e.message));
assert.throws(() => requireFrom(null), (e) => e.status === 403);
assert.throws(() => requireFrom(""), (e) => e.status === 403);
assert.equal(requireFrom("muse-01"), "muse-01");

{
  const out = syncPreview({
    companiesDo: [{ code: "C-AAAA", status: ACTIVE }],
    agentsDo: [{ doorplate: "muse-01", company: "C-AAAA" }],
    tasksDo: [{ id: "T-1", company: "C-AAAA" }],
    prevStatus: { "C-AAAA": { status: ARCHIVED, archived_at: 1 } },
  });
  assert.equal(out.companies.find((c) => c.code === "C-AAAA").status, ARCHIVED);
  assert.equal(out.agents.length, 0, "archived must not resurrect agents");
  assert.equal(out.tasks.length, 0, "archived must not resurrect tasks");
}

{
  const out = syncPreview({
    companiesDo: [],
    agentsDo: [{ doorplate: "muse-99", company: "C-GONE" }],
    tasksDo: [{ id: "T-9", company: "C-GONE" }],
    prevStatus: { "C-GONE": { status: ARCHIVED, archived_at: 2 } },
  });
  assert.ok(out.companies.some((c) => c.code === "C-GONE" && c.status === ARCHIVED));
  assert.equal(out.agents.length, 0);
  assert.equal(out.tasks.length, 0);
}

console.log("lifecycle-sm.test.mjs OK");
