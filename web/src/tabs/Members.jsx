// 成员 tab —— 卡片 + 战绩 + 任务历史
import React, { useState } from 'react';
import MonsterAvatar from '../components/MonsterAvatar.jsx';
import { relTime, heartbeatLabel, stKey, api } from '../api.js';
import { agentStatus } from '../components/Creature.jsx';

const ST_BADGE = {
  pending: '待认领', claimed: '进行中', review: '待验收', done: '已完成', failed: '失败',
};

function MemberCard({ agent, tasks, onDelete, leadDoorplate }) {
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const st = agentStatus(agent);
  const mine = tasks.filter((t) => t.owner === agent.doorplate);
  const doneN = mine.filter((t) => t.status === 'done').length;
  const failN = mine.filter((t) => t.status === 'failed').length;
  const rate = (doneN + failN) ? Math.round((doneN / (doneN + failN)) * 100) : 100;
  const stTxt = st === 'busy' ? '🏃 干活中' : st === 'offline' ? '💤 离线' : '🛋️ 等活儿';
  const busyTask = mine.find((t) => t.status === 'claimed');

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
    <div className={`mcard${open ? ' open' : ''}`} onClick={() => setOpen((v) => !v)}>
      <button
        className="mcard-del"
        title={`删除 ${agent.name || agent.doorplate}`}
        onClick={handleDelete}
        disabled={deleting}
        style={{
          position: 'absolute', top: 8, right: 8, border: 'none', background: 'transparent',
          fontSize: 16, cursor: 'pointer', opacity: 0.45, padding: 4,
        }}
      >{deleting ? '⏳' : '🗑️'}</button>
      <div className="mcard-top">
        <MonsterAvatar doorplate={agent.doorplate} size={64} />
        <div>
          <div className="mcard-name">{agent.name || agent.doorplate}</div>
          <div className="mcard-door">{agent.doorplate}</div>
          <div style={{ fontSize: 12.5, marginTop: 4 }}>
            <span className={`st-light ${st === 'busy' ? 'busy' : st}`} />
            {stTxt}
          </div>
          <div style={{ fontSize: 12, marginTop: 3, color: st === 'offline' ? 'var(--muted)' : 'inherit' }}>
            💓 上次心跳：<b>{heartbeatLabel(agent.last_heartbeat)}</b>
            {st === 'offline' ? ' · 已离线（超过 180 秒无心跳）' : ''}
          </div>
        </div>
      </div>
      <div className="mcard-tags">🏷️ {(agent.tags || []).join(' · ') || '无标签'}</div>
      <div className="mcard-stats">
        <span>📌 当前 <b>{agent.current_task || '—'}</b></span>
        <span>✅ 完成 <b>{doneN}</b></span>
        <span>📊 完成率 <b>{rate}%</b></span>
      </div>
      <div className="mhist">
        {!mine.length && <div style={{ fontSize: 12, color: 'var(--muted)' }}>还没有经手的任务</div>}
        {mine.sort((a, b) => (b.created_at || 0) - (a.created_at || 0)).map((t) => (
          <div key={t.id} className="mhist-item">
            <span className={`st-badge ${stKey(t)}`}>{ST_BADGE[stKey(t)] || t.status}</span>
            <span className="tid">{t.id}</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.title}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Members({ agents, tasks, onRefresh }) {
  const handleDelete = () => { onRefresh && onRefresh(); };
  // 删除操作必须由本公司 lead 发起（后端校验 from=lead 门牌号）
  const leadDoorplate = (agents.find((a) => a.role === 'lead') || agents[0] || {}).doorplate || '';
  return (
    <div className="mt-tabpane">
      <h2 className="sec-title"><span className="serif">👥 成员</span> <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 400 }}>{agents.length} 只毛怪</span></h2>
      <div style={{ fontSize: 12.5, color: 'var(--muted)', margin: '-4px 0 12px' }}>
        心跳由本公司调度器约每 2 分钟打一次（teams_heartbeat）。上次心跳超过 180 秒未更新会显示离线。
      </div>
      {!agents.length && <div className="empty-hint">客厅空空的，去邀请小伙伴来玩 🚪</div>}
      <div className="member-grid">
        {agents.map((a) => (
          <MemberCard key={a.doorplate} agent={a} tasks={tasks} onDelete={handleDelete} leadDoorplate={leadDoorplate} />
        ))}
      </div>
    </div>
  );
}
