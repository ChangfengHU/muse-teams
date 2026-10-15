// 客厅场景 —— 毛怪座位花名册 · 纸飞机任务板 · 产物架
import React, { useRef, useEffect, useState, useCallback } from 'react';
import Creature, { agentStatus } from '../components/Creature.jsx';
import MonsterAvatar, { MonsterMini } from '../components/MonsterAvatar.jsx';
import { api } from '../api.js';
import { welcomeAgent, flyInPlane, claimPounce, claimShake, deliverCelebration, broadcastCheer } from '../anim.js';
import { artIcon } from '../components/Modals.jsx';

function hashStr(s) {
  let h = 2166136261;
  s = String(s || '?');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

function boardSlots(n) {
  const pos = [];
  for (let i = 0; i < n; i++) pos.push({ x: 6 + (i % 2) * 46, y: 12 + Math.floor(i / 2) * 30 });
  return pos;
}

export default function LivingRoom({
  company,
  agents,
  tasks,
  feed,
  onToast,
  onRefresh,
  onOpenInvite,
  onOpenPublish,
  onOpenArtifact,
  onOpenMailbox,
  onSendMsg,
}) {
  const roomRef = useRef(null);
  const doorRef = useRef(null);
  const boardRef = useRef(null);
  const shelfRef = useRef(null);
  const megaRef = useRef(null);
  const creatureRefs = useRef({});
  const planeRefs = useRef({});
  const prevAgentsRef = useRef(new Set());
  const prevTasksRef = useRef(new Set());
  const [picker, setPicker] = useState(null);
  const [bcOpen, setBcOpen] = useState(false);
  const [bcText, setBcText] = useState('');

  const coName = (company && company.name) || '本公司';
  const coCode = (company && company.code) || '';

  const working = agents.filter((a) => agentStatus(a) === 'busy');
  const waiting = agents.filter((a) => agentStatus(a) !== 'busy'); // online + offline
  const onlineN = agents.filter((a) => agentStatus(a) === 'online').length;
  const busyN = working.length;
  /** Pad each row so empty seat outlines always show (obvious grid even with 1–2 agents). */
  const ROSTER_MIN_SEATS = 6;
  const padSeats = (n) => Math.max(ROSTER_MIN_SEATS - n, n === 0 ? ROSTER_MIN_SEATS : 0);
  const pending = tasks.filter((t) => t.status === 'pending');
  const bp = boardSlots(pending.length);
  const doneTasks = tasks.filter((t) => t.status === 'done');
  const reviewTasks = tasks.filter((t) => t.status === 'review' || t.status === 'done-pending-review');
  const artCount = doneTasks.reduce((n, t) => n + Math.max((t.artifacts || []).length, 1), 0);

  const agentById = useCallback((id) => agents.find((a) => a.doorplate === id), [agents]);

  /* ---- 新成员推门 / 新任务纸飞机 ---- */
  useEffect(() => {
    const prevA = prevAgentsRef.current;
    const prevT = prevTasksRef.current;
    agents.forEach((a) => {
      if (!prevA.has(a.doorplate)) {
        prevA.add(a.doorplate);
        setTimeout(() => {
          const cel = creatureRefs.current[a.doorplate];
          if (!cel) return;
          welcomeAgent({
            doorEl: doorRef.current,
            creatureEl: cel,
            roomEl: roomRef.current,
            endLeftPct: 50,
            endTopPct: 70,
            onToast: () => onToast(`🚪 欢迎 ${a.name || a.doorplate} 推门进来！门牌号 ${a.doorplate}`),
          });
        }, 100);
      }
    });
    pending.forEach((t) => {
      if (!prevT.has(t.id)) {
        prevT.add(t.id);
        setTimeout(() => {
          const idx = pending.findIndex((x) => x.id === t.id);
          const sp = boardSlots(pending.length)[idx];
          if (!sp) return;
          const rot = (hashStr(t.id) % 9) - 4;
          flyInPlane({
            planeEl: planeRefs.current[t.id],
            roomEl: roomRef.current,
            boardEl: boardRef.current,
            endXPct: sp.x,
            endYPct: sp.y,
            endRotate: rot,
            onToast: () => onToast(`✈️ 新纸飞机落下：${t.id} ${t.title}`),
          });
        }, 100);
      }
    });
    tasks.forEach((t) => prevT.add(t.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, tasks]);

  /* ---- 抢单（本窝在线员工；跨公司 claim 由后端放开） ---- */
  const grabClick = (e, taskId) => {
    e.stopPropagation();
    const avail = agents.filter((a) => agentStatus(a) !== 'offline');
    const list = avail.length ? avail : agents;
    if (!list.length) {
      onToast('本窝还没人，先去「邀请小伙伴」', true);
      return;
    }
    setPicker({
      taskId,
      list,
      x: Math.min(e.clientX, window.innerWidth - 260),
      y: e.clientY + 10,
    });
  };

  const doClaim = async (taskId, doorplate) => {
    setPicker(null);
    const cel = creatureRefs.current[doorplate];
    const pel = planeRefs.current[taskId];
    try {
      await api.claimTask(taskId, doorplate);
      claimPounce({
        creatureEl: cel,
        planeEl: pel,
        onBadge: () => { setTimeout(() => onRefresh(), 100); },
      });
      onToast(`🎉 ${doorplate} 叼走了 ${taskId}！`);
      setTimeout(() => onRefresh(), 1400);
    } catch (err) {
      const owner = err.data && err.data.owner;
      claimShake({ creatureEl: cel });
      onToast(owner ? `💔 ${taskId} 被 ${owner} 先叼走了！` : '认领失败: ' + err.message, true);
    }
  };

  /* ---- 验收 ---- */
  const reviewTask = async (id, approved) => {
    try {
      await api.reviewTask(id, approved);
      if (approved) {
        onToast(`✅ ${id} 验收通过！`);
        const t = tasks.find((x) => x.id === id);
        const cel = t && t.owner ? creatureRefs.current[t.owner] : null;
        deliverCelebration({ creatureEl: cel, shelfEl: shelfRef.current, artifacts: t ? t.artifacts || [] : [], artIcon });
        setTimeout(() => onRefresh(), 1600);
      } else {
        onToast(`↩️ ${id} 打回任务板了`);
        onRefresh();
      }
    } catch (e) {
      onToast('验收失败: ' + e.message, true);
      onRefresh();
    }
  };

  /* ---- 广播 ---- */
  const sendBroadcast = async () => {
    const text = bcText.trim();
    if (!text) return;
    setBcOpen(false);
    setBcText('');
    try {
      await api.broadcast('lead', text);
      onToast('📢 广播发出，小毛怪们都抬头了！');
      broadcastCheer({ megaEl: megaRef.current });
      onRefresh();
    } catch (e) {
      onToast('广播失败: ' + e.message, true);
    }
  };

  const emptySeats = (n) => Array.from({ length: n }, (_, i) => i);

  return (
    <div className="mt-tabpane lr">
      {/* 公司窝头 */}
      <div className="lr-den-head">
        <div className="lr-den-id">
          <div className="lr-den-avatar">
            <MonsterAvatar doorplate={coCode || 'den'} size={48} />
          </div>
          <div className="lr-den-meta">
            <h2 className="lr-den-title serif">
              {coName}
              {coCode ? <code className="lr-den-code">{coCode}</code> : null}
            </h2>
            <p className="lr-den-tagline">本窝毛怪座位 · 纸飞机谁抢到算谁的（可跨公司）</p>
          </div>
        </div>
        <div className="lr-den-stats">
          <span className="lr-den-chip">毛怪 <b>{agents.length}</b></span>
          <span className="lr-den-chip">在线 <b>{onlineN}</b></span>
          <span className="lr-den-chip">干活 <b>{busyN}</b></span>
          <span className={`lr-den-chip${reviewTasks.length ? ' hot' : ''}`}>待收 <b>{reviewTasks.length}</b></span>
          <span className="lr-den-chip">纸飞机 <b>{pending.length}</b></span>
          <span className="lr-den-chip">产物 <b>{artCount}</b></span>
        </div>
        <div className="lr-den-actions">
          <button type="button" className="btn btn-sm btn-ghost" onClick={onOpenInvite}>🚪 邀请</button>
          <button type="button" className="btn btn-sm" onClick={onOpenPublish}>📤 扔纸飞机</button>
        </div>
      </div>

      {/* 毛怪座位 —— 紧凑花名册；空位轮廓常显，1–2 人也能看出网格 */}
      <div className="lr-roster" ref={roomRef} id="room">
        {/* 动画锚点：视觉上收成角标，不再撑成空房间 */}
        <div className="door lr-roster-door" ref={doorRef} id="door" aria-hidden>
          <div className="door-frame" />
          <div className="door-panel"><div className="door-knob" /></div>
        </div>

        <header className="lr-roster-head">
          <div className="lr-roster-title-wrap">
            <span className="lr-roster-ico" aria-hidden>🐾</span>
            <h3 className="lr-roster-title">毛怪座位</h3>
            <span className="lr-roster-sub">{agents.length} 位 · 可跨公司抢单</span>
          </div>
          <div className="lr-roster-legend">
            <span className="lr-leg lr-leg-busy">干活</span>
            <span className="lr-leg lr-leg-online">在线</span>
            <span className="lr-leg lr-leg-off">离线</span>
          </div>
        </header>

        <section className="lr-roster-row" aria-label="干活">
          <div className="lr-roster-row-label">
            <span className="lr-roster-row-ico" aria-hidden>💻</span>
            <span>干活</span>
            <b>{working.length}</b>
          </div>
          <div className="lr-roster-grid">
            {working.map((a) => (
              <div key={a.doorplate} className="lr-roster-seat">
                <Creature
                  ref={(el) => { if (el) creatureRefs.current[a.doorplate] = el; }}
                  agent={a}
                  leftPct={0}
                  topPct={0}
                  size="xs"
                  onSendMsg={onSendMsg}
                  onOpenMailbox={onOpenMailbox}
                />
              </div>
            ))}
            {emptySeats(padSeats(working.length)).map((i) => (
              <div key={`wb-${i}`} className="lr-roster-seat lr-roster-empty" aria-hidden>
                <div className="lr-roster-pad">+</div>
                <div className="lr-roster-pad-label">空位</div>
              </div>
            ))}
          </div>
        </section>

        <section className="lr-roster-row" aria-label="在线等候">
          <div className="lr-roster-row-label">
            <span className="lr-roster-row-ico" aria-hidden>🟢</span>
            <span>在线</span>
            <b>{waiting.length}</b>
            <em className="lr-roster-row-hint">等候抢单</em>
          </div>
          <div className="lr-roster-grid">
            {waiting.map((a) => (
              <div key={a.doorplate} className="lr-roster-seat">
                <Creature
                  ref={(el) => { if (el) creatureRefs.current[a.doorplate] = el; }}
                  agent={a}
                  leftPct={0}
                  topPct={0}
                  size="xs"
                  look={hashStr(a.doorplate) % 2 === 0}
                  onSendMsg={onSendMsg}
                  onOpenMailbox={onOpenMailbox}
                />
              </div>
            ))}
            {emptySeats(padSeats(waiting.length)).map((i) => (
              <div key={`wa-${i}`} className="lr-roster-seat lr-roster-empty" aria-hidden>
                <div className="lr-roster-pad">+</div>
                <div className="lr-roster-pad-label">空位</div>
              </div>
            ))}
          </div>
        </section>

        {!agents.length && (
          <div className="lr-roster-empty-banner">
            <div className="lr-roster-empty-title">本窝还没人</div>
            <div className="lr-roster-empty-sub">邀请毛怪注册到 {coName}，座位会亮起来</div>
            <button type="button" className="btn btn-sm" onClick={onOpenInvite}>🚪 邀请小伙伴</button>
          </div>
        )}
      </div>

      {/* 任务板 + 产物架 */}
      <div className="board-wrap">
        <div className="board" ref={boardRef} id="board">
          <div className="board-title">
            📋 任务板
            <span className="board-count">{pending.length}</span>
          </div>
          {!pending.length && (
            <div className="board-empty lr-board-empty">
              <div className="lr-board-empty-title">还没纸飞机</div>
              <div className="lr-board-empty-sub">扔一张任务，在线毛怪就能抢（可跨公司）</div>
              <button type="button" className="btn btn-sm" onClick={onOpenPublish}>📤 扔纸飞机</button>
            </div>
          )}
          {pending.map((t, i) => {
            const p = String(t.priority || 'P1').toLowerCase();
            const sp = bp[i];
            const rot = (hashStr(t.id) % 9) - 4;
            return (
              <div
                key={t.id}
                ref={(el) => { if (el) planeRefs.current[t.id] = el; }}
                className={`mt-plane ${p}`}
                data-task={t.id}
                style={{ left: sp.x + '%', top: sp.y + '%', transform: `rotate(${rot}deg)`, zIndex: 5 }}
              >
                <div className="mt-plane-in">
                  <div className="plane-card">
                    <div className="pin" />
                    <div className={`prio`}>{t.priority || 'P1'}</div>
                    <div className="pttl">{t.title}</div>
                    <div className="pmeta">{t.id}</div>
                    <div className="flyicon">✈️</div>
                    <div style={{ marginTop: 6 }}>
                      <button className="btn btn-sm" onClick={(e) => grabClick(e, t.id)}>抢单！</button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        <div className="shelf">
          <div className="shelf-title">
            🏠 产物架
            <span className="board-count">{artCount}</span>
          </div>
          <div className="shelf-items" ref={shelfRef} id="shelfItems">
            {!doneTasks.length && (
              <div className="shelf-empty">🕯️ 架子还空着，等第一件产物诞生…</div>
            )}
            {doneTasks.map((t) => {
              const arts = t.artifacts || [];
              const owner = agentById(t.owner);
              const items = arts.length ? arts.slice(0, 3) : [null];
              return items.map((a, idx) => (
                <div key={`${t.id}:${idx}`} className="artifact" onClick={() => onOpenArtifact(t.id, arts.length ? idx : -1)}>
                  {owner && <div className="amini"><MonsterAvatar doorplate={owner.doorplate} size={26} /></div>}
                  <div className="aicon">{a ? artIcon(a) : '📦'}</div>
                  <div className="atid">{t.id} · {a ? (a.type || '产物') : '交付'}</div>
                  {arts.length > 3 && idx === 2 && <div className="amore">+{arts.length - 3} 更多</div>}
                </div>
              ));
            })}
          </div>
        </div>
      </div>

      {/* 验收托盘 */}
      <div className={`tray${reviewTasks.length ? ' show' : ''}`} id="tray">
        {reviewTasks.map((t) => {
          const o = agentById(t.owner);
          const nArt = (t.artifacts || []).length;
          return (
            <div key={t.id} className="tray-item">
              <span className="tid">{t.id}</span>
              <span>{t.title}</span>
              <span style={{ color: 'var(--muted)', fontSize: 12 }}>
                {o ? <MonsterMini doorplate={o.doorplate} /> : '🐾'} {t.owner || ''} 交了 {nArt} 件产物
              </span>
              <span className="spacer" style={{ flex: 1 }} />
              <button className="btn-ok" onClick={() => reviewTask(t.id, true)}>✓ 通过</button>
              <button className="btn-no" onClick={() => reviewTask(t.id, false)}>✗ 打回</button>
            </div>
          );
        })}
      </div>

      {/* 跑马灯 */}
      <div className="ticker">
        <div className="mt-ticker-in">
          {(feed.length ? [...feed, ...feed] : [{ text: `📻 ${coName} 暂无动态` }]).map((f, i) => (
            <span key={i}>{typeof f === 'string' ? f : (f.text || JSON.stringify(f))}</span>
          ))}
        </div>
      </div>

      {/* 抢单选择器 */}
      {picker && (
        <div className="picker" style={{ left: picker.x, top: picker.y }} onClick={(e) => e.stopPropagation()}>
          <div className="ph">谁去叼 {picker.taskId}？<small className="ph-co">{coName}</small></div>
          {picker.list.map((a) => (
            <div key={a.doorplate} className="popt" onClick={() => doClaim(picker.taskId, a.doorplate)}>
              <MonsterAvatar doorplate={a.doorplate} size={34} />
              <span>{a.name || a.doorplate}<br /><small>{a.doorplate} · {agentStatus(a)}</small></span>
            </div>
          ))}
        </div>
      )}
      {picker && <div style={{ position: 'fixed', inset: 0, zIndex: 110 }} onClick={() => setPicker(null)} />}

      {/* 广播弹窗 */}
      {bcOpen && (
        <div className="modal-bg show" onClick={(e) => { if (e.target === e.currentTarget) setBcOpen(false); }}>
          <div className="modal mt-modal">
            <h2 className="serif">📢 广播 · {coName}</h2>
            <div className="msub">本窝毛怪会抬头听</div>
            <div className="field">
              <textarea rows={3} value={bcText} onChange={(e) => setBcText(e.target.value)} placeholder="说点什么…" autoFocus />
            </div>
            <div className="row">
              <button className="btn btn-ghost" onClick={() => setBcOpen(false)}>取消</button>
              <button className="btn" onClick={sendBroadcast}>📢 发出去</button>
            </div>
          </div>
        </div>
      )}

      <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 50, display: 'flex', gap: 10, alignItems: 'center' }}>
        <span ref={megaRef} id="mega" className="mt-mega" style={{ fontSize: 30, display: 'inline-block' }}>📣</span>
        <button className="btn" onClick={() => setBcOpen(true)}>📢 广播</button>
      </div>
    </div>
  );
}
