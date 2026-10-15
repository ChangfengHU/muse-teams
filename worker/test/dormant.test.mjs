/** Pure dormant derivation: employee status + company heartbeat_dormant (no CF runtime). */
import assert from "node:assert/strict";

const HEARTBEAT_TTL_MS = 180_000;
const ARCHIVED = "archived";
const ACTIVE = "active";

function statusOf(a, ts = Date.now()) {
  if (!a || !a.last_heartbeat) return "dormant";
  if (ts - a.last_heartbeat > HEARTBEAT_TTL_MS) return "dormant";
  return a.current_task ? "busy" : "online";
}

function isLive(a, ts = Date.now()) {
  const st = statusOf(a, ts);
  return st === "online" || st === "busy";
}

function companyHeartbeatDormant({ status, agents }, ts = Date.now()) {
  if ((status || ACTIVE) === ARCHIVED) return true;
  return !(agents || []).some((a) => isLive(a, ts));
}

const ts = 1_000_000_000_000;

assert.equal(statusOf({ last_heartbeat: null }, ts), "dormant");
assert.equal(statusOf({ last_heartbeat: ts - HEARTBEAT_TTL_MS - 1 }, ts), "dormant");
assert.equal(statusOf({ last_heartbeat: ts - 1000 }, ts), "online");
assert.equal(statusOf({ last_heartbeat: ts - 1000, current_task: "T-1" }, ts), "busy");

assert.equal(companyHeartbeatDormant({ status: ACTIVE, agents: [] }, ts), true);
assert.equal(companyHeartbeatDormant({
  status: ACTIVE,
  agents: [{ last_heartbeat: ts - HEARTBEAT_TTL_MS - 1 }],
}, ts), true);
assert.equal(companyHeartbeatDormant({
  status: ACTIVE,
  agents: [{ last_heartbeat: ts - 1000 }],
}, ts), false);
assert.equal(companyHeartbeatDormant({
  status: ARCHIVED,
  agents: [{ last_heartbeat: ts - 1000 }],
}, ts), true);

// Manual suspended does NOT flip derived flag by itself — only live heartbeats matter
assert.equal(companyHeartbeatDormant({
  status: "suspended",
  agents: [{ last_heartbeat: ts - 1000 }],
}, ts), false);

console.log("dormant.test.mjs OK");
