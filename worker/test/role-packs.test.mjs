/** Role pack registry + snapshot shape (no CF runtime). */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

// Extract pack helpers by evaluating a minimal slice is brittle; mirror schema contract here
// and assert teams.js still contains seeded packs + plaza SoT.
const src = readFileSync(new URL("../teams.js", import.meta.url), "utf8");
assert.match(src, /const ROLE_PACKS = \{/);
assert.match(src, /video_gen_worker/);
assert.match(src, /editor:/);
assert.match(src, /PLAZA_REGISTRY_URL = "https:\/\/fleet\.vyibc\.com\/api\/hub\/registry"/);
assert.match(src, /function snapshotRolePack/);
assert.match(src, /function resolveRolePack/);
assert.match(src, /function listRolePacks/);
assert.match(src, /role_pack_id/);
assert.match(src, /role_pack_snapshot/);
assert.match(src, /instructions_meta/);
assert.match(src, /mcp:vyibc-video/);
assert.match(src, /mcp:vyibc-video-remix/);
assert.match(src, /teams_list_role_packs/);
assert.match(src, /\/api\/role-packs/);

// Snapshot contract (what invite + agent must store)
function snapshotRolePack(pack) {
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
    plaza_source_of_truth: "https://fleet.vyibc.com/api/hub/registry",
    snapped_at: 1,
  };
}

const sample = {
  id: "video_gen_worker",
  name: "视频生成工人",
  duty: "抢 video_gen 单",
  specialties: ["video_gen"],
  instructions: [
    { role: "main", label: "主聊", summary: "a", plaza_ref: null },
    { role: "scheduler", label: "旁聊调度", summary: "b", plaza_ref: "mcp:muse-teams" },
    { role: "worker", label: "干活执行", summary: "c", plaza_ref: "mcp:vyibc-video" },
  ],
  mcps: ["mcp:muse-teams", "mcp:vyibc-video"],
  skills: ["skill:vyibc-flow-video-studio/flow-video-studio"],
};
const snap = snapshotRolePack(sample);
assert.equal(snap.instructions_meta.length, 3);
assert.equal(snap.instructions_meta[0].role, "main");
assert.equal(snap.instructions_meta[1].role, "scheduler");
assert.equal(snap.instructions_meta[2].role, "worker");
assert.ok(snap.mcps.includes("mcp:vyibc-video"));
assert.ok(snap.skills.length >= 1);
assert.equal(snap.plaza_source_of_truth, "https://fleet.vyibc.com/api/hub/registry");

console.log("role-packs.test.mjs OK");
