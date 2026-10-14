// 毛怪元素 —— 状态类驱动 CSS 动画
// idle → breathe/lookaround, working → workbob/pawtap, offline → curl/zzz
import React, { useState, useRef, forwardRef } from 'react';
import MonsterAvatar from './MonsterAvatar.jsx';
import { relTime, heartbeatLabel } from '../api.js';

// 心跳 → 状态推导（与后端 HEARTBEAT_TTL 180s 一致）
export const HEARTBEAT_TTL_MS = 180_000;
export function agentStatus(a) {
  if (!a) return 'offline';
  const last = a.last_heartbeat || 0;
  if (!last || Date.now() - last > HEARTBEAT_TTL_MS) return 'offline';
  return a.current_task ? 'busy' : 'online';
}

const Creature = forwardRef(function Creature(
  { agent, leftPct, topPct, look = false, onSendMsg, onOpenMailbox },
  ref
) {
  const [bubbleOpen, setBubbleOpen] = useState(false);
  const bubbleRef = useRef(null);
  const st = agentStatus(agent);
  const cls = st === 'offline' ? 'offline' : st === 'busy' ? 'working' : 'idle';
  const stTxt = st === 'busy' ? '🏃 干活中' : st === 'offline' ? '💤 离线' : '🛋️ 等活儿';

  return (
    <div
      ref={ref}
      className={`mt-creature ${cls}`}
      data-doorplate={agent.doorplate}
      style={{ left: leftPct + '%', top: topPct + '%' }}
      onClick={() => setBubbleOpen((v) => !v)}
    >
      <div className="mt-c-excl">!</div>
      <div className={`mt-c-inner${look ? ' look' : ''}`}>
        <MonsterAvatar doorplate={agent.doorplate} />
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
      <div className="cb-row">💓 上次心跳：<b>{heartbeatLabel(agent.last_heartbeat)}</b>{st === 'offline' ? ' · 已离线（>180s）' : ''}</div>
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
