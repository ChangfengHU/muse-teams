// 回执箱 —— 固定枚举类型，与任务交付包分离
import React, { useCallback, useEffect, useState } from 'react';
import { api, getCompany, relTime } from '../api.js';
import MonsterAvatar from '../components/MonsterAvatar.jsx';

const TYPE_META = {
  invite_sent: { icon: '📨', label: '已发出邀请' },
  invite_ack: { icon: '✅', label: '邀请已入职' },
  claim_ok: { icon: '🖐', label: '抢单成功' },
  submit_ok: { icon: '📦', label: '已交交付包' },
  review_pass: { icon: '🎉', label: '验收通过' },
  review_reject: { icon: '↩️', label: '验收打回' },
  broadcast: { icon: '📢', label: '公司广播' },
  agent_offline: { icon: '💤', label: '员工休眠' },
  quota_warn: { icon: '⚠️', label: '配额告警' },
};

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'invite_ack', label: '入职回执' },
  { key: 'submit_ok', label: '交付' },
  { key: 'review_pass', label: '通过' },
  { key: 'review_reject', label: '打回' },
  { key: 'claim_ok', label: '抢单' },
  { key: 'broadcast', label: '广播' },
];

export default function Receipts({ agents, onToast }) {
  const [doorplate, setDoorplate] = useState('');
  const [type, setType] = useState('all');
  const [receipts, setReceipts] = useState([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!doorplate && agents && agents.length) {
      const lead = agents.find((a) => a.role === 'lead') || agents[0];
      if (lead) setDoorplate(lead.doorplate);
    }
  }, [agents, doorplate]);

  const load = useCallback(async (silent) => {
    if (!getCompany()) {
      setError('请先选择公司');
      return;
    }
    if (!doorplate) {
      setError('请选择门牌号');
      return;
    }
    if (!silent) setLoading(true);
    setError('');
    try {
      const res = await api.listReceipts({ doorplate, type, mark_read: false });
      setReceipts(res.receipts || []);
      setUnread(res.unread || 0);
    } catch (e) {
      setError(e.message || String(e));
      if (!silent && onToast) onToast('加载回执失败: ' + e.message, true);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [doorplate, type, onToast]);

  useEffect(() => {
    load(false);
    const t = setInterval(() => load(true), 15000);
    return () => clearInterval(t);
  }, [load]);

  const markAll = async () => {
    try {
      await api.listReceipts({ doorplate, type, mark_read: true });
      if (onToast) onToast('已标为已读');
      await load(true);
    } catch (e) {
      if (onToast) onToast(e.message, true);
    }
  };

  return (
    <div className="mt-tabpane">
      <h2 className="sec-title">
        <span className="serif">📬 回执箱</span>
        <span className="sec-sub">固定枚举通知 · 与任务交付包分开</span>
      </h2>

      <div className="co-toolbar">
        <label className="rcpt-door">
          门牌
          <select value={doorplate} onChange={(e) => setDoorplate(e.target.value)}>
            <option value="">选择…</option>
            {(agents || []).map((a) => (
              <option key={a.doorplate} value={a.doorplate}>
                {a.avatar || '🐾'} {a.name} ({a.doorplate})
              </option>
            ))}
          </select>
        </label>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => load(false)} disabled={loading}>
          {loading ? '刷新中…' : '刷新'}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={markAll} disabled={!doorplate}>
          全部已读
        </button>
        {unread > 0 && <span className="co-card-pill">未读 {unread}</span>}
      </div>

      <div className="rcpt-filters">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            type="button"
            className={`rcpt-filter${type === f.key ? ' on' : ''}`}
            onClick={() => setType(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {error && <div className="empty-hint" style={{ color: 'var(--danger, #c0392b)' }}>{error}</div>}

      {!loading && !receipts.length && !error && (
        <div className="co-empty">
          <div className="co-empty-title serif">回执箱空空的</div>
          <div className="co-empty-sub">抢单、交交付包、验收、代企业入驻成功后会出现这里</div>
        </div>
      )}

      <div className="rcpt-list">
        {receipts.map((r) => {
          const meta = TYPE_META[r.type] || { icon: '🧾', label: r.label || r.type };
          return (
            <article key={r.id} className={`rcpt-card${r.read ? '' : ' unread'}`}>
              <div className="rcpt-ico" aria-hidden>{meta.icon}</div>
              <div className="rcpt-body">
                <div className="rcpt-top">
                  <strong>{meta.label}</strong>
                  <span className="rcpt-id">{r.id}</span>
                  <span className="rcpt-time">{relTime(r.at)}</span>
                </div>
                <div className="rcpt-meta">
                  {r.from ? <span>from {r.from}</span> : null}
                  {r.ref && r.ref.task_id ? <span>任务 {r.ref.task_id}</span> : null}
                  {r.ref && r.ref.invite_id ? <span>邀请 {r.ref.invite_id}</span> : null}
                </div>
                {r.body && Object.keys(r.body).length > 0 && (
                  <pre className="rcpt-json">{JSON.stringify(r.body, null, 2)}</pre>
                )}
              </div>
              {!r.read && <span className="rcpt-dot" title="未读" />}
            </article>
          );
        })}
      </div>
    </div>
  );
}
