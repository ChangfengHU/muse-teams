// Muse Teams —— 主应用（v3：进站直达工作台 + 公司管理 + hash 路由）
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { api, getCompany, setCompany } from './api.js';
import Sidebar from './components/Sidebar.jsx';
import MonsterAvatar from './components/MonsterAvatar.jsx';
import { PublishTaskModal, InviteModal, ArtifactModal } from './components/Modals.jsx';
import LivingRoom from './tabs/LivingRoom.jsx';
import Tasks from './tabs/Tasks.jsx';
import Members from './tabs/Members.jsx';
import Artifacts from './tabs/Artifacts.jsx';
import Activity from './tabs/Activity.jsx';
import Companies from './tabs/Companies.jsx';
import ClaimPlaza from './tabs/ClaimPlaza.jsx';
import Trace from './tabs/Trace.jsx';
import Receipts from './tabs/Receipts.jsx';
import { agentStatus } from './components/Creature.jsx';
import { artIcon } from './components/Modals.jsx';
import { deliverCelebration } from './anim.js';
import './animations.css';
import './design.css';

const TAB_TO_HASH = {
  companies: 'companies',
  home: 'home',
  plaza: 'plaza',
  tasks: 'tasks',
  agents: 'team',
  arts: 'arts',
  feed: 'feed',
  trace: 'trace',
  receipts: 'receipts',
};
const HASH_TO_TAB = Object.fromEntries(
  Object.entries(TAB_TO_HASH).map(([tab, hash]) => [hash, tab])
);

