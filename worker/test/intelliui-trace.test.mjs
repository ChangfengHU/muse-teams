/** Pure IntelliUI timeline/v1 builder + empty-roster auth expectation (no CF runtime). */
import assert from "node:assert/strict";

function buildIntelliUiTimeline(trace) {
  if (!trace || !Array.isArray(trace.stages)) return null;
  const durations = trace.durations_ms || {};
  const edgeKey = {
    "created->claimed": "pending_to_claim",
    "plaza->claimed": "pending_to_claim",
    "claimed->submitted": "claim_to_submit",
    "submitted->reviewed": "submit_to_done",
  };
  const events = trace.stages.map((s, i, arr) => {
    const next = arr[i + 1];
    let status = "pending";
    if (s.at != null) status = "done";
    if (s.stage === "reviewed" && s.payload && s.payload.approved === false) status = "rejected";
    if (s.at == null && i > 0 && arr[i - 1] && arr[i - 1].at != null) status = "live";
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
    schema: "intelliui/timeline/v1",
    kind: "timeline",
    title: `${trace.task_id || ""} · ${trace.title || ""}`.trim(),
    subtitle: trace.status || null,
    task_id: trace.task_id || null,
    events,
    summary: { durations_ms: durations },
  };
}

function requireLeadEmptyRoster(members, from) {
  if (!from || !String(from).trim()) {
    const e = new Error("需要 from");
    e.status = 403;
    throw e;
  }
  if (!members.length) {
    const e = new Error("公司暂无成员，无法做生命周期操作");
    e.status = 403;
    throw e;
  }
  return members[0];
}

const trace = {
  task_id: "T-1022",
  title: "demo",
  status: "claimed",
  stages: [
    { stage: "created", label: "发单", at: 1000, actor: null, payload: {} },
    { stage: "plaza", label: "进广场", at: 1000, actor: null, payload: {} },
    { stage: "claimed", label: "抢单", at: 2500, actor: { doorplate: "muse-20" }, payload: { cross_company: true } },
    { stage: "submitted", label: "交单", at: null, actor: null, payload: {} },
    { stage: "reviewed", label: "验收", at: null, actor: null, payload: {} },
  ],
  durations_ms: { pending_to_claim: 1500, claim_to_submit: null, submit_to_done: null, total: null },
};

const iu = buildIntelliUiTimeline(trace);
assert.equal(iu.schema, "intelliui/timeline/v1");
assert.equal(iu.kind, "timeline");
assert.equal(iu.events.length, 5);
assert.equal(iu.events[0].status, "done");
assert.equal(iu.events[2].status, "done");
assert.equal(iu.events[2].duration_ms, null); // next submitted has no at
assert.equal(iu.events[3].status, "live");
assert.equal(iu.events[4].status, "pending");
// created→plaza same ts → 0; plaza→claimed uses pending_to_claim=1500
assert.equal(iu.events.find((e) => e.id === "created").duration_ms, 0);
assert.equal(iu.events.find((e) => e.id === "plaza").duration_ms, 1500);

assert.throws(() => requireLeadEmptyRoster([], "anyone"), /暂无成员/);
assert.equal(requireLeadEmptyRoster([{ doorplate: "muse-01" }], "muse-01").doorplate, "muse-01");

console.log("intelliui-trace.test.mjs OK");
