// 一单链路 —— created → plaza → claimed → submitted → reviewed
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import MonsterAvatar from '../components/MonsterAvatar.jsx';
import { api, fmtTime, durStr, ST_META, stKey } from '../api.js';

const STAGE_META = {
  created: { icon: '📝', hint: '发单进窝' },
  plaza: { icon: '🗺', hint: '开放跨公司抢单' },
  claimed: { icon: '🤏', hint: '毛怪叼走' },
  submitted: { icon: '📦', hint: '交产物待验收' },
  reviewed: { icon: '✅', hint: '验收结案' },
};

/** Map durations_ms keys → stage-pair labels (Chinese). */
const DUR_ROWS = [
  { k: 'pending_to_claim', label: '发单 → 抢单', from: 'created', to: 'claimed' },
  { k: 'claim_to_submit', label: '抢单 → 交单', from: 'claimed', to: 'submitted' },
  { k: 'submit_to_done', label: '交单 → 验收', from: 'submitted', to: 'reviewed' },
  { k: 'total', label: '合计', from: null, to: null },
];

/** Which durations_ms key sits between stage A → stage B (rail chip). */
const EDGE_DUR_KEY = {
  'created->claimed': 'pending_to_claim',
  'plaza->claimed': 'pending_to_claim',
  'claimed->submitted': 'claim_to_submit',
  'submitted->reviewed': 'submit_to_done',
};