function tabFromHash() {
  const raw = (typeof location !== 'undefined' ? location.hash : '') || '';
  const key = raw.replace(/^#/, '').split(/[?/]/)[0].trim().toLowerCase();
  if (key && HASH_TO_TAB[key]) return HASH_TO_TAB[key];
  return getCompany() ? 'home' : 'companies';
}

function setHashForTab(tab) {
  const hash = TAB_TO_HASH[tab] || 'home';
  if (typeof location === 'undefined') return;
  // Preserve #trace/T-xxxx deep link when staying on trace
  if (tab === 'trace') {
    const cur = (location.hash || '').replace(/^#/, '');
    if (cur === 'trace' || cur.startsWith('trace/') || cur.startsWith('trace?')) return;
  }
  const next = '#' + hash;
  if (location.hash === next) return;
  try {
    history.replaceState(null, '', next);
  } catch (_) {
    location.hash = hash;
  }
}

export default function App() {
  const [tab, setTab] = useState(() => tabFromHash());
  const [company, setCompanyInfo] = useState(null); // {code, name} | null
  const [agents, setAgents] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [feed, setFeed] = useState([]);
  const [connected, setConnected] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  const [showInvite, setShowInvite] = useState(false);
  const [artView, setArtView] = useState(null); // {task, idx}
  const [toastMsg, setToastMsg] = useState(null);
  const [traceTaskId, setTraceTaskId] = useState(null);
  const toastTimer = useRef(null);

  const toast = useCallback((msg, isErr) => {
    setToastMsg({ msg, isErr: !!isErr });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToastMsg(null), 2800);
  }, []);

  const switchTab = useCallback((next) => {
    setTab(next);
    setHashForTab(next);
  }, []);

  const openTrace = useCallback((taskId) => {
    const id = taskId ? String(taskId).trim().toUpperCase() : '';
    setTraceTaskId(id || null);
    setTab('trace');
    try {
      history.replaceState(null, '', id ? `#trace/${encodeURIComponent(id)}` : '#trace');
    } catch (_) {
      location.hash = id ? `trace/${id}` : 'trace';
    }
  }, []);

  // hash ↔ tab
  useEffect(() => {
    setHashForTab(tab);
  }, [tab]);

  useEffect(() => {
    const onHash = () => {
      const next = tabFromHash();
      setTab((cur) => (cur === next ? cur : next));
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
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

  // 启动时：有当前公司码则校验；无效则清空，仍留在工作台
  useEffect(() => {
    const c = getCompany();
    if (!c) return;
    api.getCompanyInfo(c)
      .then((info) => { setCompanyInfo(info); })
      .catch(() => { setCompany(''); setCompanyInfo(null); });
  }, []);

  useEffect(() => {
    if (!company) {
      setConnected(false);
      setAgents([]); setTasks([]); setFeed([]);
      return;
    }
    refresh(false);
    const h = setInterval(() => refresh(true), 15000);
    return () => clearInterval(h);
  }, [company, refresh]);

  const switchCompany = () => {
    setCompany('');
    setCompanyInfo(null);
    setAgents([]); setTasks([]); setFeed([]); setConnected(false);
    switchTab('companies');
  };

  const onSelectCompany = (info) => {
    setCompanyInfo(info);
    setAgents([]); setTasks([]); setFeed([]); setConnected(false);
  };

  const online = agents.filter((a) => agentStatus(a) === 'online').length;
  const busy = agents.filter((a) => agentStatus(a) === 'busy').length;
  const pendingN = tasks.filter((t) => t.status === 'pending').length;
  const coCode = company?.code || '';
  const reviewN = tasks.filter((t) =>
    (t.status === 'review' || t.status === 'done-pending-review') &&
    (!coCode || t.company === coCode)
  ).length;

  const openArtifact = (taskId, idx) => {
    const t = tasks.find((x) => x.id === taskId);
    if (t) setArtView({ task: t, idx });
  };

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

  const needCompanyHint = (
    <div className="mt-empty">
      <div className="mt-empty-art" aria-hidden>
        <MonsterAvatar doorplate="need-co" size={72} />
      </div>
      <div className="mt-empty-title serif">先选一个公司窝</div>
      <div className="mt-empty-sub">去左侧「公司窝」创建或加入，再回来看客厅和任务～</div>
      <button type="button" className="btn co-btn-create" style={{ marginTop: 12 }} onClick={() => switchTab('companies')}>
        去公司窝 →
      </button>
    </div>
  );

  return (
    <>
      <header className="topbar">
        <div className="logo">
          <div className="logo-mark serif" aria-hidden>M</div>
          <div>
            <div className="logo-name serif">Muse Teams</div>
            <div className="logo-sub"><span className="mt-live-dot" />毛怪协作窝 · live</div>
          </div>
        </div>
        {company ? (
          <div className="reg-pill" title="公司码：发给新成员入驻用">
            <MonsterAvatar doorplate={company.code} size={26} />
            <span className="reg-pill-name">{company.name}</span>
            <code>{company.code}</code>
            <button onClick={() => { try { navigator.clipboard.writeText(company.code); toast('公司码已复制 📋'); } catch (e) {} }}>复制码</button>
            <button onClick={switchCompany} title="切换公司">换窝</button>
          </div>
        ) : (
          <div className="reg-pill">
            还没进窝
            <button onClick={() => switchTab('companies')}>开一家</button>
          </div>
        )}
        <div className="chips">
          <span className="chip">🛋️ 在线 <b>{online}</b></span>
          <span className="chip">✈️ 纸飞机 <b>{pendingN}</b></span>
          <span className={`chip${busy ? ' hot' : ''}`}>🏃 干活 <b>{busy}</b></span>
          <span className={`chip${reviewN ? ' hot' : ''}`}>📦 待收 <b>{reviewN}</b></span>
        </div>
        <div className="top-actions">
          <button className="btn btn-sm btn-ghost" onClick={() => setShowInvite(true)} disabled={!company}>🚪 邀请</button>
          <button className="btn btn-sm" onClick={() => setShowPublish(true)} disabled={!company}>📤 扔纸飞机</button>
        </div>
      </header>

      <div className="app-layout">
        <Sidebar tab={tab} onSwitch={switchTab} />
        <main className="main">
          {tab === 'companies' && (
            <Companies
              company={company}
              agents={agents}
              onSelectCompany={onSelectCompany}
              onToast={toast}
            />
          )}

          {/* 员工页自管全公司加载，不依赖当前公司 / connected */}
          {tab === 'agents' && (
            <Members
              company={company}
              onSelectCompany={onSelectCompany}
              onToast={toast}
            />
          )}

          {tab !== 'companies' && tab !== 'agents' && tab !== 'trace' && !company && needCompanyHint}

          {tab !== 'companies' && tab !== 'agents' && tab !== 'trace' && company && !connected && (
            <div className="empty-hint">连接中…</div>
          )}

          {connected && tab === 'plaza' && (
            <ClaimPlaza
              company={company}
              agents={agents}
              onToast={toast}
              onRefresh={() => refresh(true)}
              onGotoCompany={async (code) => {
                if (!code) return;
                try {
                  const info = await api.getCompanyInfo(code);
                  setCompany(info.code);
                  setCompanyInfo(info);
                  switchTab('home');
                  toast(`已切换到 ${info.name || info.code} 的客厅`);
                } catch (e) {
                  toast('切换公司失败: ' + e.message, true);
                }
              }}
            />
          )}
          {connected && tab === 'home' && (
            <LivingRoom
              company={company}
              agents={agents} tasks={tasks} feed={feed}
              onToast={toast} onRefresh={() => refresh(true)}
              onOpenInvite={() => setShowInvite(true)}
              onOpenPublish={() => setShowPublish(true)}
              onOpenArtifact={openArtifact}
              onOpenMailbox={() => {}}
              onSendMsg={sendMsg}
            />
          )}
          {connected && tab === 'tasks' && (
            <Tasks tasks={tasks} agents={agents} company={company} onToast={toast}
              onRefresh={() => refresh(true)} onOpenArtifact={openArtifact}
              onCelebrate={handleCelebrate} onOpenTrace={openTrace} />
          )}
          {connected && tab === 'arts' && (
            <Artifacts tasks={tasks} agents={agents} onOpenArtifact={openArtifact} />
          )}
          {connected && tab === 'feed' && <Activity feed={feed} />}
          {tab === 'receipts' && (
            <Receipts agents={agents} onToast={toast} />
          )}
          {tab === 'trace' && (
            <Trace company={company} onToast={toast} initialTaskId={traceTaskId} />
          )}
        </main>
      </div>

      <PublishTaskModal show={showPublish} onClose={() => setShowPublish(false)}
        onCreated={() => refresh(true)} toast={toast} agents={agents} />
      <InviteModal show={showInvite} onClose={() => setShowInvite(false)} toast={toast} />
      <ArtifactModal show={!!artView} onClose={() => setArtView(null)}
        task={artView && artView.task} artIndex={artView ? artView.idx : -1} />

      {toastMsg && <div className={`toast show${toastMsg.isErr ? ' err' : ''}`}>{toastMsg.msg}</div>}
    </>
  );
}
