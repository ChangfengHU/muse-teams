// 动态 tab —— feed 流
import React from 'react';
import { fmtTime } from '../api.js';

export default function Activity({ feed }) {
  // 按事件 id 去重（无 id 时用 text+时间戳组合键），避免重复条目
  const seen = new Set();
  const items = (feed || []).filter((f) => {
    const key = f.id || f._id || `${typeof f === 'string' ? f : (f.text || f.msg || '')}|${f.ts || f.at || f.time || ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return (
    <div className="mt-tabpane">
      <h2 className="sec-title"><span className="serif">📻 动态</span></h2>
      {!items.length && <div className="empty-hint">📻 暂无动态</div>}
      <div className="feed-list">
        {items.map((f, i) => (
          <div key={i} className="feed-item">
            <span>{typeof f === 'string' ? f : (f.text || f.msg || JSON.stringify(f))}</span>
            {(f.ts || f.at || f.time) && (
              <span className="feed-time">{fmtTime(f.ts || f.at || f.time)}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