function parseTraceIdFromHash() {
  if (typeof location === 'undefined') return '';
  const raw = (location.hash || '').replace(/^#/, '');
  // #trace/T-1018 or #trace?id=T-1018
  const parts = raw.split(/[?/]/);
  if (parts[0] !== 'trace') return '';
  if (parts[1] && /^T-/i.test(parts[1])) return parts[1].toUpperCase();
  const q = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
  const params = new URLSearchParams(q);
  const id = params.get('id') || '';
  return id.trim().toUpperCase();
}

function setTraceHash(taskId) {
  const next = taskId ? `#trace/${encodeURIComponent(taskId)}` : '#trace';
  try {
    history.replaceState(null, '', next);
  } catch (_) {
    location.hash = next.replace(/^#/, '');
  }
}

function ActorChip({ actor }) {
  if (!actor) return <span className="trace-actor muted">—</span>;
  const label = actor.name || actor.doorplate || actor.company || '—';
  return (
    <span className="trace-actor">
      {actor.doorplate ? <MonsterAvatar doorplate={actor.doorplate} size={22} /> : null}
      <span>{label}</span>
      {actor.company && (
        <code className="trace-co">{actor.company}</code>
      )}
    </span>
  );
}

/** Small chip under a stage: time until the next meaningful stage. */
function StageDelta({ prev, next, durations }) {
  if (!prev || !next) return null;
  const key = EDGE_DUR_KEY[`${prev.stage}->${next.stage}`];
  let ms = key && durations ? durations[key] : null;
  // Fallback: compute from timestamps when API key missing
  if (ms == null && prev.at != null && next.at != null) {
    ms = Math.max(0, next.at - prev.at);
  }
  // Skip near-zero hops (e.g. 发单→进广场 often same ms)
  if (ms != null && ms < 50 && prev.at != null && next.at != null) return null;

  const toLabel = next.label || next.stage;
  let text;
  if (next.at == null) {
    text = '进行中';
  } else if (ms == null) {
    return null;
  } else {
    text = durStr(ms) || '—';
  }
  return (
    <div
      className={`trace-delta${next.at == null ? ' live' : ''}`}
      title={`${prev.label || prev.stage} → ${toLabel}`}
    >
      <span className="trace-delta-arrow" aria-hidden>↓</span>
      <span className="trace-delta-to">到{toLabel}</span>
      <span className="trace-delta-val">{text}</span>
    </div>
  );
}

function Durations({ d, stages }) {
  if (!d && !(stages && stages.length)) return null;

  const rows = DUR_ROWS.map((r) => {
    let ms = d ? d[r.k] : null;
    let pending = false;
    if (ms == null && stages && r.from && r.to) {
      const a = stages.find((s) => s.stage === r.from);
      const b = stages.find((s) => s.stage === r.to);
      if (a && b && a.at != null && b.at != null) ms = Math.max(0, b.at - a.at);
      else if (a && a.at != null && (!b || b.at == null)) pending = true;
    }
    if (r.k === 'total' && ms == null && stages) {
      const first = stages.find((s) => s.at != null);
      const lastDone = [...stages].reverse().find((s) => s.at != null);
      if (first && lastDone && lastDone !== first) ms = Math.max(0, lastDone.at - first.at);
      const allDone = stages.every((s) => s.at != null);
      if (!allDone && first) pending = true;
    }
    return { ...r, ms, pending };
  });

  const hasAny = rows.some((r) => r.ms != null || r.pending);
  if (!hasAny) return null;

  return (
    <div className="trace-durs" role="group" aria-label="阶段耗时">
      {rows.map((r) => (
        <div key={r.k} className={`trace-dur-chip${r.k === 'total' ? ' total' : ''}${r.pending ? ' live' : ''}`}>
          <span>{r.label}</span>
          <b>
            {r.pending && r.ms == null
              ? '进行中'
              : r.ms != null
                ? durStr(r.ms) || '—'
                : '—'}
          </b>
        </div>
      ))}
    </div>
  );
}

export default function Trace({ company, onToast, initialTaskId }) {
  const [taskId, setTaskId] = useState(() => initialTaskId || parseTraceIdFromHash() || '');
  const [input, setInput] = useState(() => initialTaskId || parseTraceIdFromHash() || '');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(async (id) => {
    const tid = String(id || '').trim().toUpperCase();
    if (!tid) {
      setErr('请输入任务号，例如 T-1018');
      setData(null);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const trace = await api.getTaskTrace(tid);
      setData(trace);
      setTaskId(tid);
      setInput(tid);
      setTraceHash(tid);
    } catch (e) {
      setData(null);
      setErr(e.message || '加载失败');
      if (onToast) onToast('链路加载失败: ' + e.message, true);
    } finally {
      setBusy(false);
    }
  }, [onToast]);

  useEffect(() => {
    const fromHash = parseTraceIdFromHash();
    const seed = initialTaskId || fromHash;
    if (seed) load(seed);
  }, [initialTaskId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onHash = () => {
      const id = parseTraceIdFromHash();
      if (id && id !== taskId) load(id);
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, [taskId, load]);

  const statusLabel = useMemo(() => {
    if (!data) return '';
    const meta = ST_META[stKey({ status: data.status })] || {};
    return meta.label || data.status;
  }, [data]);

  const stages = data?.stages || [];

  return (
    <div className="mt-tabpane trace-pane">
      <h2 className="sec-title">
        <span className="serif">🔗 一单链路</span>
        <span className="sec-sub">发单 → 广场 → 抢单 → 交单 → 验收</span>
      </h2>

      <form
        className="trace-search"
        onSubmit={(e) => {
          e.preventDefault();
          load(input);
        }}
      >
        <input
          className="trace-input"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="任务号 T-1018"
          spellCheck={false}
        />
        <button type="submit" className="btn" disabled={busy}>
          {busy ? '查…' : '看链路'}
        </button>
        {company?.code && (
          <span className="trace-co-hint">当前窝 {company.code}</span>
        )}
      </form>

      {err && <div className="trace-err">{err}</div>}

      {!data && !err && !busy && (
        <div className="mt-empty">
          <div className="mt-empty-art" aria-hidden>
            <MonsterAvatar doorplate="trace-empty" size={72} />
          </div>
          <div className="mt-empty-title serif">输入任务号看全程</div>
          <div className="mt-empty-sub">任务板点「看链路」，或在上方输入 T-xxxx</div>
        </div>
      )}

      {data && (
        <div className="trace-card">
          <div className="trace-head">
            <div>
              <div className="trace-id">{data.task_id}</div>
              <div className="trace-title serif">{data.title}</div>
              <div className="trace-subline">
                <span className="st-badge">{statusLabel}</span>
                <span className="trace-type">{data.task_type || 'general'}</span>
                {data.company_name || data.company ? (
                  <span>发单方 {data.company_name || data.company}
                    {data.company && <code className="trace-co">{data.company}</code>}
                  </span>
                ) : null}
                {data.claim_company && (
                  <span>抢单方 <code className="trace-co">{data.claim_company}</code></span>
                )}
              </div>
            </div>
          </div>

          <Durations d={data.durations_ms} stages={stages} />

          <div className="trace-chain">
            {stages.map((s, i, arr) => {
              const next = arr[i + 1];
              const done = s.at != null;
              const rejected = s.stage === 'reviewed' && s.payload && s.payload.approved === false;
              const meta = STAGE_META[s.stage] || { icon: '•', hint: '' };
              return (
                <div key={s.stage} className={`trace-node${done ? ' done' : ' pending'}${rejected ? ' rejected' : ''}`}>
                  <div className="trace-node-rail">
                    <div className="trace-dot" aria-hidden>{meta.icon}</div>
                    {next && <div className="trace-rail" />}
                  </div>
                  <div className="trace-node-body">
                    <div className="trace-node-title">
                      <b>{s.label || s.stage}</b>
                      <span className="trace-hint">{meta.hint}</span>
                      {done ? (
                        <time className="trace-at">{fmtTime(s.at)}</time>
                      ) : (
                        <span className="trace-at muted">进行中</span>
                      )}
                    </div>
                    <div className="trace-node-meta">
                      <ActorChip actor={s.actor} />
                      {s.payload && Object.keys(s.payload).length > 0 && (
                        <pre className="trace-payload">{JSON.stringify(s.payload, null, 0)}</pre>
                      )}
                    </div>
                    {next && <StageDelta prev={s} next={next} durations={data.durations_ms} />}
                  </div>
                </div>
              );
            })}
          </div>

          {Array.isArray(data.prompts) && data.prompts.length > 0 && (
            <div className="trace-section">
              <div className="trace-section-title">提示词</div>
              <ol className="plaza-prompt-list">
                {data.prompts.map((p, i) => <li key={i}>{p}</li>)}
              </ol>
            </div>
          )}

          {data.result != null && (
            <div className="trace-section">
              <div className="trace-section-title">结果 JSON</div>
              <pre className="plaza-desc">{JSON.stringify(data.result, null, 2)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
