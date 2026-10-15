// 任务 tab —— 卡通分组卡片 + 分页
import React, { useState, useEffect, useMemo } from 'react';
import { MonsterMini } from '../components/MonsterAvatar.jsx';
import MonsterAvatar from '../components/MonsterAvatar.jsx';
import Pager from '../components/Pager.jsx';
import { api, relTime, fmtTime, durStr, stKey, ST_META } from '../api.js';
import { artIcon, isImageArt } from '../components/Modals.jsx';

const PAGE_SIZE = 8;

function Timeline({ t }) {
  const steps = [
    { k: '创建', ts: t.created_at, icon: '📝' },
    { k: '认领', ts: t.claimed_at, icon: '🤏' },
    { k: '提交', ts: t.submitted_at, icon: '📦' },
    { k: '验收', ts: t.reviewed_at || t.done_at, icon: '✅' },
  ];
  return (
    <div className="tl">
      {steps.map((s, i) => (
        <React.Fragment key={s.k}>
          {i > 0 && <div className="tl-line" />}
          <div className={`tl-step${s.ts ? ' done' : ''}`}>
            <span className="dot">{s.icon}</span>
            <span>{s.k}{s.ts && <><br />{fmtTime(s.ts)}</>}</span>
          </div>
        </React.Fragment>
      ))}
    </div>
  );
}

function TaskRow({ t, agents, onReview, onOpenArtifact, onOpenTrace, defaultOpen }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const owner = agents.find((a) => a.doorplate === t.owner);
  const when = t.claimed_at ? `${relTime(t.claimed_at)}认领` : `${relTime(t.created_at)}创建`;
  const arts = t.artifacts || [];
  return (
    <div className={`trow${open ? ' open' : ''}`}>
      <div className="trow-head" onClick={() => setOpen((v) => !v)}>
        <span className="caret">▶</span>
        <span className="tid">{t.id}</span>
        <span className="tt">{t.title}</span>
        <span className={`pri ${t.priority || 'P1'}`}>{t.priority || 'P1'}</span>
        <span className="owner">
          {t.owner ? (<><MonsterMini doorplate={t.owner} /> {owner ? (owner.name || t.owner) : t.owner}</>) : '—'}
        </span>
        <span className="tid">{when}</span>
      </div>
      <div className="trow-detail">
        {t.desc && <div className="desc">{t.desc}</div>}
        <Timeline t={t} />
        {t.claimed_at && (
          <div className="dur">⏱ 耗时：{durStr((t.submitted_at || t.reviewed_at || t.done_at || Date.now()) - t.claimed_at)}</div>
        )}
        <div className="art-prev">
          {!arts.length && <div style={{ fontSize: 12, color: 'var(--muted)' }}>还没有产物哦</div>}
          {arts.map((a, i) => {
            const thumb = isImageArt(a) && a.url
              ? <img className="art-thumb" src={a.url} loading="lazy" onError={(e) => { e.target.style.display = 'none'; }} alt="" />
              : null;
            return (
              <div key={i} className="art-chip" onClick={() => onOpenArtifact(t.id, i)}>
                {thumb}<span>{artIcon(a)} {a.type || '产物'}</span>
              </div>
            );
          })}
        </div>
        <div className="rev-btns">
          <button type="button" className="btn-trace" onClick={(e) => { e.stopPropagation(); onOpenTrace && onOpenTrace(t.id); }}>🔗 看链路</button>
          {stKey(t) === 'review' && (
            <>
              <button className="btn-ok" onClick={(e) => { e.stopPropagation(); onReview(t.id, true); }}>✓ 通过上架</button>
              <button className="btn-no" onClick={(e) => { e.stopPropagation(); onReview(t.id, false); }}>✗ 打回</button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function GroupBlock({ statusKey, list, agents, onReview, onOpenArtifact, onOpenTrace }) {
  const [page, setPage] = useState(1);
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  useEffect(() => { if (page > totalPages) setPage(totalPages); }, [page, totalPages]);
  const slice = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return list.slice(start, start + PAGE_SIZE);
  }, [list, page]);

  return (
    <div className="st-group">
      <div className="st-head">
        {ST_META[statusKey].label}
        <span className="cnt">{list.length}</span>
      </div>
      {slice.map((t) => (
        <TaskRow key={t.id} t={t} agents={agents} onReview={onReview} onOpenArtifact={onOpenArtifact} onOpenTrace={onOpenTrace} />
      ))}
      <Pager page={page} totalPages={totalPages} onChange={setPage} label={`${statusKey} 分页`} />
    </div>
  );
}

export default function Tasks({ tasks, agents, company, onToast, onRefresh, onOpenArtifact, onCelebrate, onOpenTrace }) {
  const groups = ['pending', 'claimed', 'review', 'done', 'failed'];
  const coCode = company?.code || '';
  const byStatus = (k) => tasks.filter((t) => {
    if (stKey(t) !== k) return false;
    // review/待验收：只显示本公司发单
    if (k === 'review' && coCode && t.company !== coCode) return false;
    return true;
  }).sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

  const handleReview = async (id, approved) => {
    try {
      await api.reviewTask(id, approved);
      onToast(approved ? `✅ ${id} 验收通过！` : `↩️ ${id} 打回任务板了`);
      if (approved && onCelebrate) onCelebrate(id);
      onRefresh();
    } catch (e) {
      onToast('验收失败: ' + e.message, true);
    }
  };

  return (
    <div className="mt-tabpane">
      <h2 className="sec-title">
        <span className="serif">✈️ 任务板</span>
        <span className="sec-sub">纸飞机飞进来 · 毛怪去叼走</span>
      </h2>
      {!tasks.length && (
        <div className="mt-empty">
          <div className="mt-empty-art" aria-hidden>
            <MonsterAvatar doorplate="task-empty-a" size={64} />
            <MonsterAvatar doorplate="task-empty-b" size={78} />
          </div>
          <div className="mt-empty-title serif">板子空空的</div>
          <div className="mt-empty-sub">右上角「发布任务」扔一张纸飞机，客厅窗口会飞进来～</div>
        </div>
      )}
      {groups.map((k) => {
        const list = byStatus(k);
        if (!list.length) return null;
        return (
          <GroupBlock
            key={k}
            statusKey={k}
            list={list}
            agents={agents}
            onReview={handleReview}
            onOpenArtifact={onOpenArtifact}
            onOpenTrace={onOpenTrace}
          />
        );
      })}
    </div>
  );
}
