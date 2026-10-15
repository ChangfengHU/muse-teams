/** muse_account / muse_session normalize + round-trip shape (no CF runtime). */
import assert from "node:assert/strict";

function normMuseField(v) {
  if (v == null) return null;
  return String(v).trim().slice(0, 128) || null;
}

function pubAgent(a) {
  return {
    doorplate: a.doorplate,
    muse_account: a.muse_account || null,
    muse_session: a.muse_session || null,
  };
}

assert.equal(normMuseField(null), null);
assert.equal(normMuseField(undefined), null);
assert.equal(normMuseField(""), null);
assert.equal(normMuseField("  "), null);
assert.equal(normMuseField("  alice@muse.ai  "), "alice@muse.ai");
assert.equal(normMuseField("x".repeat(200)).length, 128);

const registered = {
  doorplate: "muse-99",
  muse_account: normMuseField("ops@example.com"),
  muse_session: normMuseField("豆包 🫘 · 测试窝"),
};
const out = pubAgent(registered);
assert.equal(out.muse_account, "ops@example.com");
assert.equal(out.muse_session, "豆包 🫘 · 测试窝");

const redeemFields = {
  muse_account: "acct-1",
  muse_session: "session-sidechat-A",
};
const afterRedeem = pubAgent({
  doorplate: "muse-01",
  muse_account: normMuseField(redeemFields.muse_account),
  muse_session: normMuseField(redeemFields.muse_session),
});
assert.deepEqual(afterRedeem, {
  doorplate: "muse-01",
  muse_account: "acct-1",
  muse_session: "session-sidechat-A",
});

console.log("muse-identity.test.mjs OK");
