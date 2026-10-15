/**
 * Muse Teams Invite Channel MCP — Streamable HTTP (Cloudflare Worker)
 * Separate from core Teams MCP (https://teams.vyibc.com/mcp).
 *
 * Deliver targets = currently logged-in Muse browser lanes (when FLEET_API_URL
 * is set); otherwise configured INVITE_TARGETS_JSON / stub.
 * Also delivers lifecycle prompts (公司休眠 / 公司注销 / 公司重开).
 */
const TEAMS_API_DEFAULT = "https://teams.vyibc.com";
const TEAMS_MCP_DEFAULT = "https://teams.vyibc.com/mcp";

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "Content-Type, Authorization, MCP-Protocol-Version, Accept",
  "access-control-max-age": "86400",
};

const json = (o, st = 200) =>
  new Response(JSON.stringify(o), {
    status: st,
    headers: { "content-type": "application/json; charset=utf-8", ...CORS },
  });

function loadConfiguredTargets(env) {
  try {
    const raw = env.INVITE_TARGETS_JSON;
    if (raw) return JSON.parse(raw);
  } catch (_) { /* ignore */ }
  return null;
}

/** Prefer fleet lanes that currently have Muse logged in. Never triggers heal/swap. */
async function discoverLoggedInMuseTargets(env) {
  const fleetUrl = env.FLEET_API_URL || env.FLEET_LIST_URL;
  if (!fleetUrl) return null;
  try {
    const res = await fetch(fleetUrl, {
      headers: {
        accept: "application/json",
        "user-agent": "muse-teams-invite/0.2",
        ...(env.FLEET_API_TOKEN ? { authorization: `Bearer ${env.FLEET_API_TOKEN}` } : {}),
      },
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => null);
    const browsers = [];
    const pushBrowser = (b, host) => {
      if (!b || typeof b !== "object") return;
      const museOk =
        b.muse === true ||
        b.museLoggedIn === true ||
        b.hasMuse === true ||
        (b.engines && b.engines.muse && (b.engines.muse.ok || b.engines.muse.loggedIn)) ||
        b.accountBound === "muse" ||
        (Array.isArray(b.engines) && b.engines.includes("muse"));
      // Skip browsersWithoutMuse style
      if (b.needsMuse || b.withoutMuse) return;
      if (!museOk && !(b.labels || []).includes?.("muse")) {
        // If fleet marks museSession / museEmail, treat as logged-in
        if (!(b.museSession || b.museEmail || b.muse_user)) return;
      }
      const id = b.id || b.browserId || `${host || "host"}-${b.port || b.cdp || b.slot || browsers.length}`;
      browsers.push({
        id: String(id),
        label: b.label || b.name || `Muse lane ${id}`,
        kind: "muse_linux",
        status: "logged_in",
        host: host || b.host || null,
        port: b.port || b.cdp || null,
        deliverable: true,
      });
    };

    if (Array.isArray(data)) {
      for (const b of data) pushBrowser(b, null);
    } else if (data && Array.isArray(data.browsers)) {
      for (const b of data.browsers) pushBrowser(b, data.host);
    } else if (data && Array.isArray(data.nodes)) {
      for (const n of data.nodes) {
        const list = n.browsers || n.lanes || [];
        for (const b of list) pushBrowser(b, n.host || n.id);
      }
    } else if (data && data.engines && data.engines.muse) {
      const muse = data.engines.muse;
      const withMuse = muse.browsers || muse.lanes || [];
      for (const b of withMuse) pushBrowser({ ...b, muse: true }, null);
    }
    return browsers;
  } catch (_) {
    return null;
  }
}

async function loadTargets(env) {
  const discovered = await discoverLoggedInMuseTargets(env);
  if (discovered && discovered.length) {
    return { targets: discovered, source: "fleet_logged_in_muse" };
  }
  const configured = loadConfiguredTargets(env);
  if (configured && configured.length) {
    return {
      targets: configured.map((t) => ({
        ...t,
        status: t.status || "configured",
        deliverable: t.deliverable !== false && t.status !== "offline",
      })),
      source: "INVITE_TARGETS_JSON",
    };
  }
  return {
    targets: [
      {
        id: "target-demo-1",
        label: "demo Muse Linux (placeholder — set FLEET_API_URL or INVITE_TARGETS_JSON)",
        kind: "muse_linux",
        status: "stub",
        deliverable: false,
      },
    ],
    source: "stub",
  };
}

const TOOLS = [
  {
    name: "invite_list_targets",
    description:
      "List channel targets that can receive Muse prompts (invite / 公司休眠 / 公司注销). Only currently logged-in Muse browser lanes are deliverable when fleet discovery is configured.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "invite_compose",
    description:
      "Create a Teams proxy-onboard invite (teams_create_invite) and return invite_id + prompt text. Does not deliver.",
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
    name: "invite_lifecycle_compose",
    description:
      "Compose a company lifecycle prompt via Teams API: suspend(公司休眠) / resume(公司重开) / archive(公司注销). Returns prompt for invite_deliver. Archive is terminal and uses the prompt channel (symmetric to invite).",
    inputSchema: {
      type: "object",
      properties: {
        company_code: { type: "string" },
        action: {
          type: "string",
          description: "suspend | resume | archive",
          enum: ["suspend", "resume", "archive"],
        },
        from: { type: "string" },
        apply: {
          type: "boolean",
          description: "If true (default), call Teams suspend/resume/archive to change status; if false, only fetch company and build local prompt text from status.",
        },
      },
      required: ["company_code", "action"],
    },
  },
  {
    name: "invite_deliver",
    description:
      "Deliver a prompt to a logged-in Muse lane target. Accepts invite_id (fetch invite.prompt) OR prompt+kind (invite|suspend|archive|resume). Refuses non-deliverable / non-logged-in targets. Injection into Muse session may still be stubbed; attempt is recorded.",
    inputSchema: {
      type: "object",
      properties: {
        invite_id: { type: "string" },
        target_id: { type: "string" },
        prompt: { type: "string" },
        kind: {
          type: "string",
          description: "invite | suspend | archive | resume",
          enum: ["invite", "suspend", "archive", "resume"],
        },
        company_code: { type: "string" },
      },
      required: ["target_id"],
    },
  },
  {
    name: "invite_status",
    description: "Check a delivery attempt status by delivery_id or invite_id / company_code.",
    inputSchema: {
      type: "object",
      properties: {
        delivery_id: { type: "string" },
        invite_id: { type: "string" },
        company_code: { type: "string" },
      },
    },
  },
  {
    name: "invite_ack_poll",
    description:
      "Poll Teams receipt box for invite_ack (and invite_sent) so company perceives successful 代企业入驻.",
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

async function teamsCreateInvite(api, args) {
  const res = await fetch(`${api}/api/invites`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(args || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function teamsLifecycle(api, { company_code, action, from }) {
  const code = String(company_code || "").trim().toUpperCase();
  const act = String(action || "").trim().toLowerCase();
  if (!code) throw new Error("company_code required");
  if (!["suspend", "resume", "archive"].includes(act)) throw new Error("action must be suspend|resume|archive");
  const res = await fetch(`${api}/api/companies/${encodeURIComponent(code)}/${act}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from: from || null }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function teamsListReceipts(api, { doorplate, company_code, type = "invite_ack" }) {
  const q = new URLSearchParams({ doorplate, company: company_code, type });
  const res = await fetch(`${api}/api/receipts?${q}`);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function getLog() {
  if (!globalThis.__inviteDeliveryLog) globalThis.__inviteDeliveryLog = new Map();
  return globalThis.__inviteDeliveryLog;
}

async function callTool(env, name, args = {}) {
  const TEAMS_API = env.TEAMS_API_URL || TEAMS_API_DEFAULT;
  const TEAMS_MCP = env.TEAMS_MCP_URL || TEAMS_MCP_DEFAULT;
  const deliveryLog = getLog();

  switch (name) {
    case "invite_list_targets": {
      const { targets, source } = await loadTargets(env);
      const deliverable = targets.filter((t) => t.deliverable !== false && t.status !== "stub" && t.status !== "offline");
      return {
        targets,
        deliverable_count: deliverable.length,
        source,
        note:
          source === "stub"
            ? "stub — set FLEET_API_URL (logged-in Muse lanes) or INVITE_TARGETS_JSON"
            : "Only logged-in / deliverable targets should receive archive/suspend prompts",
      };
    }
    case "invite_compose": {
      const invite = await teamsCreateInvite(TEAMS_API, args);
      return {
        invite_id: invite.invite_id,
        company_code: invite.company_code,
        prompt: invite.prompt,
        status: invite.status,
        specialties: invite.specialties,
        kind: "invite",
        teams_api: `${TEAMS_API}/api/invites/${invite.invite_id}`,
      };
    }
    case "invite_lifecycle_compose": {
      const apply = args.apply !== false;
      if (!apply) {
        const cres = await fetch(`${TEAMS_API}/api/companies/${encodeURIComponent(args.company_code)}`);
        const co = await cres.json().catch(() => ({}));
        if (!cres.ok) throw new Error(co.error || `HTTP ${cres.status}`);
        return {
          company_code: co.code,
          status: co.status,
          apply: false,
          note: "apply=false: status not changed; call with apply=true to suspend/resume/archive",
          company: co,
        };
      }
      const out = await teamsLifecycle(TEAMS_API, args);
      const labels = { suspend: "公司休眠", resume: "公司重开", archive: "公司注销" };
      return {
        company_code: args.company_code,
        action: args.action,
        kind: args.action,
        label: labels[args.action] || args.action,
        status: out.status,
        prompt: out.prompt,
        muse_action: out.muse_action,
        wiped: out.wiped || null,
        terminal: !!out.terminal,
        channel: out.channel || (args.action === "archive" ? "prompt" : "detect_via_renew_or_get"),
        teams_result: out,
      };
    }
    case "invite_deliver": {
      const { targets } = await loadTargets(env);
      const target = targets.find((t) => t.id === args.target_id);
      if (!target) throw new Error(`unknown target: ${args.target_id}`);
      if (target.deliverable === false || target.status === "stub" || target.status === "offline") {
        throw new Error(
          `target ${args.target_id} is not a currently logged-in Muse lane (status=${target.status}). Archive/suspend prompts only deliver to logged-in lanes.`
        );
      }
      let prompt = args.prompt;
      let kind = args.kind || (args.invite_id ? "invite" : null);
      let invite_id = args.invite_id || null;
      if (!prompt && invite_id) {
        const res = await fetch(`${TEAMS_API}/api/invites/${encodeURIComponent(invite_id)}`);
        const inv = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(inv.error || `HTTP ${res.status}`);
        prompt = inv.prompt;
        kind = kind || "invite";
      }
      if (!prompt) throw new Error("prompt required (or invite_id to fetch)");
      kind = kind || "invite";
      const delivery_id = `D-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      // Session inject: still stub at transport layer; receipt records intent for logged-in lane.
      const inject_status = env.MUSE_INJECT_URL ? "inject_attempted" : "recorded_pending_inject";
      let inject_detail = null;
      if (env.MUSE_INJECT_URL) {
        try {
          const ir = await fetch(env.MUSE_INJECT_URL, {
            method: "POST",
            headers: { "content-type": "application/json", "user-agent": "muse-teams-invite/0.2" },
            body: JSON.stringify({
              target_id: args.target_id,
              host: target.host,
              port: target.port,
              kind,
              company_code: args.company_code || null,
              invite_id,
              prompt,
            }),
          });
          inject_detail = { http: ir.status, body: await ir.text().catch(() => "") };
        } catch (e) {
          inject_detail = { error: e.message || String(e) };
        }
      }
      const record = {
        delivery_id,
        invite_id,
        company_code: args.company_code || null,
        kind,
        target_id: args.target_id,
        target,
        status: inject_status,
        prompt_preview: String(prompt || "").slice(0, 240),
        at: Date.now(),
        inject_detail,
        note:
          inject_status === "recorded_pending_inject"
            ? "Target is logged-in-eligible; set MUSE_INJECT_URL to wire Muse session inject (same pattern as image-gen delivery)."
            : "Inject endpoint called.",
      };
      deliveryLog.set(delivery_id, record);
      return record;
    }
    case "invite_status": {
      if (args.delivery_id && deliveryLog.has(args.delivery_id)) return deliveryLog.get(args.delivery_id);
      let hits = [...deliveryLog.values()];
      if (args.invite_id) hits = hits.filter((r) => r.invite_id === args.invite_id);
      if (args.company_code) {
        const c = String(args.company_code).toUpperCase();
        hits = hits.filter((r) => (r.company_code || "").toUpperCase() === c);
      }
      return { invite_id: args.invite_id || null, company_code: args.company_code || null, deliveries: hits };
    }
    case "invite_ack_poll": {
      const data = await teamsListReceipts(TEAMS_API, {
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

async function handleRpc(env, msg) {
  const id = msg && msg.id !== undefined ? msg.id : null;
  try {
    if (msg.method === "initialize") {
      return ok(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "muse-teams-invite", version: "0.2.0" },
      });
    }
    if (msg.method === "notifications/initialized") return ok(id, {});
    if (msg.method === "tools/list") return ok(id, { tools: TOOLS });
    if (msg.method === "tools/call") {
      const p = msg.params || {};
      const out = await callTool(env, p.name, p.arguments || {});
      return ok(id, {
        content: [{ type: "text", text: JSON.stringify(out, null, 2) }],
      });
    }
    if (msg.method === "ping") return ok(id, {});
    return err(id, -32601, `unknown method: ${msg.method}`);
  } catch (e) {
    return err(id, -32602, e.message || String(e));
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (
      request.method === "GET" &&
      (url.pathname === "/" || url.pathname === "/invite-mcp" || url.pathname.endsWith("/invite-mcp"))
    ) {
      return json({
        ok: true,
        service: "muse-teams-invite",
        version: "0.2.0",
        mcp: "POST /invite-mcp (or POST /) streamable-http JSON-RPC",
        tools: TOOLS.map((t) => t.name),
        teams_api: env.TEAMS_API_URL || TEAMS_API_DEFAULT,
        note: "deliver requires logged-in Muse lanes; session inject optional via MUSE_INJECT_URL",
      });
    }

    const isMcpPath =
      url.pathname === "/" ||
      url.pathname === "/mcp" ||
      url.pathname === "/invite-mcp" ||
      url.pathname.endsWith("/invite-mcp");

    if (request.method === "POST" && isMcpPath) {
      let body = null;
      try {
        body = await request.json();
      } catch (_) {
        return json(err(null, -32700, "parse error"));
      }
      const res = await handleRpc(env, body);
      return json(res);
    }

    return json({ ok: false, error: "not found", hint: "POST /invite-mcp for MCP" }, 404);
  },
};
