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

/** Live /api/fleet: identities.muse==="in" OR museStatus==="logged_in". Never heal/swap. */
function isMuseLoggedIn(b) {
  if (!b || typeof b !== "object") return false;
  if (b.needsMuse || b.withoutMuse) return false;
  if (b.museStatus === "logged_in") return true;
  if (b.identities && (b.identities.muse === "in" || b.identities.muse === true)) return true;
  if (b.muse === true || b.museLoggedIn === true || b.hasMuse === true) return true;
  if (b.engines && b.engines.muse && (b.engines.muse.ok || b.engines.muse.loggedIn)) return true;
  if (b.accountBound === "muse") return true;
  if (Array.isArray(b.engines) && b.engines.includes("muse")) return true;
  if ((b.labels || []).includes?.("muse")) return true;
  if (b.museSession || b.museEmail || b.muse_user) return true;
  return false;
}

async function discoverLoggedInMuseTargets(env) {
  const fleetUrl = env.FLEET_API_URL || env.FLEET_LIST_URL;
  if (!fleetUrl) return { browsers: null, error: "FLEET_API_URL unset" };
  try {
    const res = await fetch(fleetUrl, {
      headers: {
        accept: "application/json",
        "user-agent": "muse-teams-invite/0.3.1",
        ...(env.FLEET_API_TOKEN ? { authorization: `Bearer ${env.FLEET_API_TOKEN}` } : {}),
      },
    });
    if (!res.ok) return { browsers: null, error: `fleet HTTP ${res.status}` };
    const data = await res.json().catch(() => null);
    const browsers = [];
    const pushBrowser = (b, node) => {
      if (!isMuseLoggedIn(b)) return;
      const nodeId = (node && (node.id || node.host)) || null;
      const serviceBase = (node && (node.serviceBase || node.service_base)) || b.serviceBase || null;
      const browserNo = b.browserNo != null ? Number(b.browserNo) : null;
      const instance = browserNo != null && Number.isFinite(browserNo)
        ? browserNo
        : Number(b.instance ?? b.port ?? NaN);
      const id =
        b.id ||
        b.browserId ||
        (nodeId != null && browserNo != null ? `${nodeId}@${browserNo}` : null) ||
        `${nodeId || "host"}-${b.port || b.cdp || b.cdpPort || b.slot || browsers.length}`;
      const host = serviceBase || (node && (node.host || node.id)) || b.host || null;
      const museLabel =
        (b.accounts && b.accounts.muse && (b.accounts.muse.label || b.accounts.muse.email)) ||
        null;
      browsers.push({
        id: String(id),
        label: b.label || b.name || museLabel || `Muse lane ${id}`,
        kind: "muse_linux",
        status: "logged_in",
        host,
        serviceBase: serviceBase || (typeof host === "string" && /imggen-/i.test(host) ? host : null),
        port: Number.isFinite(instance) ? instance : b.port || null,
        instance: Number.isFinite(instance) ? instance : null,
        browserNo: browserNo,
        cdpPort: b.cdpPort || b.cdp || null,
        node_id: nodeId,
        deliverable: true,
      });
    };

    if (Array.isArray(data)) {
      for (const b of data) pushBrowser(b, null);
    } else if (data && Array.isArray(data.browsers)) {
      for (const b of data.browsers) pushBrowser(b, { host: data.host, serviceBase: data.serviceBase, id: data.id });
    } else if (data && Array.isArray(data.nodes)) {
      for (const n of data.nodes) {
        const list = n.browsers || n.lanes || [];
        for (const b of list) pushBrowser(b, n);
      }
    } else if (data && data.engines && data.engines.muse) {
      const muse = data.engines.muse;
      const withMuse = muse.browsers || muse.lanes || [];
      for (const b of withMuse) pushBrowser({ ...b, muse: true, museStatus: "logged_in" }, null);
    }
    return { browsers, error: null };
  } catch (e) {
    return { browsers: null, error: e.message || String(e) };
  }
}

