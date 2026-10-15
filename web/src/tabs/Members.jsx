// 员工管理 —— 公司区域框网格：各公司员工集合 + 一键创建公司
import React, { useEffect, useState, useCallback } from 'react';
import MonsterAvatar from '../components/MonsterAvatar.jsx';
import { relTime, api, getCompany, setCompany as persistCompany } from '../api.js';
import { agentStatus } from '../components/Creature.jsx';

function statusLabel(st) {
  if (st === 'busy') return '🏃 干活中';
  if (st === 'offline') return '💤 离线';
  return '🛋️ 在线';
}

function EmployeeCard({ agent, leadDoorplate, companyCode, onDeleted }) {
  const [deleting, setDeleting] = useState(false);
  const st = agentStatus(agent);
  const hbAbs = agent.last_heartbeat
    ? new Date(agent.last_heartbeat).toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    })
    : '从未';

  const handleDelete = async (e) => {
    e.stopPropagation();
    const name = agent.name || agent.doorplate;
    if (!leadDoorplate) {
      alert('需要本公司 lead 门牌号才能删除');
      return;
    }
    if (!window.confirm(`确定删除 ${name}（${agent.doorplate}）吗？\n已交付的产物会保留，旁聊会被归档。`)) return;
    setDeleting(true);
    try {
      await api.deleteAgent(agent.doorplate, leadDoorplate, companyCode);
      onDeleted && onDeleted(agent.doorplate);
    } catch (err) {
      alert('删除失败：' + (err.message || err));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className={`emp-card${st === 'offline' ? ' offline' : ''}`}>
      <MonsterAvatar doorplate={agent.doorplate} size={36} />
      <div className="emp-meta">
        <div className="emp-name">{agent.avatar || ''} {agent.name || agent.doorplate}</div>
        <div className="emp-door">{agent.doorplate}{agent.role === 'lead' ? ' · lead' : ''}</div>
        <div className="emp-status">
          <span className={`st-light ${st === 'busy' ? 'busy' : st}`} />
          {statusLabel(st)}
          <span className="emp-hb">{relTime(agent.last_heartbeat)} · {hbAbs}</span>
        </div>
        {agent.current_task && (
          <div className="emp-task">任务 {agent.current_task}</div>
        )}
      </div>
      <button
        type="button"
        className="btn btn-sm btn-ghost emp-del"
        title={`删除 ${agent.name || agent.doorplate}`}
        onClick={handleDelete}
        disabled={deleting || !leadDoorplate}
      >{deleting ? '⏳' : '🗑️'}</button>
    </div>
  );
}

