// 客厅场景 —— 动画从原型 v4 逐个移植
import React, { useRef, useEffect, useState, useCallback } from 'react';
import Creature, { agentStatus } from '../components/Creature.jsx';
import MonsterAvatar, { MonsterMini } from '../components/MonsterAvatar.jsx';
import { api, relTime } from '../api.js';
import { welcomeAgent, flyInPlane, claimPounce, claimShake, deliverCelebration, broadcastCheer } from '../anim.js';
import { artIcon } from '../components/Modals.jsx';

function hashStr(s) {
  let h = 2166136261;
  s = String(s || '?');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rugSlots(n) {
  const cols = n <= 3 ? n : 4;
  const pos = [];
  for (let i = 0; i < n; i++) {
    const r = Math.floor(i / cols), c = i % cols;
    const inRow = Math.min(cols, n - r * cols);
    pos.push({ x: 12 + c * (76 / Math.max(inRow - 1, 1)), y: 8 + r * 34 });
  }
  return pos;
}
function deskSlots() {
  return [{ x: 8, y: 8 }, { x: 31, y: 8 }, { x: 54, y: 8 }, { x: 77, y: 8 }];
}
function boardSlots(n) {
  const pos = [];
  for (let i = 0; i < n; i++) pos.push({ x: 6 + (i % 2) * 46, y: 12 + Math.floor(i / 2) * 30 });
  return pos;
}

export default function LivingRoom({ agents, tasks, feed, onToast, onRefresh, onOpenInvite, onOpenArtifact, onOpenMailbox, onSendMsg }) {
  const roomRef = useRef(null);
  const doorRef = useRef(null);
  const boardRef = useRef(null);
  const shelfRef = useRef(null);
  const megaRef = useRef(null);
  const creatureRefs = useRef({});
  const planeRefs = useRef({});
  const prevAgentsRef = useRef(new Set());
  const prevTasksRef = useRef(new Set());
  const [picker, setPicker] = useState(null); // {taskId, x, y}
  const [bcOpen, setBcOpen] = useState(false);
  const [bcText, setBcText] = useState('');

  const idle = agents.filter((a) => agentStatus(a) !== 'busy');
  const working = agents.filter((a) => agentStatus(a) === 'busy');
  const rp = rugSlots(Math.max(idle.length, 1));
  const dp = deskSlots();
  const pending = tasks.filter((t) => t.status === 'pending');
  const bp = boardSlots(pending.length);
  const doneTasks = tasks.filter((t) => t.status === 'done');
  const reviewTasks = tasks.filter((t) => t.status === 'review' || t.status === 'done-pending-review');

  const agentById = useCallback((id) => agents.find((a) => a.doorplate === id), [agents]);

  /* ---- 新成员推门 / 新任务纸飞机（对照原型 refreshAll 的 diff 逻辑） ---- */
  useEffect(() => {
    const prevA = prevAgentsRef.current;
    const prevT = prevTasksRef.current;
    // 新成员
    agents.forEach((a) => {
      if (!prevA.has(a.doorplate)) {
        prevA.add(a.doorplate);
        // 等渲染出 creature 后再做动画
        setTimeout(() => {
          const cel = creatureRefs.current[a.doorplate];
          if (!cel) return;
          const st = agentStatus(a);
          const isDesk = st === 'busy';
          // 注意：idle 成员渲染时做了地毯坐标变换（6+(x/100)*88, 64+(y/100)*32），
          // 动画终点必须用变换后的坐标，否则动画结束后 creature 会卡在错误位置
          let endLeftPct, endTopPct;
          if (isDesk) {
            const slot = dp[working.findIndex((w) => w.doorplate === a.doorplate) % dp.length];
            endLeftPct = slot.x;
            endTopPct = slot.y;
          } else {
            const s = rp[idle.findIndex((w) => w.doorplate === a.doorplate)] || { x: 40, y: 20 };
            endLeftPct = 6 + (s.x / 100) * 88;
            endTopPct = 64 + (s.y / 100) * 32;
          }
          welcomeAgent({
            doorEl: doorRef.current,
            creatureEl: cel,
            roomEl: roomRef.current,
            endLeftPct,
            endTopPct,
            onToast: () => onToast(`🚪 欢迎 ${a.name || a.doorplate} 推门进来！门牌号 ${a.doorplate}`),
          });
        }, 100);
      }
    });
    // 新任务纸飞机
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

  /* ---- 抢单 ---- */
  const grabClick = (e, taskId) => {
    e.stopPropagation();
    const avail = agents.filter((a) => agentStatus(a) !== 'offline');
    const list = avail.length ? avail : agents;
    if (!list.length) { onToast('客厅空空的，先去「邀请小伙伴」', true); return; }
    setPicker({ taskId, list, x: Math.min(e.clientX, window.innerWidth - 240), y: e.clientY + 10 });
  };

  const doClaim = async (taskId, doorplate) => {
    setPicker(null);
    const cel = creatureRefs.current[doorplate];
    const pel = planeRefs.current[taskId];
    try {
      await api.claimTask(taskId, doorplate);
      // 冲刺动画（乐观执行，与原型一致）
      claimPounce({
        creatureEl: cel,
        planeEl: pel,
        onBadge: () => {
          // 徽章由 current_task 渲染，这里触发刷新即可
          setTimeout(() => onRefresh(), 100);
        },
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

  return (
    <div className="mt-tabpane lr">
      <div className="lr-hero">
        <h2 className="sec-title" style={{ marginBottom: 0 }}>
          <span className="serif">🏠 毛怪客厅</span>
          <span className="sec-sub">地毯歇脚 · 窗口飞任务 · 架子收宝贝</span>
        </h2>
      </div>
      {/* 房间 */}
      <div className="room" ref={roomRef} id="room">
        <div className="door" ref={doorRef} id="door">
          <div className="door-frame" />
          <div className="door-panel"><div className="door-knob" /></div>
          <div className="door-sign">🚪 新毛怪从这里推门</div>
        </div>
        <div className="window"><div className="sun">☀️</div></div>
        <div className="window-label">✈️ 新任务从窗口飞进来</div>
        <div className="wall-base" />
        <div className="desks" id="desks">
          {working.map((a, i) => {
            const s = dp[i % dp.length];
            return (
              <div key={a.doorplate} className="desk" style={{ left: s.x + '%', top: s.y + '%' }}>
                <div className="laptop">💻</div>
                <div className="dtop" />
                <div className="dleg l" /><div className="dleg r" />
                <div className="dname">{a.doorplate}</div>
                <div style={{ position: 'absolute', left: 4, top: 46 }}>
                  <Creature
                    ref={(el) => { if (el) creatureRefs.current[a.doorplate] = el; }}
                    agent={a}
                    leftPct={0}
                    topPct={0}
                    onSendMsg={onSendMsg}
                    onOpenMailbox={onOpenMailbox}
                  />
                </div>
              </div>
            );
          })}
        </div>
        <div className="rug" />
        <div className="room-label" style={{ left: '50%', top: '58%', transform: 'translateX(-50%)' }}>
          🛋️ 地毯 · 等候区
        </div>
        <div className="room-label" style={{ left: '46%', top: '38%' }}>🖥️ 工作角</div>
        {idle.map((a, i) => {
          const s = rp[i] || { x: 40, y: 20 };
          // 地毯内相对定位：room 坐标换算（地毯区域 left 6%-94%, top 64%-96%）
          const leftPct = 6 + (s.x / 100) * 88;
          const topPct = 64 + (s.y / 100) * 32;
          return (
            <Creature
              key={a.doorplate}
              ref={(el) => { if (el) creatureRefs.current[a.doorplate] = el; }}
              agent={a}
              leftPct={leftPct}
              topPct={topPct}
              look={hashStr(a.doorplate) % 2 === 0}
              onSendMsg={onSendMsg}
              onOpenMailbox={onOpenMailbox}
            />
          );
        })}
        {!agents.length && (
          <div className="room-label" style={{ left: '50%', top: '80%', transform: 'translateX(-50%)', cursor: 'pointer' }} onClick={onOpenInvite}>
            🪑 客厅空空的，点这儿邀请小伙伴 →
          </div>
        )}
      </div>

      {/* 任务板 + 产物架 */}
      <div className="board-wrap">
        <div className="board" ref={boardRef} id="board">
          <div className="board-title">📋 任务板</div>
          {!pending.length && <div className="board-empty">🎉 板子空啦，扔一张纸飞机吧</div>}
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
          <div className="shelf-title">🏠 产物架</div>
          <div className="shelf-items" ref={shelfRef} id="shelfItems">
            {!doneTasks.length && <div className="shelf-empty">🕯️ 架子还空着，等第一件产物诞生…</div>}
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
          {(feed.length ? [...feed, ...feed] : [{ text: '📻 暂无动态' }]).map((f, i) => (
            <span key={i}>{typeof f === 'string' ? f : (f.text || JSON.stringify(f))}</span>
          ))}
        </div>
      </div>

      {/* 抢单选择器 */}
      {picker && (
        <div className="picker" style={{ left: picker.x, top: picker.y }} onClick={(e) => e.stopPropagation()}>
          <div className="ph">谁去叼 {picker.taskId}？</div>
          {picker.list.map((a) => (
            <div key={a.doorplate} className="popt" onClick={() => doClaim(picker.taskId, a.doorplate)}>
              <MonsterAvatar doorplate={a.doorplate} size={34} />
              <span>{a.name || a.doorplate}<br /><small>{a.doorplate}</small></span>
            </div>
          ))}
        </div>
      )}
      {picker && <div style={{ position: 'fixed', inset: 0, zIndex: 110 }} onClick={() => setPicker(null)} />}

      {/* 广播弹窗 */}
      {bcOpen && (
        <div className="modal-bg show" onClick={(e) => { if (e.target === e.currentTarget) setBcOpen(false); }}>
          <div className="modal mt-modal">
            <h2 className="serif">📢 广播</h2>
            <div className="msub">全员抬头！</div>
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

      {/* 广播按钮 + 喇叭 */}
      <div style={{ position: 'fixed', bottom: 24, right: 24, zIndex: 50, display: 'flex', gap: 10, alignItems: 'center' }}>
        <span ref={megaRef} id="mega" className="mt-mega" style={{ fontSize: 30, display: 'inline-block' }}>📣</span>
        <button className="btn" onClick={() => setBcOpen(true)}>📢 广播</button>
      </div>
    </div>
  );
}
