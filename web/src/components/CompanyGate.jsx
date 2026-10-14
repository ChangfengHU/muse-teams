// 公司码入口：输入已有公司码进入，或创建新公司
import React, { useState } from 'react';
import { api, setCompany } from '../api.js';

export default function CompanyGate({ onEnter }) {
  const [mode, setMode] = useState('join'); // join | create
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [created, setCreated] = useState(null); // {code, name}

  const doJoin = async () => {
    const c = code.trim().toUpperCase();
    if (!c) { setErr('先填公司码'); return; }
    setBusy(true); setErr('');
    try {
      const info = await api.getCompanyInfo(c);
      setCompany(info.code);
      onEnter(info);
    } catch (e) {
      setErr('公司码不对：' + e.message);
    } finally {
      setBusy(false);
    }
  };

  const doCreate = async () => {
    if (!name.trim()) { setErr('给公司起个名字'); return; }
    setBusy(true); setErr('');
    try {
      const c = await api.createCompany(name.trim());
      setCreated(c);
    } catch (e) {
      setErr('创建失败：' + e.message);
    } finally {
      setBusy(false);
    }
  };

  const enterCreated = () => {
    setCompany(created.code);
    onEnter(created);
  };

  return (
    <div className="modal-bg show" style={{ position: 'fixed', inset: 0, zIndex: 200 }}>
      <div className="modal mt-modal" style={{ maxWidth: 460 }}>
        <h2 className="serif">🏢 进入你的公司</h2>
        <div className="msub">每个公司有独立的公司码，只能看到自己公司的成员和任务。</div>

        <div className="inv-role-row" style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <button className={`btn btn-sm${mode === 'join' ? '' : ' btn-ghost'}`} onClick={() => { setMode('join'); setErr(''); }}>我有公司码</button>
          <button className={`btn btn-sm${mode === 'create' ? '' : ' btn-ghost'}`} onClick={() => { setMode('create'); setErr(''); }}>创建新公司</button>
        </div>

        {mode === 'join' && (
          <>
            <div className="field">
              <label>公司码</label>
              <input
                value={code} onChange={(e) => setCode(e.target.value)}
                placeholder="比如：C-7K2Q"
                style={{ width: '100%', padding: '9px 12px', borderRadius: 10, border: '1px solid #e5d9c3', fontSize: 15, background: '#fff', textTransform: 'uppercase' }}
                onKeyDown={(e) => { if (e.key === 'Enter') doJoin(); }}
              />
            </div>
            <div className="row">
              <span />
              <button className="btn" onClick={doJoin} disabled={busy}>{busy ? '进入中…' : '进入客厅 🚪'}</button>
            </div>
          </>
        )}

        {mode === 'create' && !created && (
          <>
            <div className="field">
              <label>公司名字</label>
              <input
                value={name} onChange={(e) => setName(e.target.value)}
                placeholder="比如：星尘工作室"
                style={{ width: '100%', padding: '9px 12px', borderRadius: 10, border: '1px solid #e5d9c3', fontSize: 15, background: '#fff' }}
                onKeyDown={(e) => { if (e.key === 'Enter') doCreate(); }}
              />
            </div>
            <div className="row">
              <span />
              <button className="btn" onClick={doCreate} disabled={busy}>{busy ? '创建中…' : '创建公司 🏢'}</button>
            </div>
          </>
        )}

        {mode === 'create' && created && (
          <>
            <div className="field">
              <label>你的公司码（发给成员，他们凭这个码入驻）</label>
              <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: 2, textAlign: 'center', padding: '12px', background: '#FDFBF6', borderRadius: 12 }}>
                {created.code}
              </div>
            </div>
            <div className="row">
              <button className="btn btn-ghost" onClick={() => { try { navigator.clipboard.writeText(created.code); } catch (e) {} }}>复制公司码</button>
              <button className="btn" onClick={enterCreated}>进入客厅 🚪</button>
            </div>
          </>
        )}

        {err && <div style={{ color: '#b3261e', fontSize: 13, marginTop: 10 }}>{err}</div>}
      </div>
    </div>
  );
}
