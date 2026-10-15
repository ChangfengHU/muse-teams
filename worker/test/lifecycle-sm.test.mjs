/** Pure state-machine expectations for company lifecycle (no CF runtime). */
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

assert.equal(nextStatus(ACTIVE, "suspend"), SUSPENDED);
assert.equal(nextStatus(SUSPENDED, "resume"), ACTIVE);
assert.equal(nextStatus(SUSPENDED, "archive"), ARCHIVED);
assert.equal(nextStatus(ACTIVE, "archive"), ARCHIVED);
assert.throws(() => nextStatus(ARCHIVED, "resume"), /不可重开/);
assert.throws(() => nextStatus(ARCHIVED, "suspend"), /不可休眠/);
console.log("lifecycle-sm.test.mjs OK");
