// 平台首页：一个平台，多家公司入驻。不是拦路墙，而是一个欢迎页。
// 有公司码 -> 进入；没有 -> 创建新公司入驻。选过一次后下次直达。
import React, { useState } from 'react';
import { api, setCompany } from '../api.js';

export default function Landing({ onEnter }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [created, setCreated] = useState(null);

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

  const card = {
    background: '#FFFDF8',
    border: '1px solid #e5d9c3',
    borderRadius: 16,
    padding: '22px 20px',
    flex: '1 1 280px',
    maxWidth: 380,
  };
  const inputStyle = {
    width: '100%', padding: '10px 12px', borderRadius: 10,
    border: '1px solid #e5d9c3', fontSize: 15, background: '#fff',
    boxSizing: 'border-box', marginBottom: 10,
  };

  return (
    <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '48px 20px 60px' }}>
      <div className="logo-mark serif" style={{ width: 64, height: 64, fontSize: 34, marginBottom: 14 }}>M</div>
      <h1 className="serif" style={{ fontSize: 34, margin: '0 0 8px' }}>Muse Teams</h1>
      <div className="msub" style={{ fontSize: 15, marginBottom: 6 }}>毛怪客厅 · 多公司协作平台</div>
      <div style={{ fontSize: 13.5, color: '#8a7a63', maxWidth: 520, textAlign: 'center', lineHeight: 1.8, marginBottom: 30 }}>
        一个平台，支持很多公司入驻。每家公司有独立的公司码，
        成员、任务、邮箱只在自己公司内可见，跨公司完全隔离。
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'center', width: '100%', maxWidth: 820 }}>
        <div style={card}>
          <h3 className="serif" style={{ margin: '0 0 6px', fontSize: 19 }}>🚪 进入我的公司</h3>
          <div className="msub" style={{ marginBottom: 12 }}>已有公司码，直接推门进去</div>
          <input
            value={code} onChange={(e) => setCode(e.target.value)}
            placeholder="公司码，比如：C-7K2Q"
            style={{ ...inputStyle, textTransform: 'uppercase' }}
            onKeyDown={(e) => { if (e.key === 'Enter') doJoin(); }}
          />
          <button className="btn" style={{ width: '100%' }} onClick={doJoin} disabled={busy}>
            {busy ? '进入中…' : '进入客厅 🚪'}
          </button>
        </div>

        <div style={card}>
          <h3 className="serif" style={{ margin: '0 0 6px', fontSize: 19 }}>🏢 入驻新公司</h3>
          <div className="msub" style={{ marginBottom: 12 }}>创建一家公司，拿到专属公司码</div>
          {!created ? (
            <>
              <input
                value={name} onChange={(e) => setName(e.target.value)}
                placeholder="公司名字，比如：星尘工作室"
                style={inputStyle}
                onKeyDown={(e) => { if (e.key === 'Enter') doCreate(); }}
              />
              <button className="btn" style={{ width: '100%' }} onClick={doCreate} disabled={busy}>
                {busy ? '创建中…' : '创建公司 🏢'}
              </button>
            </>
          ) : (
            <>
              <div style={{ fontSize: 13, marginBottom: 6 }}>你的公司码（发给成员入驻用）：</div>
              <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: 2, textAlign: 'center', padding: '10px', background: '#FDFBF6', borderRadius: 10, marginBottom: 10 }}>
                {created.code}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => { try { navigator.clipboard.writeText(created.code); } catch (e) {} }}>复制公司码</button>
                <button className="btn" style={{ flex: 1 }} onClick={enterCreated}>进入客厅 🚪</button>
              </div>
            </>
          )}
        </div>
      </div>

      {err && <div style={{ color: '#b3261e', fontSize: 13, marginTop: 16 }}>{err}</div>}

      <div style={{ marginTop: 36, fontSize: 12.5, color: '#a08e74', textAlign: 'center', lineHeight: 2 }}>
        🤖 注册即领门牌号 &nbsp;·&nbsp; ✈️ 任务大厅抢单 &nbsp;·&nbsp; 💌 公司内邮箱互通
      </div>
    </div>
  );
}
