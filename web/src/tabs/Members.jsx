// 员工管理 —— 跨公司人数概览 + 本公司员工心跳表
import React, { useEffect, useState, useCallback } from 'react';
import MonsterAvatar from '../components/MonsterAvatar.jsx';
import { relTime, heartbeatLabel, stKey, api, getCompany } from '../api.js';
import { agentStatus } from '../components/Creature.jsx';

const ST_BADGE = {
  pending: '待认领', claimed: '进行中', review: '待验收', done: '已完成', failed: '失败',
};

function statusLabel(st) {
  if (st === 'busy') return '🏃 干活中';
  if (st === 'offline') return '💤 离线';
  return '🛋️ 在线';
}

function StaffRow({ agent, tasks, onDelete, leadDoorplate }) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const st = agentStatus(agent);
  const mine = tasks.filter((t) => t.owner === agent.doorplate);
  const doneN = mine.filter((t) => t.status === 'done').length;
  const failN = mine.filter((t) => t.status === 'failed').length;
  const rate = (doneN + failN) ? Math.round((doneN / (doneN + failN)) * 100) : 100;
  const busyTask = mine.find((t) => t.status === 'claimed');
  const hbAbs = agent.last_heartbeat
    ? new Date(agent.last_heartbeat).toLocaleString('zh-CN', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    })
    : '从未';

  const handleDelete = async (e) => {
    e.stopPropagation();
    const name = agent.name || agent.doorplate;
    const warn = busyTask
      ? `「${name}」手里还有任务 ${busyTask.id}，删除后任务会退回任务板。`
      : `「${name}」没有进行中的任务。`;
    if (!window.confirm(`确定删除 ${name}（${agent.doorplate}）吗？\n${warn}\n已交付的产物会保留，旁聊会被归档。`)) return;
    setDeleting(true);
    try {
      await api.deleteAgent(agent.doorplate, leadDoorplate);
      onDelete && onDelete(agent.doorplate);
    } catch (err) {
      alert('删除失败：' + (err.message || err));
      setDeleting(false);
    }
  };

  return (
    <>
      <tr
        className={`staff-row${st === 'offline' ? ' offline' : ''}`}
        onClick={() => setOpen((v) => !v)}
        style={{ cursor: 'pointer' }}
      >
        <td>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <MonsterAvatar doorplate={agent.doorplate} size={40} />
            <div>
              <div style={{ fontWeight: 650 }}>{agent.avatar || ''} {agent.name || agent.doorplate}</div>
              <div style={{ fontSize: 12, color: 'var(--muted)' }}>{agent.doorplate}</div>
            </div>
          </div>
        </td>
        <td>
          <span className={`st-light ${st === 'busy' ? 'busy' : st}`} />
          {statusLabel(st)}
        </td>
        <td>
          <div style={{ fontSize: 13 }}>
            <b>{relTime(agent.last_heartbeat)}</b>
          </div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 2 }}>{hbAbs}</div>
          {st === 'offline' && (
            <div style={{ fontSize: 11.5, color: 'var(--muted)' }}>超过 180 秒无心跳</div>
          )}
        </td>
        <td style={{ fontSize: 12.5 }}>{agent.current_task || '—'}</td>
        <td style={{ fontSize: 12.5 }}>
          ✅{doneN} · {rate}%
        </td>
        <td>
          <button
            className="btn btn-sm btn-ghost"
            title={`删除 ${agent.name || agent.doorplate}`}
            onClick={handleDelete}
            disabled={deleting}
          >{deleting ? '⏳' : '🗑️'}</button>
        </td>
      </tr>
      {open && (
        <tr className="staff-detail">
          <td colSpan={6} style={{ background: 'var(--surface-2, rgba(0,0,0,.03))', padding: '10px 14px' }}>
            <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 6 }}>
              🏷️ {(agent.tags || []).join(' · ') || '无标签'} · 角色 {agent.role || 'member'}
              · 上次心跳完整：{heartbeatLabel(agent.last_heartbeat)}
            </div>
            {!mine.length && <div style={{ fontSize: 12, color: 'var(--muted)' }}>还没有经手的任务</div>}
            {mine.sort((a, b) => (b.created_at || 0) - (a.created_at || 0)).slice(0, 8).map((t) => (
              <div key={t.id} className="mhist-item" style={{ marginBottom: 4 }}>
                <span className={`st-badge ${stKey(t)}`}>{ST_BADGE[stKey(t)] || t.status}</span>
                <span className="tid">{t.id}</span>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
              </div>
            ))}
          </td>
        </tr>
      )}
    </>
  );
}

