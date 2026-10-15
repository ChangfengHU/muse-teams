// 弹窗：发布任务（含模板）、邀请、产物查看
import React, { useState, useEffect } from 'react';
import { api, getCompany, TASK_TEMPLATES } from '../api.js';

function ModalBg({ show, onClose, children, wide }) {
  if (!show) return null;
  return (
    <div className="modal-bg show" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal mt-modal${wide ? ' wide' : ''}`}>{children}</div>
    </div>
  );
}

/* ---------- 发布任务 ---------- */
export function PublishTaskModal({ show, onClose, onCreated, toast }) {
  const [tplKey, setTplKey] = useState('');
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [pri, setPri] = useState('P1');
  const [busy, setBusy] = useState(false);

  const applyTpl = (k) => {
    setTplKey(k);
    if (k && TASK_TEMPLATES[k]) {
      setTitle(TASK_TEMPLATES[k].title);
      setDesc(TASK_TEMPLATES[k].desc);
      setPri(TASK_TEMPLATES[k].pri);
      toast('模板已填好，改改关键词就能发 ✏️');
    }
  };

  const submit = async () => {
    if (!title.trim()) { toast('先填个标题', true); return; }
    setBusy(true);
    try {
      await api.createTask({ title: title.trim(), desc: desc.trim(), priority: pri });
      setTitle(''); setDesc(''); setTplKey(''); setPri('P1');
      onClose();
      toast('✈️ 纸飞机折好啦，马上从窗口飞进来！');
      if (onCreated) onCreated();
    } catch (e) {
      toast('发布失败: ' + e.message, true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalBg show={show} onClose={onClose}>
      <h2 className="serif">📤 发布任务</h2>
      <div className="msub">写张纸条，折成纸飞机从窗口飞进客厅</div>
      <div className="field">
        <label>任务模板</label>
        <select value={tplKey} onChange={(e) => applyTpl(e.target.value)}>
          <option value="">空白（自己写）</option>
          {Object.entries(TASK_TEMPLATES).map(([k, t]) => (
            <option key={k} value={k}>{t.label}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>标题</label>
        <input value={title} placeholder="例：给 mission-control 写部署文档" onChange={(e) => setTitle(e.target.value)} />
      </div>
      <div className="field">
        <label>描述 / 交付标准</label>
        <textarea rows={6} value={desc} placeholder="验收标准写清楚，小毛怪才能一次做对" onChange={(e) => setDesc(e.target.value)} />
      </div>
      <div className="field">
        <label>优先级</label>
        <select value={pri} onChange={(e) => setPri(e.target.value)}>
          <option value="P0">P0 紧急</option>
          <option value="P1">P1 普通</option>
          <option value="P2">P2 低</option>
        </select>
      </div>
      <div className="row">
        <button className="btn btn-ghost" onClick={onClose}>取消</button>
        <button className="btn" onClick={submit} disabled={busy}>折成飞机扔出去 ✈️</button>
      </div>
    </ModalBg>
  );
}

/* ---------- 邀请 ---------- */
const ROLE_PRESETS = [
  { v: '', label: '无预设（自己定）' },
  { v: 'coder', label: '💻 coder' },
  { v: 'reviewer', label: '🔍 reviewer' },
  { v: 'research', label: '📚 research' },
  { v: 'qa', label: '🧪 qa' },
  { v: 'zh-writing', label: '✍️ zh-writing' },
];

export function InviteModal({ show, onClose, toast }) {
  const [role, setRole] = useState('');
  const [prompt, setPrompt] = useState('加载中…');
  const [dName, setDName] = useState('');
  const [dCopied, setDCopied] = useState(false);

  useEffect(() => {
    if (!show) return;
    setPrompt('加载中…');
    api.invite(role).then((r) => setPrompt(r.prompt || JSON.stringify(r)))
      .catch((e) => setPrompt('加载失败: ' + e.message));
  }, [show, role]);

  const copy = async (text, msg, done) => {
    try {
      await navigator.clipboard.writeText(text);
      toast(msg);
      done(true);
      setTimeout(() => done(false), 2000);
    }
    catch (e) { toast('复制失败，请手动选择复制', true); }
  };

  const companyCode = getCompany() || '<本公司码>';
  const workersFile = `workers-${companyCode}.json`;
  const delegateText = `帮我加个 Muse Teams worker${dName.trim() ? `，名字叫「${dName.trim()}」` : '，名字你随机起个可爱的'}，角色是${role ? `「${role}」` : '无预设（你看着定）'}。公司码是 ${companyCode}。

你负责创建旁聊；拿到门牌号后，无需我确认立刻执行：
① 把门牌号→旁聊 chat_id 写入本公司专属名单 ${workersFile}（不要写入 C-0001 的名单，也不要用裸的 workers.json 混用）；
② 为本公司创建专属调度器（cron 每 2 分钟：对账、心跳、自动验收、扫单认领、派单到窗口、查信），与其他公司调度器完全独立；调度器必须对该名单每个 worker 调 teams_heartbeat / POST /api/agents/heartbeat（带 doorplate + company_code），超过 180 秒无心跳会显示休眠；
③ 完成后跟我说一句：「调度器已创建并接管，门牌号 <doorplate> 心跳正常」。

【强制】旁聊调 teams_register / teams_redeem_invite 时必须同时传 muse_account（当前登录 Muse 账号）和 muse_session（本旁聊会话名），两者都存进员工档案，方便从门牌反查是哪个 Muse。

创建旁聊后，把下面这段完整注册 prompt 原样发到旁聊里（不要改、不要缩写）：

${prompt}`;

  return (
    <ModalBg show={show} onClose={onClose} wide>
      <h2 className="serif">🚪 邀请小伙伴</h2>
      <div className="msub">复制下面的指令，粘贴到<b>主聊天</b>（muse.ai/），主聊天助理会自动创建 worker 旁聊、发送注册指令、分配名字并加入调度器，<b>全程不用你动手</b>。</div>
      <div className="field">
        <label>本公司公司码（新成员凭它入驻，只能看到本公司）</label>
        <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: 2, textAlign: 'center', padding: '8px', background: '#FDFBF6', borderRadius: 10 }}>
          {getCompany() || '—'}
        </div>
      </div>
      <div className="field">
        <label>想给它起的名字（留空则随机）</label>
        <input
          value={dName} onChange={(e) => setDName(e.target.value)}
          placeholder="比如：小麦、豆包…"
          style={{ width: '100%', padding: '9px 12px', borderRadius: 10, border: '1px solid #e5d9c3', fontSize: 14, background: '#fff' }}
        />
      </div>
      <div className="field">
        <label>角色预设</label>
        <div className="inv-role-row">
          <select value={role} onChange={(e) => setRole(e.target.value)} style={{ flex: 1 }}>
            {ROLE_PRESETS.map((r) => <option key={r.v} value={r.v}>{r.label}</option>)}
          </select>
        </div>
      </div>
      <div className="field">
        <label>代办指令（粘贴到主聊天）</label>
        <textarea rows={6} value={delegateText} readOnly style={{ fontSize: 13, lineHeight: 1.7 }} />
      </div>
      <div className="row">
        <button className="btn btn-ghost" onClick={onClose}>关闭</button>
        <button className="btn" onClick={() => copy(delegateText, '已复制，去主聊天粘贴吧 🎉', setDCopied)}>{dCopied ? '✓ 已复制！' : '📋 复制代办指令'}</button>
      </div>
    </ModalBg>
  );
}

/* ---------- 产物查看 ---------- */
const ART_ICON = { text: '📝', image: '🖼️', file: '📄', url: '🔗', code: '💻', video: '🎬' };
export function artIcon(a) { return ART_ICON[(a && a.type)] || '📦'; }

export function isImageArt(a) {
  if (!a) return false;
  if (a.type === 'image') return true;
  return !!(a.url && /\.(png|jpe?g|gif|webp)(\?|$)/i.test(a.url || ''));
}

export function ArtifactModal({ show, onClose, task, artIndex }) {
  if (!show || !task) return null;
  const arts = task.artifacts || [];
  const a = artIndex >= 0 ? arts[artIndex] : null;
  const body = !a
    ? '（该任务没有附带产物内容）'
    : `${a.type || '未知'}\n\n${a.content == null ? '（空）' : (typeof a.content === 'string' ? a.content : JSON.stringify(a.content, null, 2))}${a.url ? '\n\n🔗 ' + a.url : ''}`;
  return (
    <ModalBg show={show} onClose={onClose} wide>
      <h2 className="serif">📦 {task.id} 的产物</h2>
      <div className="msub">「{task.title}」</div>
      {a && isImageArt(a) && a.url && (
        <img src={a.url} alt="产物" style={{ maxWidth: '100%', borderRadius: 12, marginBottom: 12 }} onError={(e) => { e.target.style.display = 'none'; }} />
      )}
      <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', fontSize: 13, lineHeight: 1.7, background: '#FDFBF6', borderRadius: 10, padding: 14 }}>{body}</pre>
      <div className="row">
        <button className="btn btn-ghost" onClick={onClose}>关闭</button>
      </div>
    </ModalBg>
  );
}
