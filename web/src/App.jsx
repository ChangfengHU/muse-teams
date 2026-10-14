// Muse Teams —— 主应用
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api, getCompany, setCompany } from './api.js';
import Sidebar from './components/Sidebar.jsx';
import Landing from './components/Landing.jsx';
import { PublishTaskModal, InviteModal, ArtifactModal } from './components/Modals.jsx';
import LivingRoom from './tabs/LivingRoom.jsx';
import Tasks from './tabs/Tasks.jsx';
import Members from './tabs/Members.jsx';
import Artifacts from './tabs/Artifacts.jsx';
import Activity from './tabs/Activity.jsx';
import { agentStatus } from './components/Creature.jsx';
import { artIcon } from './components/Modals.jsx';
import { deliverCelebration } from './anim.js';
import './animations.css';
import './design.css';

export default function App() {
  const [tab, setTab] = useState('home');
  const [company, setCompanyInfo] = useState(null); // {code, name} | null
  const [agents, setAgents] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [feed, setFeed] = useState([]);
  const [connected, setConnected] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [artView, setArtView] = useState(null); // {task, idx}
  const [toastMsg, setToastMsg] = useState(null);
  const toastTimer = useRef(null);

  const toast = useCallback((msg, isErr) => {
    setToastMsg({ msg, isErr: !!isErr });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2800);
  }, []);

  const refresh = useCallback(async (silent) => {
    if (!getCompany()) return;
    try {
      const data = await api.refreshAll();
      setAgents(data.agents);
      setTasks(data.tasks);
      setFeed(data.feed);
      setConnected(true);
    } catch (e) {
      if (!silent) toast('API 连接失败: ' + e.message, true);
    }
  }, [toast]);

  // 启动时：有公司码则校验并进入，否则停在公司入口
  useEffect(() => {
    const c = getCompany();
    if (!c) return;
    api.getCompanyInfo(c)
      .then((info) => { setCompanyInfo(info); })
      .catch(() => { setCompany(''); setCompanyInfo(null); });
  }, []);

  useEffect(() => {
    if (!company) return;
    refresh(false);
    const h = setInterval(() => refresh(true), 15000);
    return () => clearInterval(h);
  }, [company, refresh]);

  const switchCompany = () => {
    setCompany('');
    setCompanyInfo(null);
    setAgents([]); setTasks([]); setFeed([]); setConnected(false);
  };

  const online = agents.filter((a) => agentStatus(a) === 'online').length;
  const busy = agents.filter((a) => agentStatus(a) === 'busy').length;
  const pendingN = tasks.filter((t) => t.status === 'pending').length;
  const reviewN = tasks.filter((t) => t.status === 'review' || t.status === 'done-pending-review').length;

  const openArtifact = (taskId, idx) => {
    const t = tasks.find((x) => x.id === taskId);
    if (t) setArtView({ task: t, idx });
  };

  // 任务 tab 通过验收后的庆祝（客厅不在前台时降级为普通刷新）
  const handleCelebrate = (taskId) => {
    const t = tasks.find((x) => x.id === taskId);
    const cel = t && t.owner
      ? document.querySelector(`.mt-creature[data-doorplate="${t.owner}"]`)
      : null;
    const shelf = document.getElementById('shelfItems');
    if (cel && shelf) {
      deliverCelebration({ creatureEl: cel, shelfEl: shelf, artifacts: t.artifacts || [], artIcon });
    }
  };

  const sendMsg = async (doorplate, text) => {
    try {
      await api.sendMail({ from: 'lead', to: doorplate, text });
      toast('💌 消息已捎给 ' + doorplate);
    } catch (e) {
      toast('发送失败: ' + e.message, true);
    }
  };


  return (
    <>
      {company ? (
      <>
      <header className="topbar">
        <div className="logo">
          <div className="logo-mark serif">M</div>
          <div>
            <div className="logo-name serif">Muse Teams</div>
            <div className="logo-sub"><span className="mt-live-dot" />毛怪客厅 · live</div>
          </div>
        </div>
        <div className="reg-pill" title="公司码：发给新成员入驻用">
          🏢 {company.name} <code>{company.code}</code>
          <button onClick={() => { try { navigator.clipboard.writeText(company.code); toast('公司码已复制 📋'); } catch (e) {} }}>复制码</button>
          <button onClick={switchCompany} title="切换公司">切换</button>
        </div>
        <div className="chips">
          <span className="chip">🛋️ 等候 <b>{online}</b></span>
          <span className="chip">✈️ 待领 <b>{pendingN}</b></span>
          <span className={`chip${busy ? ' hot' : ''}`}>🏃 忙碌 <b>{busy}</b></span>
          <span className={`chip${reviewN ? ' hot' : ''}`}>📦 交付 <b>{reviewN}</b></span>
        </div>
        <div className="top-actions">
          <button className="btn btn-sm btn-ghost" onClick={() => setShowInvite(true)}>🚪 邀请</button>
          <button className="btn btn-sm" onClick={() => setShowPublish(true)}>📤 发布任务</button>
        </div>
      </header>

      <div className="app-layout">
        <Sidebar tab={tab} onSwitch={setTab} />
        <main className="main">
          {!connected && <div className="empty-hint">连接中…</div>}
          {connected && tab === 'home' && (
            <LivingRoom
              agents={agents} tasks={tasks} feed={feed}
              onToast={toast} onRefresh={() => refresh(true)}
              onOpenInvite={() => setShowInvite(true)}
              onOpenArtifact={openArtifact}
              onOpenMailbox={() => {}}
              onSendMsg={sendMsg}
            />
          )}
          {connected && tab === 'tasks' && (
            <Tasks tasks={tasks} agents={agents} onToast={toast}
              onRefresh={() => refresh(true)} onOpenArtifact={openArtifact}
              onCelebrate={handleCelebrate} />
          )}
          {connected && tab === 'agents' && <Members agents={agents} tasks={tasks} onRefresh={() => refresh(true)} />}
          {connected && tab === 'arts' && (
            <Artifacts tasks={tasks} agents={agents} onOpenArtifact={openArtifact} />
          )}
          {connected && tab === 'feed' && <Activity feed={feed} />}
        </main>
      </div>

      <PublishTaskModal show={showPublish} onClose={() => setShowPublish(false)}
        onCreated={() => refresh(true)} toast={toast} />
      <InviteModal show={showInvite} onClose={() => setShowInvite(false)} toast={toast} />
      <ArtifactModal show={!!artView} onClose={() => setArtView(null)}
        task={artView && artView.task} artIndex={artView ? artView.idx : -1} />

      {toastMsg && <div className={`toast show${toastMsg.isErr ? ' err' : ''}`}>{toastMsg.msg}</div>}
      </>)
      : (
        <Landing onEnter={(info) => setCompanyInfo(info)} />
      )}
    </>
  );
}
