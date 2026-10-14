// 公司管理 —— 一键创建 + 本地列表切换 + 复制邀请词
import React, { useEffect, useState } from 'react';
import {
  api, getCompany, setCompany,
  listSavedCompanies, saveCompanyLocal, updateSavedCompany,
} from '../api.js';

export default function Companies({ company, agents, onSelectCompany, onToast }) {
  const [list, setList] = useState(() => listSavedCompanies());
  const [busy, setBusy] = useState(false);
  const [invitePrompt, setInvitePrompt] = useState('');
  const [inviteLoading, setInviteLoading] = useState(false);
  const currentCode = (company && company.code) || getCompany() || '';

  useEffect(() => {
    setList(listSavedCompanies());
  }, [company]);

  // 选中公司时：优先用本地缓存的邀请词，否则拉 /api/invite
  useEffect(() => {
    if (!currentCode) {
      setInvitePrompt('');
      return;
    }
    const cached = listSavedCompanies().find((c) => c.code === currentCode);
    if (cached && cached.invite_prompt) {
      setInvitePrompt(cached.invite_prompt);
      return;
    }
    let cancelled = false;
    setInviteLoading(true);
    api.invite()
      .then((r) => {
        if (cancelled) return;
        const p = (r && r.prompt) || '';
        setInvitePrompt(p);
        if (p) updateSavedCompany(currentCode, { invite_prompt: p });
        setList(listSavedCompanies());
      })
      .catch((e) => {
        if (!cancelled) setInvitePrompt('加载邀请词失败: ' + e.message);
      })
      .finally(() => { if (!cancelled) setInviteLoading(false); });
    return () => { cancelled = true; };
  }, [currentCode]);

  const toast = (msg, isErr) => onToast && onToast(msg, isErr);

  const copy = async (text, okMsg) => {
    if (!text) { toast('没有可复制的内容', true); return; }
    try {
      await navigator.clipboard.writeText(text);
      toast(okMsg);
    } catch (_) {
      toast('复制失败，请手动选择复制', true);
    }
  };

  const createOne = async () => {
    setBusy(true);
    try {
      const c = await api.createCompany(); // 不传 name → 后端自动生成
      const entry = {
        code: c.code,
        name: c.name,
        created_at: c.created_at || Date.now(),
        invite_prompt: c.invite_prompt || '',
      };
      saveCompanyLocal(entry);
      setList(listSavedCompanies());
      setCompany(c.code);
      setInvitePrompt(entry.invite_prompt);
      onSelectCompany && onSelectCompany({ code: c.code, name: c.name, created_at: c.created_at });
      toast(`公司已创建：${c.name}（${c.code}）`);
    } catch (e) {
      toast('创建失败: ' + e.message, true);
    } finally {
      setBusy(false);
    }
  };

  const select = async (item) => {
    if (!item || !item.code) return;
    try {
      const info = await api.getCompanyInfo(item.code);
      setCompany(info.code);
      // 补全本地名字
      saveCompanyLocal({
        ...item,
        name: info.name || item.name,
        created_at: info.created_at || item.created_at,
      });
      setList(listSavedCompanies());
      onSelectCompany && onSelectCompany(info);
      toast(`已切换到 ${info.name}（${info.code}）`);
    } catch (e) {
      // 服务端查不到时仍允许切本地码（开发/离线），但提示
      setCompany(item.code);
      onSelectCompany && onSelectCompany({ code: item.code, name: item.name });
      toast('公司码校验失败，仍已切换本地选择: ' + e.message, true);
    }
  };

  const memberCount = agents ? agents.length : 0;

  return (
    <div className="mt-tabpane">
      <h2 className="sec-title">
        <span className="serif">🏢 公司管理</span>
        <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 400 }}>
          一键建公司 · 复制邀请词贴进 Muse
        </span>
      </h2>

      <div style={{ marginBottom: 18 }}>
        <button className="btn" onClick={createOne} disabled={busy}>
          {busy ? '创建中…' : '✨ 一键创建公司'}
        </button>
        <div className="msub" style={{ marginTop: 8 }}>
          自动生成公司名与公司码，并给出该公司专属注册邀请词。把邀请词贴进 Muse 会话，注册后门牌号会回显到「成员」。
        </div>
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        {/* 公司列表 */}
        <div style={{ flex: '1 1 260px', minWidth: 240 }}>
          <h3 className="serif" style={{ fontSize: 16, marginBottom: 10 }}>本机公司</h3>
          {!list.length && (
            <div className="empty-hint" style={{ padding: '20px 12px' }}>
              还没有公司，点上面「一键创建公司」开始
            </div>
          )}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {list.map((item) => {
              const active = item.code === currentCode;
              return (
                <button
                  key={item.code}
                  type="button"
                  onClick={() => select(item)}
                  className="mcard"
                  style={{
                    textAlign: 'left',
                    cursor: 'pointer',
                    borderColor: active ? 'var(--accent)' : undefined,
                    boxShadow: active ? '0 0 0 2px rgba(217,119,87,.25)' : undefined,
                    fontFamily: 'inherit',
                    color: 'inherit',
                    width: '100%',
                  }}
                >
                  <div className="mcard-name">{item.name || item.code}</div>
                  <div className="mcard-door">{item.code}</div>
                  {active && (
                    <div style={{ fontSize: 12, color: 'var(--accent-dark)', marginTop: 6 }}>
                      当前选中 · 成员 {memberCount} 只
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* 当前公司详情 + 邀请词 */}
        <div style={{ flex: '2 1 360px', minWidth: 280 }}>
          {!currentCode ? (
            <div className="empty-hint">先创建或点选一家公司</div>
          ) : (
            <>
              <h3 className="serif" style={{ fontSize: 16, marginBottom: 10 }}>当前公司</h3>
              <div className="mcard" style={{ marginBottom: 14 }}>
                <div className="mcard-name">{(company && company.name) || currentCode}</div>
                <div className="mcard-door" style={{ marginTop: 4 }}>
                  公司码 <code style={{ color: 'var(--accent-dark)', fontWeight: 700 }}>{currentCode}</code>
                </div>
                <div className="mcard-stats" style={{ marginTop: 10 }}>
                  <span>👥 成员 <b>{memberCount}</b></span>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    className="btn btn-sm btn-ghost"
                    onClick={() => copy(currentCode, '公司码已复制 📋')}
                  >
                    复制公司码
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => copy(invitePrompt, '邀请词已复制，去 Muse 粘贴 🚪')}
                    disabled={!invitePrompt || inviteLoading}
                  >
                    复制邀请词
                  </button>
                </div>
              </div>

              <div className="field">
                <label>注册邀请提示词（公司维度 · 必须带 company_code={currentCode}）</label>
                {inviteLoading && !invitePrompt ? (
                  <div className="empty-hint" style={{ padding: 16 }}>加载邀请词…</div>
                ) : (
                  <textarea
                    rows={14}
                    readOnly
                    value={invitePrompt}
                    style={{ fontSize: 12.5, lineHeight: 1.65, fontFamily: 'ui-monospace, monospace' }}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
