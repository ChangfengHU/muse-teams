// 抢单广场 —— 跨公司视频生成订单市集（以「单」为维度）
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import MonsterAvatar from '../components/MonsterAvatar.jsx';
import { api, getCompany, relTime, fmtTime, ST_META, stKey } from '../api.js';

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'cross', label: '外公司' },
  { key: 'mine', label: '本公司发的' },
  { key: 'urgent', label: '紧急' },
  { key: 'claimed', label: '已抢走' },
];

const RESULT_EXAMPLE = `[
  {
    "prompt": "奶油色小毛怪抱着纸飞机飞过麦田，竖版 15s",
    "video_url": "https://cdn.example.com/v/abc123.mp4",
    "asset_id": "vid_abc123",
    "meta": { "duration_s": 15, "aspect": "9:16" }
  }
]`;

function companyHue(code) {
  let h = 0;
  const s = String(code || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 42% 92%)`;
}


function defaultVideoTitle(promptsText) {
  const lines = String(promptsText || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const n = lines.length;
  const d = new Date();
  const date = `${d.getMonth() + 1}/${d.getDate()}`;
  if (!n) return `视频生成 · ${date}`;
  const first = lines[0].slice(0, 24);
  if (n === 1) return `视频生成 · ${first}`;
  return `视频生成 · ${first} · ${n} 条`;
}

function CreateVideoModal({ show, onClose, onCreated, toast }) {
  const [title, setTitle] = useState('');
  const [prompts, setPrompts] = useState('');
  const [pri, setPri] = useState('P1');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!show) return;
    setTitle(defaultVideoTitle(''));
    setPrompts('');
    setPri('P1');
  }, [show]);

  if (!show) return null;

  const submit = async () => {
    if (!prompts.trim()) { toast('至少写一条视频提示词', true); return; }
    const autoTitle = title.trim() || defaultVideoTitle(prompts);
    setBusy(true);
    try {
      const task = await api.createVideoGenTask({
        title: autoTitle,
        prompts: prompts.trim(),
        priority: pri,
      });
      toast(`✈️ 视频生成单 ${task.id || ''} 已扔进广场`);
      setTitle(''); setPrompts(''); setPri('P1');
      onClose();
      if (onCreated) onCreated(task);
    } catch (e) {
      toast('发单失败: ' + e.message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-bg show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal mt-modal wide">
        <h2 className="serif">🎬 发视频生成单</h2>
        <div className="msub">提示词交给抢单公司实现；对方交回每条视频的 JSON。剪辑单以后再发。</div>
        <div className="field">
          <label>标题（可留空，按提示词自动生成）</label>
          <input
            value={title}
            placeholder="留空则用「视频生成 · 首条提示词 · N 条」"
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="field">
          <label>提示词列表（一行一条）</label>
          <textarea
            rows={8}
            value={prompts}
            placeholder={'奶油色小毛怪抱纸飞机飞过麦田，竖版 15s\n午后阳光下的工坊门牌特写，暖色调'}
            onChange={(e) => setPrompts(e.target.value)}
          />
        </div>
        <div className="field">
          <label>优先级</label>
          <select value={pri} onChange={(e) => setPri(e.target.value)}>
            <option value="P0">P0 紧急</option>
            <option value="P1">P1 普通</option>
            <option value="P2">P2 低</option>
          </select>
        </div>
        <div className="row">
          <button type="button" className="btn btn-ghost" onClick={onClose}>取消</button>
          <button type="button" className="btn" onClick={submit} disabled={busy}>扔进广场 ✈️</button>
        </div>
      </div>
    </div>
  );
}

function ClaimPicker({ show, task, agents, onClose, onPick }) {
  if (!show || !task) return null;
  return (
    <div className="modal-bg show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal mt-modal">
        <h2 className="serif">谁去抢？</h2>
        <div className="msub">选本公司毛怪认领「{task.title}」· {task.id}</div>
        {!agents.length && <div className="empty-hint">本公司还没有毛怪，先去邀请入驻</div>}
        <div className="picker" style={{ maxHeight: 320, overflow: 'auto' }}>
          {agents.map((a) => (
            <div key={a.doorplate} className="popt" onClick={() => onPick(a.doorplate)}>
              <MonsterAvatar doorplate={a.doorplate} size={34} />
              <span>{a.name || a.doorplate}<br /><small>{a.doorplate}</small></span>
            </div>
          ))}
        </div>
        <div className="row"><button type="button" className="btn btn-ghost" onClick={onClose}>取消</button></div>
      </div>
    </div>
  );
}

function TaskDetail({ task, myCode, agents, onClose, onClaim, onSubmitResult, onGotoCompany, toast }) {
  const [jsonText, setJsonText] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!task) return;
    if (task.result) {
      setJsonText(JSON.stringify(task.result, null, 2));
    } else if (task.prompts && task.prompts.length) {
      setJsonText(JSON.stringify(
        task.prompts.map((p) => ({ prompt: p, video_url: '', asset_id: '', meta: {} })),
        null,
        2,
      ));
    } else {
      setJsonText(RESULT_EXAMPLE);
    }
  }, [task]);

  if (!task) return null;

  const isPublisher = task.company === myCode;
  const isClaimantCo = task.claim_company === myCode;
  const canSubmit = task.status === 'claimed' && isClaimantCo && task.owner;
  const canReview = (task.status === 'review' || task.status === 'done-pending-review') && isPublisher;

  const doSubmit = async () => {
    let parsed;
    try { parsed = JSON.parse(jsonText); }
    catch (e) { toast('JSON 解析失败', true); return; }
    setBusy(true);
    try {
      await onSubmitResult(task, parsed);
    } finally { setBusy(false); }
  };

  const doReview = async (approved) => {
    setBusy(true);
    try {
      await api.reviewTask(task.id, approved);
      toast(approved ? `✅ ${task.id} 验收通过` : `↩️ ${task.id} 已打回广场`);
      onClose(true);
    } catch (e) {
      toast('验收失败: ' + e.message, true);
    } finally { setBusy(false); }
  };

  return (
    <div className="modal-bg show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal mt-modal wide plaza-detail">
        <h2 className="serif">✈ {task.title}</h2>
        <div className="msub">
          <code>{task.id}</code>
          {' · '}
          {ST_META[stKey(task)]?.label || task.status}
          {' · '}
          <span className="tag">{task.task_type === 'video_gen' ? '视频生成' : (task.task_type || '任务')}</span>
        </div>

        <div className="plaza-detail-grid">
          <div className="plaza-detail-card">
            <div className="plaza-detail-label">发单公司窝</div>
            <button type="button" className="plaza-co-link" onClick={() => onGotoCompany(task.company)}>
              <MonsterAvatar doorplate={task.company || 'pub'} size={28} />
              <span>
                <b>{task.company_name || task.company}</b>
                <small>{task.company}</small>
              </span>
            </button>
          </div>
          <div className="plaza-detail-card">
            <div className="plaza-detail-label">抢走的公司 / 人</div>
            {task.owner ? (
              <button type="button" className="plaza-co-link" onClick={() => onGotoCompany(task.claim_company || task.company)}>
                <MonsterAvatar doorplate={task.owner} size={28} />
                <span>
                  <b>{task.owner_name || task.owner}</b>
                  <small>{task.claim_company_name || task.claim_company || '—'} · {task.owner}</small>
                </span>
              </button>
            ) : (
              <div className="plaza-detail-empty">还没人抢</div>
            )}
          </div>
        </div>

        {!!(task.prompts && task.prompts.length) && (
          <div className="field">
            <label>提示词（{task.prompts.length}）</label>
            <ol className="plaza-prompt-list">
              {task.prompts.map((p, i) => <li key={i}>{p}</li>)}
            </ol>
          </div>
        )}

        {task.desc && (
          <div className="field">
            <label>说明</label>
            <pre className="plaza-desc">{task.desc}</pre>
          </div>
        )}

        {task.result && (
          <div className="field">
            <label>已提交结果 JSON</label>
            <pre className="plaza-desc">{JSON.stringify(task.result, null, 2)}</pre>
          </div>
        )}

        <div className="plaza-timeline">
          <span>创建 {fmtTime(task.created_at)}</span>
          {task.claimed_at && <span>抢走 {fmtTime(task.claimed_at)}</span>}
          {task.submitted_at && <span>提交 {fmtTime(task.submitted_at)}</span>}
          {(task.reviewed_at || task.done_at) && <span>验收 {fmtTime(task.reviewed_at || task.done_at)}</span>}
        </div>

        {task.status === 'pending' && (
          <div className="row">
            <button type="button" className="btn btn-ghost" onClick={() => onClose()}>关闭</button>
            <button type="button" className="btn" onClick={() => onClaim(task)}>抢一下</button>
          </div>
        )}

        {canSubmit && (
          <div className="field">
            <label>提交视频结果 JSON（数组：prompt + video_url 或 asset_id）</label>
            <textarea rows={10} value={jsonText} onChange={(e) => setJsonText(e.target.value)} style={{ fontFamily: 'ui-monospace, monospace', fontSize: 12.5 }} />
            <div className="row" style={{ marginTop: 10 }}>
              <button type="button" className="btn btn-ghost" onClick={() => onClose()}>关闭</button>
              <button type="button" className="btn" disabled={busy} onClick={doSubmit}>交回 JSON 📦</button>
            </div>
          </div>
        )}

        {canReview && (
          <div className="rev-btns" style={{ marginTop: 12 }}>
            <button type="button" className="btn-ok" disabled={busy} onClick={() => doReview(true)}>✓ 通过</button>
            <button type="button" className="btn-no" disabled={busy} onClick={() => doReview(false)}>✗ 打回广场</button>
          </div>
        )}

        {!canSubmit && task.status !== 'pending' && !canReview && (
          <div className="row"><button type="button" className="btn btn-ghost" onClick={() => onClose()}>关闭</button></div>
        )}
      </div>
    </div>
  );
}

export default function ClaimPlaza({ company, agents, onToast, onRefresh, onGotoCompany }) {
  const myCode = company?.code || getCompany() || '';
  const [filter, setFilter] = useState('all');
  const [pending, setPending] = useState([]);
  const [claimed, setClaimed] = useState([]);
  const [feed, setFeed] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [picker, setPicker] = useState(null);
  const [detail, setDetail] = useState(null);

  const load = useCallback(async (silent) => {
    try {
      const [openRes, claimedRes] = await Promise.all([
        api.plaza({ status: 'pending', task_type: 'video_gen' }),
        api.plaza({ status: 'claimed', task_type: 'video_gen' }),
      ]);
      // 待验收只拉本公司发单（/api/tasks），禁止全局 plaza?status=review 串公司
      let reviewTasks = [];
      try {
        if (myCode) {
          const rev = await api.tasks('review');
          reviewTasks = (rev.tasks || []).filter((t) => t.company === myCode);
        }
      } catch (_) { /* ignore */ }
      setPending(openRes.tasks || []);
      setClaimed([...(claimedRes.tasks || []), ...reviewTasks]);
      setFeed(openRes.feed || claimedRes.feed || []);
      setLoading(false);
    } catch (e) {
      if (!silent) onToast('广场加载失败: ' + e.message, true);
      setLoading(false);
    }
  }, [onToast, myCode]);

  useEffect(() => {
    load(false);
    const h = setInterval(() => load(true), 15000);
    return () => clearInterval(h);
  }, [load]);

  const counts = useMemo(() => {
    const urgent = pending.filter((t) => t.priority === 'P0').length;
    const mine = pending.filter((t) => t.company === myCode).length;
    const cross = pending.filter((t) => t.company !== myCode).length;
    return { all: pending.length, urgent, mine, cross, claimed: claimed.length };
  }, [pending, claimed, myCode]);

  const visible = useMemo(() => {
    if (filter === 'claimed') return claimed;
    let list = pending;
    if (filter === 'cross') list = list.filter((t) => t.company !== myCode);
    if (filter === 'mine') list = list.filter((t) => t.company === myCode);
    if (filter === 'urgent') list = list.filter((t) => t.priority === 'P0');
    return list;
  }, [filter, pending, claimed, myCode]);

  const openDetail = async (t) => {
    try {
      const full = await api.getTask(t.id);
      setDetail(full);
    } catch (e) {
      setDetail(t);
    }
  };

  const startClaim = (task) => {
    if (!myCode) { onToast('先选公司窝再抢单', true); return; }
    if (!agents.length) { onToast('本公司还没有毛怪可派', true); return; }
    setPicker(task);
  };

  const doClaim = async (doorplate) => {
    const task = picker;
    setPicker(null);
    if (!task) return;
    try {
      const updated = await api.claimTask(task.id, doorplate);
      onToast(`🎉 ${doorplate} 抢走了 ${task.id}`);
      await load(true);
      if (onRefresh) onRefresh();
      setDetail(updated);
    } catch (e) {
      onToast('抢单失败: ' + e.message, true);
    }
  };

  const submitResult = async (task, result) => {
    if (!task.owner) { onToast('没有认领人', true); return; }
    try {
      const updated = await api.submitTaskResult(task.id, task.owner, result);
      onToast(`📦 ${task.id} 结果已交回，待发单方验收`);
      await load(true);
      if (onRefresh) onRefresh();
      setDetail(updated);
    } catch (e) {
      onToast('提交失败: ' + e.message, true);
      throw e;
    }
  };

  const gotoCo = (code) => {
    if (onGotoCompany && code) onGotoCompany(code);
    else onToast(`公司码 ${code}（可在公司窝切换）`);
  };

  return (
    <div className="mt-tabpane plaza">
      <section className="plaza-head">
        <div className="plaza-head-ico">🗺</div>
        <div>
          <div className="plaza-title serif">抢单广场 · 视频生成</div>
          <div className="plaza-sub">
            以<strong>单</strong>为维度 · <em>跨公司开放</em> · 客厅只管本公司花名册
          </div>
        </div>
        <div className="stats-strip">
          <div className="stat-pill accent"><div className="n">{counts.all}</div><div className="l">待抢</div></div>
          <div className="stat-pill blue"><div className="n">{counts.claimed}</div><div className="l">进行中</div></div>
          <div className="stat-pill green"><div className="n">{agents.length}</div><div className="l">本公司毛怪</div></div>
        </div>
        <button type="button" className="btn btn-plane" onClick={() => setShowCreate(true)} disabled={!myCode}>
          🎬 发视频单
        </button>
      </section>

      <div className="filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`filter-chip${filter === f.key ? ' on' : ''}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
            <span className="count">{counts[f.key] ?? 0}</span>
          </button>
        ))}
        <span className="filter-hint">
          {myCode ? <>你在「{company?.name || myCode}」· 抢外公司单会记入跨公司</> : '先选公司窝才能抢/发单'}
        </span>
      </div>

      <div className="plaza-body">
        <div className="plane-grid">
          {loading && <div className="empty-hint">广场加载中…</div>}
          {!loading && !visible.length && (
            <div className="mt-empty" style={{ gridColumn: '1 / -1' }}>
              <div className="mt-empty-title serif">广场空空的</div>
              <div className="mt-empty-sub">点右上「发视频单」，把提示词折成纸飞机扔进来</div>
            </div>
          )}
          {visible.map((t) => {
            const mine = t.company === myCode;
            const urgent = t.priority === 'P0';
            const taken = t.status !== 'pending';
            return (
              <article
                key={t.id}
                className={`plane-card${urgent ? ' urgent' : ''}${mine ? ' mine' : ''}${taken ? ' taken' : ''}`}
                onClick={() => openDetail(t)}
              >
                <div className="plane-top">
                  <div className="plane-emoji">🎬</div>
                  <div className="plane-meta">
                    <div className="plane-title">{t.title}</div>
                    <div className="plane-brief">
                      {t.prompts?.length
                        ? `${t.prompts.length} 条提示词 · ${(t.prompts[0] || '').slice(0, 60)}`
                        : (t.desc || '').slice(0, 80)}
                    </div>
                    <div className="tag-row">
                      {urgent && <span className="tag urgent">紧急</span>}
                      {mine ? <span className="tag mine">本公司</span> : <span className="tag cross">外公司</span>}
                      <span className="tag">视频生成</span>
                      {taken && <span className="tag">已抢 · {t.owner || '—'}</span>}
                    </div>
                  </div>
                </div>
                <div className="plane-foot">
                  <div className="co-avatar" style={{ background: companyHue(t.company) }}>
                    <MonsterAvatar doorplate={t.company || 'co'} size={22} />
                  </div>
                  <div className="co-info">
                    <div className="co-name">{t.company_name || t.company}</div>
                    <div className="co-code">{t.company}</div>
                  </div>
                  <div className="plane-time">{relTime(t.created_at)}</div>
                  {!taken ? (
                    <button
                      type="button"
                      className={`btn-claim${mine ? ' mine-btn' : ''}`}
                      onClick={(e) => { e.stopPropagation(); startClaim(t); }}
                    >
                      {mine ? '本公司 · 抢' : '抢一下'}
                    </button>
                  ) : (
                    <button type="button" className="btn-claim mine-btn" onClick={(e) => { e.stopPropagation(); openDetail(t); }}>
                      看单
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        <aside className="rail">
          <div className="rail-title">📡 跨公司动态</div>
          <div className="rail-sub">谁抢走了哪张单 · 进了哪家窝</div>
          {!feed.length && <div className="feed-time">暂无动态</div>}
          {feed.slice(0, 18).map((f, i) => (
            <div className="feed-item" key={i}>
              <div className={`feed-dot${/认领|抢走|跨公司/.test(f.text || '') ? ' claimed' : ' flying'}`} />
              <div className="feed-body">
                <div className="feed-text">
                  <span className="co">{f.company_name || f.company}</span>
                  {' · '}{f.text}
                </div>
                <div className="feed-time">{relTime(f.ts)}</div>
              </div>
            </div>
          ))}
          <div className="legend">
            <div>流程：发单（提示词）→ 跨公司抢 → 交 JSON → 发单方验收</div>
            <div style={{ marginTop: 4 }}>后续剪辑单会吃这些 JSON 产物。</div>
          </div>
        </aside>
      </div>

      <CreateVideoModal
        show={showCreate}
        onClose={() => setShowCreate(false)}
        onCreated={() => { load(true); if (onRefresh) onRefresh(); }}
        toast={onToast}
      />
      <ClaimPicker
        show={!!picker}
        task={picker}
        agents={agents}
        onClose={() => setPicker(null)}
        onPick={doClaim}
      />
      <TaskDetail
        task={detail}
        myCode={myCode}
        agents={agents}
        onClose={(reload) => { setDetail(null); if (reload) load(true); }}
        onClaim={startClaim}
        onSubmitResult={submitResult}
        onGotoCompany={gotoCo}
        toast={onToast}
      />
    </div>
  );
}
