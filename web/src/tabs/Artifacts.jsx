// 产物 tab —— 画廊 + 详情
import React from 'react';
import { MonsterMini } from '../components/MonsterAvatar.jsx';
import { fmtTime } from '../api.js';
import { artIcon, isImageArt } from '../components/Modals.jsx';

export default function Artifacts({ tasks, agents, onOpenArtifact }) {
  const doneTasks = tasks.filter((t) => t.status === 'done');
  const items = [];
  doneTasks.forEach((t) => {
    const arts = t.artifacts || [];
    if (!arts.length) {
      items.push({ task: t, art: null, idx: -1 });
    } else {
      arts.forEach((a, i) => items.push({ task: t, art: a, idx: i }));
    }
  });
  const agentById = (id) => agents.find((a) => a.doorplate === id);

  return (
    <div className="mt-tabpane">
      <h2 className="sec-title"><span className="serif">📦 产物架</span> <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 400 }}>{items.length} 件产物</span></h2>
      {!items.length && <div className="empty-hint">🕯️ 架子还空着，等第一件产物诞生…</div>}
      <div className="art-grid">
        {items.map(({ task: t, art: a, idx }) => {
          const owner = agentById(t.owner);
          const showImg = a && isImageArt(a) && a.url;
          return (
            <div key={`${t.id}:${idx}`} className="acard" onClick={() => onOpenArtifact(t.id, idx)}>
              <div className="acard-thumb">
                {showImg
                  ? <img src={a.url} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover' }} loading="lazy" onError={(e) => { e.target.style.display = 'none'; }} />
                  : <span>{a ? artIcon(a) : '📦'}</span>}
              </div>
              <div className="acard-body">
                <div className="acard-title">{t.id} · {a ? (a.type || '产物') : '交付'}</div>
                <div className="acard-meta">
                  {owner ? <><MonsterMini doorplate={owner.doorplate} /> {owner.name || owner.doorplate}</> : (t.owner || '?')}
                  <span style={{ marginLeft: 'auto' }}>{fmtTime(t.done_at || t.reviewed_at)}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
