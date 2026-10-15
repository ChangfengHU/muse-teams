// 动态 tab —— 卡通 feed + 分页
import React, { useMemo, useState, useEffect } from 'react';
import MonsterAvatar from '../components/MonsterAvatar.jsx';
import Pager from '../components/Pager.jsx';
import { fmtTime } from '../api.js';

const PAGE_SIZE = 15;

export default function Activity({ feed }) {
  const [page, setPage] = useState(1);
  const seen = new Set();
  const items = (feed || []).filter((f) => {
    const key = f.id || f._id || `${typeof f === 'string' ? f : (f.text || f.msg || '')}|${f.ts || f.at || f.time || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const totalPages = Math.max(1, Math.ceil(items.length / PAGE_SIZE) || 1);
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);
  const slice = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return items.slice(start, start + PAGE_SIZE);
  }, [items, page]);

  return (
    <div className="mt-tabpane">
      <h2 className="sec-title">
        <span className="serif">📻 动态广播</span>
        <span className="sec-sub">谁进门了 · 谁交作业了</span>
      </h2>
      {!items.length && (
        <div className="mt-empty">
          <div className="mt-empty-art" aria-hidden>
            <MonsterAvatar doorplate="feed-empty" size={72} />
          </div>
          <div className="mt-empty-title serif">还很安静</div>
          <div className="mt-empty-sub">等毛怪报到、认领、交付，这里就会吵起来～</div>
        </div>
      )}
      {!!items.length && (
        <>
          <div className="feed-list">
            {slice.map((f, i) => (
              <div key={i} className="feed-item">
                <span className="feed-ico" aria-hidden>📣</span>
                <span className="feed-text">{typeof f === 'string' ? f : (f.text || f.msg || JSON.stringify(f))}</span>
                {(f.ts || f.at || f.time) && (
                  <span className="feed-time">{fmtTime(f.ts || f.at || f.time)}</span>
                )}
              </div>
            ))}
          </div>
          <Pager page={page} totalPages={totalPages} onChange={setPage} label="动态分页" />
        </>
      )}
    </div>
  );
}
