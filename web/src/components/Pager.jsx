import React from 'react';

/** 简易分页条 —— 与公司窝同款圆点语言 */
export default function Pager({ page, totalPages, onChange, label = '分页' }) {
  if (!totalPages || totalPages <= 1) return null;
  return (
    <nav className="mt-pager" aria-label={label}>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        disabled={page <= 1}
        onClick={() => onChange(Math.max(1, page - 1))}
      >
        ← 上一页
      </button>
      <div className="mt-pager-dots">
        {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
          <button
            key={n}
            type="button"
            className={`mt-dot${n === page ? ' on' : ''}`}
            onClick={() => onChange(n)}
            aria-label={`第 ${n} 页`}
            aria-current={n === page ? 'page' : undefined}
          >
            {n}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="btn btn-sm btn-ghost"
        disabled={page >= totalPages}
        onClick={() => onChange(Math.min(totalPages, page + 1))}
      >
        下一页 →
      </button>
    </nav>
  );
}