export default function Members({ agents, tasks, onRefresh, company }) {
  const [overview, setOverview] = useState([]);
  const [ovLoading, setOvLoading] = useState(false);
  const leadDoorplate = (agents.find((a) => a.role === 'lead') || agents[0] || {}).doorplate || '';
  const currentCode = (company && company.code) || getCompany() || '';

  const loadOverview = useCallback(async () => {
    setOvLoading(true);
    try {
      const res = await api.listCompanies();
      setOverview((res && res.companies) || []);
    } catch (_) {
      setOverview([]);
    } finally {
      setOvLoading(false);
    }
  }, []);

  useEffect(() => { loadOverview(); }, [loadOverview, agents.length]);

  const onlineN = agents.filter((a) => agentStatus(a) === 'online').length;
  const busyN = agents.filter((a) => agentStatus(a) === 'busy').length;
  const offlineN = agents.filter((a) => agentStatus(a) === 'offline').length;

  return (
    <div className="mt-tabpane">
      <h2 className="sec-title">
        <span className="serif">👥 员工管理</span>
        <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 400 }}>
          各公司人数 · 门牌 / 状态 / 上次心跳
        </span>
      </h2>

      <div style={{ marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
          <h3 className="serif" style={{ fontSize: 15, margin: 0 }}>公司员工概览</h3>
          <button type="button" className="btn btn-sm btn-ghost" onClick={loadOverview} disabled={ovLoading}>
            {ovLoading ? '刷新中…' : '刷新'}
          </button>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {!overview.length && !ovLoading && (
            <div className="empty-hint" style={{ padding: '12px' }}>暂无公司数据</div>
          )}
          {overview.map((c) => {
            const active = c.code === currentCode;
            return (
              <div
                key={c.code}
                className="chip"
                style={{
                  border: active ? '1.5px solid var(--accent)' : '1px solid var(--border, #e5e0d8)',
                  background: active ? 'rgba(217,119,87,.08)' : undefined,
                  padding: '8px 12px',
                  borderRadius: 10,
                }}
              >
                <div style={{ fontWeight: 650, fontSize: 13 }}>{c.name || c.code}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 2 }}>
                  <code>{c.code}</code> · 员工 <b>{c.member_count ?? 0}</b>
                  {active ? ' · 当前' : ''}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ marginBottom: 10 }}>
        <h3 className="serif" style={{ fontSize: 15, marginBottom: 6 }}>
          {(company && company.name) || currentCode || '当前公司'} · 员工名单
        </h3>
        <div style={{ fontSize: 12.5, color: 'var(--muted)', marginBottom: 10 }}>
          共 <b>{agents.length}</b> 人 · 在线 {onlineN} · 忙碌 {busyN} · 离线 {offlineN}。
          心跳由本公司调度器约每 2 分钟调用 <code>teams_company_renew</code>（或单人 teams_heartbeat）续约；超过 180 秒未更新显示离线。
        </div>
      </div>

      {!agents.length && <div className="empty-hint">客厅空空的，去邀请小伙伴来玩 🚪</div>}

      {!!agents.length && (
        <div style={{ overflowX: 'auto' }}>
          <table className="staff-table" style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13.5 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--muted)', fontSize: 12 }}>
                <th style={{ padding: '8px 10px', borderBottom: '1px solid var(--border, #e5e0d8)' }}>员工</th>
                <th style={{ padding: '8px 10px', borderBottom: '1px solid var(--border, #e5e0d8)' }}>状态</th>
                <th style={{ padding: '8px 10px', borderBottom: '1px solid var(--border, #e5e0d8)' }}>上次心跳</th>
                <th style={{ padding: '8px 10px', borderBottom: '1px solid var(--border, #e5e0d8)' }}>当前任务</th>
                <th style={{ padding: '8px 10px', borderBottom: '1px solid var(--border, #e5e0d8)' }}>战绩</th>
                <th style={{ padding: '8px 10px', borderBottom: '1px solid var(--border, #e5e0d8)', width: 56 }} />
              </tr>
            </thead>
            <tbody>
              {agents
                .slice()
                .sort((a, b) => {
                  const sa = agentStatus(a);
                  const sb = agentStatus(b);
                  const rank = { busy: 0, online: 1, offline: 2 };
                  return (rank[sa] ?? 9) - (rank[sb] ?? 9)
                    || String(a.doorplate).localeCompare(String(b.doorplate));
                })
                .map((a) => (
                  <StaffRow
                    key={a.doorplate}
                    agent={a}
                    tasks={tasks}
                    onDelete={() => onRefresh && onRefresh()}
                    leadDoorplate={leadDoorplate}
                  />
                ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
