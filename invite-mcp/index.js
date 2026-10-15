/**
 * Muse Teams Invite Channel MCP — skeleton
 * Compose invites via Teams API; deliver is channel-specific placeholder.
 */
import { createInterface } from "node:readline";

const TEAMS_API = process.env.TEAMS_API_URL || "https://teams.vyibc.com";
const TEAMS_MCP = process.env.TEAMS_MCP_URL || "https://teams.vyibc.com/mcp";

const deliveryLog = new Map(); // delivery_id -> record

function loadTargets() {
  try {
    const raw = process.env.INVITE_TARGETS_JSON;
    if (raw) return JSON.parse(raw);
  } catch (_) { /* ignore */ }
  return [
    { id: "target-demo-1", label: "demo Muse Linux (placeholder)", kind: "muse_linux", status: "stub" },
  ];
}

async function teamsCreateInvite(args) {
  const res = await fetch(`${TEAMS_API}/api/invites`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function teamsListReceipts({ doorplate, company_code, type = "invite_ack" }) {
  const q = new URLSearchParams({
    doorplate,
    company: company_code,
    type,
  });
  const res = await fetch(`${TEAMS_API}/api/receipts?${q}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const TOOLS = [
  {
    name: "invite_list_targets",
    description: "List channel targets that can receive Muse invite prompts (Linux sessions logged into Muse). Skeleton returns configured stubs.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "invite_compose",
    description: "Create a Teams proxy-onboard invite (teams_create_invite) and return invite_id + prompt text. Does not deliver.",
    inputSchema: {
      type: "object",
      properties: {
        company_code: { type: "string" },
        from: { type: "string" },
        role: { type: "string" },
        specialties: { type: "array", items: { type: "string" } },
        target_hint: { type: "string" },
        note: { type: "string" },
      },
      required: ["company_code"],
    },
  },
  {
    name: "invite_deliver",
    description: "Deliver invite prompt to a channel target. Placeholder records attempt; wire to Muse session inject like image-gen delivery.",
    inputSchema: {
      type: "object",
      properties: {
        invite_id: { type: "string" },
        target_id: { type: "string" },
        prompt: { type: "string", description: "Optional override; default fetch invite.prompt from Teams" },
      },
      required: ["invite_id", "target_id"],
    },
  },
  {
    name: "invite_status",
    description: "Check a delivery attempt status by delivery_id or invite_id.",
    inputSchema: {
      type: "object",
      properties: {
        delivery_id: { type: "string" },
        invite_id: { type: "string" },
      },
    },
  },
  {
    name: "invite_ack_poll",
    description: "Poll Teams receipt box for invite_ack (and invite_sent) so company perceives successful 代企业入驻.",
    inputSchema: {
      type: "object",
      properties: {
        doorplate: { type: "string" },
        company_code: { type: "string" },
        invite_id: { type: "string", description: "Optional filter" },
      },
      required: ["doorplate", "company_code"],
    },
  },
];

async function callTool(name, args = {}) {
  switch (name) {
    case "invite_list_targets":
      return { targets: loadTargets(), note: "stub — configure INVITE_TARGETS_JSON or wire fleet discovery" };
    case "invite_compose": {
      const invite = await teamsCreateInvite(args);
      return {
        invite_id: invite.invite_id,
        company_code: invite.company_code,
        prompt: invite.prompt,
        status: invite.status,
        specialties: invite.specialties,
        teams_api: `${TEAMS_API}/api/invites/${invite.invite_id}`,
      };
    }
    case "invite_deliver": {
      const targets = loadTargets();
      const target = targets.find((t) => t.id === args.target_id);
      if (!target) throw new Error(`unknown target: ${args.target_id}`);
      let prompt = args.prompt;
      if (!prompt) {
        const res = await fetch(`${TEAMS_API}/api/invites/${encodeURIComponent(args.invite_id)}`);
        const inv = await res.json();
        if (!res.ok) throw new Error(inv.error || `HTTP ${res.status}`);
        prompt = inv.prompt;
      }
      const delivery_id = `D-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const record = {
        delivery_id,
        invite_id: args.invite_id,
        target_id: args.target_id,
        target,
        status: "recorded_stub",
        prompt_preview: String(prompt || "").slice(0, 200),
        at: Date.now(),
        note: "Channel deliver is a stub. Wire to Muse Linux session inject (same pattern as muse image gen delivery).",
      };
      deliveryLog.set(delivery_id, record);
      return record;
    }
    case "invite_status": {
      if (args.delivery_id && deliveryLog.has(args.delivery_id)) return deliveryLog.get(args.delivery_id);
      if (args.invite_id) {
        const hits = [...deliveryLog.values()].filter((r) => r.invite_id === args.invite_id);
        return { invite_id: args.invite_id, deliveries: hits };
      }
      return { deliveries: [...deliveryLog.values()] };
    }
    case "invite_ack_poll": {
      const data = await teamsListReceipts({
        doorplate: args.doorplate,
        company_code: args.company_code,
        type: "invite_ack",
      });
      let receipts = data.receipts || [];
      if (args.invite_id) {
        receipts = receipts.filter((r) => r.ref && r.ref.invite_id === args.invite_id);
      }
      return { ...data, receipts, teams_mcp: TEAMS_MCP };
    }
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

function ok(id, result) {
  return { jsonrpc: "2.0", id, result };
}
function err(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

async function handle(msg) {
  const id = msg && msg.id !== undefined ? msg.id : null;
  try {
    if (msg.method === "initialize") {
      return ok(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "muse-teams-invite", version: "0.1.0" },
      });
    }
    if (msg.method === "notifications/initialized") return ok(id, {});
    if (msg.method === "tools/list") return ok(id, { tools: TOOLS });
    if (msg.method === "tools/call") {
      const p = msg.params || {};
      const out = await callTool(p.name, p.arguments || {});
      return ok(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
    }
    return err(id, -32601, `unknown method: ${msg.method}`);
  } catch (e) {
    return err(id, -32602, e.message || String(e));
  }
}

// stdio JSON-RPC loop
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
rl.on("line", async (line) => {
  const trimmed = String(line || "").trim();
  if (!trimmed) return;
  let msg;
  try { msg = JSON.parse(trimmed); } catch (_) {
    process.stdout.write(JSON.stringify(err(null, -32700, "parse error")) + "\n");
    return;
  }
  const res = await handle(msg);
  process.stdout.write(JSON.stringify(res) + "\n");
});

if (process.argv.includes("--self-test")) {
  const r1 = await callTool("invite_list_targets", {});
  console.error("self-test targets", r1.targets.length);
  process.exit(0);
}
