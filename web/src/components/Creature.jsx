// 毛怪元素 —— 状态类驱动 CSS 动画
// idle → breathe/lookaround, working → workbob/pawtap, dormant(休眠) → curl/zzz (CSS class still .offline)
import React, { useState, useRef, useEffect, forwardRef } from 'react';
import MonsterAvatar from './MonsterAvatar.jsx';
import { relTime, heartbeatLabel } from '../api.js';

// 心跳 → 状态推导（与后端 HEARTBEAT_TTL 180s 一致）
// dormant = 休眠员工；API 也可能仍回 offline（兼容）
export const HEARTBEAT_TTL_MS = 180_000;
export function agentStatus(a) {
  if (!a) return 'dormant';
  if (a.status === 'online' || a.status === 'busy' || a.status === 'dormant') return a.status;
  if (a.status === 'offline') return 'dormant';
  const last = a.last_heartbeat || 0;
  if (!last || Date.now() - last > HEARTBEAT_TTL_MS) return 'dormant';
  return a.current_task ? 'busy' : 'online';
}
export function isAgentDormant(stOrAgent) {
  const st = typeof stOrAgent === 'string' ? stOrAgent : agentStatus(stOrAgent);
  return st === 'dormant' || st === 'offline';
}

const Creature = forwardRef(function Creature(
  { agent, leftPct, topPct, look = false, size = 'md', embedded = false, onSendMsg, onOpenMailbox },
  ref
) {
  const [bubbleOpen, setBubbleOpen] = useState(false);
  const rootRef = useRef(null);
  const st = agentStatus(agent);
  const dormant = isAgentDormant(st);
  const cls = dormant ? 'offline' : st === 'busy' ? 'working' : 'idle';
  const stTxt = st === 'busy' ? '🏃 干活中' : dormant ? '💤 休眠' : '🛋️ 等活儿';
  const sizeCls = size === 'lg' ? ' lg' : size === 'xs' ? ' xs' : size === 'sm' ? ' sm' : '';
  const embedCls = embedded || (leftPct === 0 && topPct === 0) ? ' embedded' : '';
  const avatarPx = size === 'lg' ? 152 : size === 'xs' ? 52 : size === 'sm' ? 64 : 104;

  const setRefs = (el) => {
    rootRef.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };

  useEffect(() => {
    if (!bubbleOpen) return undefined;
    const onPointerDown = (e) => {
      const root = rootRef.current;
      if (!root) return;
      if (root.contains(e.target)) return;
      setBubbleOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === 'Escape') setBubbleOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [bubbleOpen]);

  const posStyle = embedCls
    ? undefined
    : { left: leftPct + '%', top: topPct + '%' };

  return (
    <div
      ref={setRefs}
      className={`mt-creature ${cls}${sizeCls}${embedCls}`}
      data-doorplate={agent.doorplate}
      style={posStyle}
      onClick={() => setBubbleOpen((v) => !v)}
    >
      <div className="mt-c-excl">!</div>
      <div className={`mt-c-inner${look ? ' look' : ''}`}>
        <MonsterAvatar doorplate={agent.doorplate} size={avatarPx} />
        <div className="mt-paws" />
        {st === 'busy' && <div className="mt-pdots">...</div>}
        <div className="mt-zzz"><span>z</span><span>z</span><span>z</span></div>
      </div>
      {agent.avatar && <div className="mt-c-avabadge">{agent.avatar}</div>}
      {agent.current_task && <div className="mt-c-taskbadge">{agent.current_task}</div>}
      <div className="mt-c-tag">
        <span className="mt-c-name">{agent.name || agent.doorplate}</span>
        <span className="mt-c-door">{agent.doorplate}</span>
      </div>
      <Bubble
        open={bubbleOpen}
        agent={agent}
        stTxt={stTxt}
        onSendMsg={onSendMsg}
        onOpenMailbox={onOpenMailbox}
        onClose={() => setBubbleOpen(false)}
      />
    </div>
  );
});

function Bubble({ open, agent, stTxt, onSendMsg, onOpenMailbox, onClose }) {
  const [msg, setMsg] = useState('');
  if (!open) return null;
  const st = agentStatus(agent);
  const send = () => {
    if (msg.trim() && onSendMsg) onSendMsg(agent.doorplate, msg.trim());
    setMsg('');
  };
  return (
    <div className={`cbubble${open ? ' open' : ''}`} onClick={(e) => e.stopPropagation()}>
      <div className="cb-head">
        <MonsterAvatar doorplate={agent.doorplate} size={44} />
        <div>
          <div className="cb-id">{agent.name || agent.doorplate}</div>
          <div className="cb-st">{agent.doorplate} · {stTxt}</div>
        </div>
      </div>
      <div className="cb-row">🏷️ 标签：<b>{(agent.tags || []).join(' · ') || '无'}</b></div>
      <div className="cb-row">📌 当前任务：<b>{agent.current_task || '无'}</b></div>
      <div className="cb-row">💓 上次心跳：<b>{heartbeatLabel(agent.last_heartbeat)}</b>{isAgentDormant(st) ? ' · 休眠员工（>180s 无心跳）' : ''}</div>
      <div className="breply">
        <input
          value={msg}
          placeholder="以 lead 身份捎句话…"
          onChange={(e) => setMsg(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') send(); }}
        />
        <button onClick={send}>发</button>
      </div>
      <div style={{ marginTop: 8, textAlign: 'right' }}>
        <a
          href="#"
          onClick={(e) => { e.preventDefault(); if (onOpenMailbox) onOpenMailbox(agent.doorplate); }}
          style={{ fontSize: 11.5, color: 'var(--accent-dark)' }}
        >
          看全部消息 →
        </a>
      </div>
    </div>
  );
}

export default Creature;
