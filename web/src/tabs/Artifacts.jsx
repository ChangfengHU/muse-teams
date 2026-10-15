// 产物 tab —— 卡通画廊 + 分页
import React, { useMemo, useState, useEffect } from 'react';
import { MonsterMini } from '../components/MonsterAvatar.jsx';
import MonsterAvatar from '../components/MonsterAvatar.jsx';
import Pager from '../components/Pager.jsx';
import { fmtTime } from '../api.js';
import { artIcon, isImageArt } from '../components/Modals.jsx';

const PAGE_SIZE = 12;

export default function Artifacts({ tasks, agents, onOpenArtifact }) {
  const [page, setPage] = useState(1);
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
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE) || 1);
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);
  const slice = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return items.slice(start, start + PAGE_SIZE);
  }, [items, page]);

  return (
    <div className="mt-tabpane">
      <h2 className="sec-title">
        <span className="serif">📦 产物架</span>
        <span className="sec-sub">{items.length ? `${items.length} 件宝贝` : '等第一件诞生'}</span>
      </h2>
      {!items.length && (
        <div className="mt-empty">
          <div className="mt-empty-art" aria-hidden>
            <MonsterAvatar doorplate="art-empty" size={80} />
          </div>
          <div className="mt-empty-title serif">架子还空着</div>
          <div className="mt-empty-sub">毛怪交完作业、你点通过，宝贝就会摆上来～</div>
        </div>
      )}
      {!!items.length && (
        <>
          <div className="art-grid">
            {slice.map(({ task: t, art: a, idx }) => {
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
          <Pager page={page} totalPages={totalPages} onChange={setPage} label="产物分页" />
        </>
      )}
    </div>
  );
}