function CompanyZone({
  company,
  agents,
  loading,
  currentCode,
  onEnter,
  onDeleted,
}) {
  const onlineN = agents.filter((a) => agentStatus(a) === 'online').length;
  const busyN = agents.filter((a) => agentStatus(a) === 'busy').length;
  const offlineN = agents.filter((a) => agentStatus(a) === 'offline').length;
  const leadDoorplate = (agents.find((a) => a.role === 'lead') || agents[0] || {}).doorplate || '';
  const active = company.code === currentCode;
  const sorted = agents.slice().sort((a, b) => {
    const sa = agentStatus(a);
    const sb = agentStatus(b);
    const rank = { busy: 0, online: 1, offline: 2 };
    return (rank[sa] ?? 9) - (rank[sb] ?? 9)
      || String(a.doorplate).localeCompare(String(b.doorplate));
  });

  return (
    <section className={`company-zone${active ? ' active' : ''}`}>
      <header className="company-zone-head">
        <div>
          <div className="company-zone-name">{company.name || company.code}</div>
          <div className="company-zone-sub">
            <code>{company.code}</code>
            {' · '}员工 <b>{agents.length || company.member_count || 0}</b>
            {agents.length > 0 && (
              <> · 在线 {onlineN} · 忙碌 {busyN} · 离线 {offlineN}</>
            )}
            {active ? ' · 当前' : ''}
          </div>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => onEnter(company)}
          disabled={active}
        >
          {active ? '已进入' : '进入公司'}
        </button>
      </header>
      <div className="company-zone-body">
        {loading && !agents.length && (
          <div className="empty-hint" style={{ padding: '16px 8px' }}>加载员工…</div>
        )}
        {!loading && !agents.length && (
          <div className="empty-hint" style={{ padding: '16px 8px' }}>
            还没有员工。在「公司」页复制邀请词，贴进 Muse 注册。
          </div>
        )}
        {!!sorted.length && (
          <div className="emp-grid">
            {sorted.map((a) => (
              <EmployeeCard
                key={a.doorplate}
                agent={a}
                leadDoorplate={leadDoorplate}
                companyCode={company.code}
                onDeleted={onDeleted}
              />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

export default function Members({ company, onSelectCompany, onToast }) {
  const [zones, setZones] = useState([]); // [{ code, name, member_count, agents }]
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const currentCode = (company && company.code) || getCompany() || '';

  const toast = useCallback((msg, isErr) => {
    if (onToast) onToast(msg, isErr);
  }, [onToast]);

  const loadZones = useCallback(async (silent) => {
    if (!silent) setLoading(true);
    setError('');
    try {
      const res = await api.listCompanies();
      const companies = (res && res.companies) || [];
      if (!companies.length) {
        setZones([]);
        return;
      }
      const settled = await Promise.all(
        companies.map(async (c) => {
          try {
            const ar = await api.agentsFor(c.code);
            return {
              ...c,
              agents: (ar && ar.agents) || [],
              loadError: null,
            };
          } catch (e) {
            return {
              ...c,
              agents: [],
              loadError: e && e.message ? e.message : String(e),
            };
          }
        })
      );
      setZones(settled);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      setError(msg);
      if (!silent) toast('加载公司/员工失败: ' + msg, true);
    } finally {
      if (!silent) setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadZones(false);
    const h = setInterval(() => loadZones(true), 20000);
    return () => clearInterval(h);
  }, [loadZones]);

  const createOne = async () => {
    setCreating(true);
    try {
      const c = await api.createCompany();
      persistCompany(c.code);
      onSelectCompany && onSelectCompany({
        code: c.code,
        name: c.name,
        created_at: c.created_at,
      });
      toast(`公司已创建：${c.name}（${c.code}）`);
      await loadZones(true);
    } catch (e) {
      toast('创建失败: ' + e.message, true);
    } finally {
      setCreating(false);
    }
  };

  const enterCompany = async (item) => {
    if (!item || !item.code) return;
    try {
      const info = await api.getCompanyInfo(item.code);
      persistCompany(info.code);
      onSelectCompany && onSelectCompany(info);
      toast(`已进入 ${info.name}（${info.code}）`);
    } catch (e) {
      persistCompany(item.code);
      onSelectCompany && onSelectCompany({ code: item.code, name: item.name });
      toast('公司码校验失败，仍已进入: ' + e.message, true);
    }
  };

  return (
    <div className="mt-tabpane">
      <h2 className="sec-title">
        <span className="serif">👥 员工管理</span>
        <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 400 }}>
          公司区域框 · 查看各公司员工 · 可创建公司
        </span>
      </h2>

      <div className="staff-toolbar">
        <button type="button" className="btn" onClick={createOne} disabled={creating}>
          {creating ? '创建中…' : '✨ 创建公司'}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => loadZones(false)}
          disabled={loading}
        >
          {loading ? '刷新中…' : '刷新'}
        </button>
        <span className="staff-toolbar-hint">
          心跳约每 2 分钟续约；超过 180 秒无心跳显示离线。邀请词在「公司」页复制。
        </span>
      </div>

      {error && !zones.length && (
        <div className="empty-hint" style={{ color: 'var(--danger, #c0392b)' }}>
          加载失败：{error}
        </div>
      )}

      {loading && !zones.length && !error && (
        <div className="empty-hint">加载公司与员工…</div>
      )}

      {!loading && !error && !zones.length && (
        <div className="empty-hint">
          还没有公司。点「创建公司」，或到「公司」页用公司码加入。
        </div>
      )}

      {!!zones.length && (
        <div className="company-zones">
          {zones.map((z) => (
            <CompanyZone
              key={z.code}
              company={z}
              agents={z.agents || []}
              loading={loading}
              currentCode={currentCode}
              onEnter={enterCompany}
              onDeleted={() => loadZones(true)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