async function loadTargets(env) {
  const discovered = await discoverLoggedInMuseTargets(env);
  const fleetErr = discovered && discovered.error;
  const browsers = discovered && discovered.browsers;
  if (browsers && browsers.length) {
    return { targets: browsers, source: "fleet_logged_in_muse" };
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
      fleet_error: fleetErr || undefined,
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
    fleet_error: fleetErr || (env.FLEET_API_URL || env.FLEET_LIST_URL ? "fleet returned zero Muse lanes" : "FLEET_API_URL unset"),
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
        from: { type: "string", description: "Required lead doorplate when apply=true (Teams lead auth)" },
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
      "Deliver a prompt to a logged-in Muse lane target. Accepts invite_id (fetch invite.prompt) OR prompt+kind (invite|suspend|archive|resume). Refuses non-deliverable / non-logged-in targets. Preferred inject: POST target.serviceBase/browser/run with Bearer IMGGEN_TOKEN (same Muse channel as 生图 MCP); MUSE_INJECT_URL remains an optional adapter override.",
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


const MUSE_COMPOSER_SELECTOR = 'textarea[aria-label="Message"], textarea[placeholder="Message"]';

function imggenServiceBase(target) {
  const base = String(target.serviceBase || target.host || "").replace(/\/$/, "");
  if (base && /^https?:\/\/imggen-[^/]+/i.test(base)) return base;
  return null;
}

/** Same channel as 生图 MCP sibling: POST {serviceBase}/browser/run with IMGGEN_TOKEN (not /generate). */
async function injectViaBrowserRun(env, target, prompt) {
  const serviceBase = imggenServiceBase(target);
  if (!serviceBase) return null;
  const instance = Number(target.instance ?? target.port ?? target.browserNo);
  if (!Number.isFinite(instance)) {
    return { ok: false, error: "target missing browser instance/browserNo for /browser/run" };
  }
  const token = env.IMGGEN_TOKEN;
  if (!token) {
    return { ok: false, error: "IMGGEN_TOKEN required to POST imggen /browser/run" };
  }
  const actions = [
    { op: "goto", url: "https://muse.ai/", timeout: 60000 },
    { op: "waitFor", selector: MUSE_COMPOSER_SELECTOR, timeout: 30000 },
    { op: "type", selector: MUSE_COMPOSER_SELECTOR, text: String(prompt) },
    {
      op: "eval",
      expr: (() => {
        const sel = JSON.stringify(MUSE_COMPOSER_SELECTOR);
        return `(() => { const t = document.querySelector(${sel}); if (!t) return { ok: false, reason: 'no composer' }; t.focus(); t.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true })); return { ok: true }; })()`;
      })(),
    },
  ];
  try {
    const ir = await fetch(`${serviceBase}/browser/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
        "user-agent": "muse-teams-invite/0.3.1",
      },
      body: JSON.stringify({ instance, actions }),
    });
    const bodyText = await ir.text().catch(() => "");
    let bodyJson = null;
    try {
      bodyJson = JSON.parse(bodyText);
    } catch (_) { /* keep text */ }
    return {
      ok: ir.ok,
      channel: "imggen_browser_run",
      url: `${serviceBase}/browser/run`,
      instance,
      http: ir.status,
      body: bodyJson || bodyText.slice(0, 2000),
    };
  } catch (e) {
    return {
      ok: false,
      channel: "imggen_browser_run",
      url: `${serviceBase}/browser/run`,
      instance,
      error: e.message || String(e),
    };
  }
}

async function injectViaAdapterUrl(env, target, { prompt, kind, invite_id, company_code, target_id }) {
  if (!env.MUSE_INJECT_URL) return null;
  try {
    const ir = await fetch(env.MUSE_INJECT_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "muse-teams-invite/0.3.1" },
      body: JSON.stringify({
        target_id,
        host: target.host,
        port: target.port,
        instance: target.instance ?? target.port,
        serviceBase: target.serviceBase || null,
        kind,
        company_code: company_code || null,
        invite_id,
        prompt,
      }),
    });
    return {
      ok: ir.ok,
      channel: "muse_inject_url",
      http: ir.status,
      body: await ir.text().catch(() => ""),
    };
  } catch (e) {
    return { ok: false, channel: "muse_inject_url", error: e.message || String(e) };
  }
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
      const { targets, source, fleet_error } = await loadTargets(env);
      const deliverable = targets.filter((t) => t.deliverable !== false && t.status !== "stub" && t.status !== "offline");
      return {
        targets,
        deliverable_count: deliverable.length,
        source,
        fleet_error: fleet_error || undefined,
        note:
          source === "stub"
            ? "stub — set FLEET_API_URL (logged-in Muse lanes) or INVITE_TARGETS_JSON; same-zone fetch needs global_fetch_strictly_public"
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
      if (!args.from || !String(args.from).trim()) {
        throw new Error("from (lead doorplate) required when apply=true");
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
      // Preferred: same Muse channel as 生图 — POST imggen-*/browser/run + IMGGEN_TOKEN.
      // Optional override: MUSE_INJECT_URL adapter (legacy stub schema).
      let inject_detail =
        (await injectViaBrowserRun(env, target, prompt)) ||
        (await injectViaAdapterUrl(env, target, {
          prompt,
          kind,
          invite_id,
          company_code: args.company_code || null,
          target_id: args.target_id,
        }));
      let inject_status;
      let note;
      if (!inject_detail) {
        inject_status = "recorded_pending_inject";
        note =
          "Target is logged-in-eligible but has no imggen serviceBase and MUSE_INJECT_URL is unset. Set FLEET_API_URL + IMGGEN_TOKEN for /browser/run.";
      } else if (inject_detail.ok) {
        inject_status = "injected";
        note =
          inject_detail.channel === "imggen_browser_run"
            ? "Injected via imggen /browser/run (same channel as 生图 MCP text path)."
            : "Inject endpoint (MUSE_INJECT_URL) called.";
      } else {
        inject_status = "inject_failed";
        note = inject_detail.error || `Inject failed (http=${inject_detail.http})`;
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
        note,
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
        serverInfo: { name: "muse-teams-invite", version: "0.3.1" },
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
        version: "0.3.1",
        mcp: "POST /invite-mcp (or POST /) streamable-http JSON-RPC",
        tools: TOOLS.map((t) => t.name),
        teams_api: env.TEAMS_API_URL || TEAMS_API_DEFAULT,
        note: "deliver posts to imggen-*/browser/run with IMGGEN_TOKEN (same channel as 生图); MUSE_INJECT_URL optional override",
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
