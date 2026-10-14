// 公司管理 —— 服务端 D1 列表 + 一键创建 + 公司码加入 + 复制邀请词
import React, { useEffect, useState, useCallback } from 'react';
import {
  api, getCompany, setCompany,
  listSavedCompanies, saveCompanyLocal, updateSavedCompany,
} from '../api.js';

export default function Companies({ company, agents, onSelectCompany, onToast }) {
  const [list, setList] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [busy, setBusy] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [joinBusy, setJoinBusy] = useState(false);
  const [joinError, setJoinError] = useState('');
  const [invitePrompt, setInvitePrompt] = useState('');
  const [inviteLoading, setInviteLoading] = useState(false);
  const currentCode = (company && company.code) || getCompany() || '';

  const toast = useCallback((msg, isErr) => {
    if (onToast) onToast(msg, isErr);
  }, [onToast]);

  const loadCompanies = useCallback(async (silent) => {
    if (!silent) setListLoading(true);
    setListError('');
    try {
      const res = await api.listCompanies();
      const companies = (res && res.companies) || [];
      setList(companies);
      // merge invite_prompt from local cache if any
      const cached = listSavedCompanies();
      for (const c of companies) {
        const hit = cached.find((x) => x.code === c.code);
        if (hit && hit.invite_prompt) {
          saveCompanyLocal({ ...c, invite_prompt: hit.invite_prompt });
        } else {
          saveCompanyLocal(c);
        }
      }
      return companies;
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      setListError(msg);
      if (!silent) toast('加载公司列表失败: ' + msg, true);
      // fallback: show local cache so UI is not blank offline
      setList(listSavedCompanies());
      return [];
    } finally {
      if (!silent) setListLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadCompanies(false);
  }, [loadCompanies]);

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
      })
      .catch((e) => {
        if (!cancelled) setInvitePrompt('加载邀请词失败: ' + e.message);
      })
      .finally(() => { if (!cancelled) setInviteLoading(false); });
    return () => { cancelled = true; };
  }, [currentCode]);

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
      const c = await api.createCompany();
      const entry = {
        code: c.code,
        name: c.name,
        created_at: c.created_at || Date.now(),
        invite_prompt: c.invite_prompt || '',
        member_count: 0,
      };
      saveCompanyLocal(entry);
      setCompany(c.code);
      setInvitePrompt(entry.invite_prompt);
      onSelectCompany && onSelectCompany({ code: c.code, name: c.name, created_at: c.created_at });
      toast(`公司已创建：${c.name}（${c.code}）`);
      await loadCompanies(true);
    } catch (e) {
      toast('创建失败: ' + e.message, true);
    } finally {
      setBusy(false);
    }
  };

  const joinByCode = async () => {
    const code = String(joinCode || '').trim().toUpperCase();
    setJoinError('');
    if (!code) {
      setJoinError('请输入公司码，例如 C-78CR');
      return;
    }
    if (!/^C-[A-Z0-9]+$/.test(code)) {
      setJoinError('公司码格式不对，应为 C- 开头，如 C-78CR');
      return;
    }
    setJoinBusy(true);
    try {
      const info = await api.getCompanyInfo(code);
      if (!info || !info.code) {
        setJoinError('服务端未返回公司信息');
        return;
      }
      saveCompanyLocal({
        code: info.code,
        name: info.name || info.code,
        created_at: info.created_at || Date.now(),
        invite_prompt: '',
      });
      setCompany(info.code);
      onSelectCompany && onSelectCompany(info);
      setJoinCode('');
      setJoinError('');
      toast(`已选中：${info.name}（${info.code}）`);
      await loadCompanies(true);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      setJoinError(msg.includes('HTTP 404') || /not found|不存在/i.test(msg)
        ? `找不到公司 ${code}，请核对公司码`
        : '加入失败: ' + msg);
      toast('加入失败: ' + msg, true);
    } finally {
      setJoinBusy(false);
    }
  };

  const select = async (item) => {
    if (!item || !item.code) return;
    try {
      const info = await api.getCompanyInfo(item.code);
      setCompany(info.code);
      saveCompanyLocal({
        ...item,
        name: info.name || item.name,
        created_at: info.created_at || item.created_at,
      });
      onSelectCompany && onSelectCompany(info);
      toast(`已切换到 ${info.name}（${info.code}）`);
    } catch (e) {
      setCompany(item.code);
      onSelectCompany && onSelectCompany({ code: item.code, name: item.name });
      toast('公司码校验失败，仍已切换: ' + e.message, true);
    }
  };

  const memberCount = agents ? agents.length : 0;

  return (
    <div className="mt-tabpane">
      <h2 className="sec-title">
        <span className="serif">🏢 公司管理</span>
        <span style={{ fontSize: 13, color: 'var(--muted)', fontWeight: 400 }}>
          服务端列表 · 一键建公司 · 输入公司码 · 复制邀请词贴进 Muse
        </span>
      </h2>

      <div style={{ marginBottom: 18 }}>
        <button className="btn" onClick={createOne} disabled={busy}>
          {busy ? '创建中…' : '✨ 一键创建公司'}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          style={{ marginLeft: 8 }}
          onClick={() => loadCompanies(false)}
          disabled={listLoading}
        >
          {listLoading ? '刷新中…' : '刷新列表'}
        </button>
        <div className="msub" style={{ marginTop: 8 }}>
          公司列表来自 Cloudflare D1（teams.vyibc.com），换浏览器也不会丢。创建后把邀请词贴进 Muse，注册后门牌号回显到「成员」。
        </div>
      </div>

      <div className="field" style={{ marginBottom: 22, maxWidth: 480 }}>
        <label>输入公司码选中（快速定位）</label>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            type="text"
            value={joinCode}
            onChange={(e) => {
              setJoinCode(e.target.value);
              if (joinError) setJoinError('');
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                joinByCode();
              }
            }}
            placeholder="例如 C-78CR"
            disabled={joinBusy}
            autoCapitalize="characters"
            style={{ flex: '1 1 160px', minWidth: 140, textTransform: 'uppercase' }}
          />
          <button
            type="button"
            className="btn btn-sm"
            onClick={joinByCode}
            disabled={joinBusy}
          >
            {joinBusy ? '查询中…' : '选中公司'}
          </button>
        </div>
        {joinError ? (
          <div style={{ color: 'var(--danger, #c0392b)', fontSize: 13, marginTop: 8 }}>
            {joinError}
          </div>
        ) : (
          <div className="msub" style={{ marginTop: 8 }}>
            向服务端核对公司码后选中。公司码不区分大小写。
          </div>
        )}
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
        <div style={{ flex: '1 1 260px', minWidth: 240 }}>
          <h3 className="serif" style={{ fontSize: 16, marginBottom: 10 }}>全部公司</h3>
          {listLoading && !list.length && (
            <div className="empty-hint" style={{ padding: '20px 12px' }}>加载公司列表…</div>
          )}
          {!listLoading && listError && !list.length && (
            <div className="empty-hint" style={{ padding: '20px 12px', color: 'var(--danger, #c0392b)' }}>
              加载失败：{listError}
            </div>
          )}
          {!listLoading && !listError && !list.length && (
            <div className="empty-hint" style={{ padding: '20px 12px' }}>
              还没有公司。点「一键创建」，或上方输入已有公司码
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
                  <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 6 }}>
                    成员 {active ? memberCount : (item.member_count ?? '—')} 只
                    {active ? ' · 当前选中' : ''}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        <div style={{ flex: '2 1 360px', minWidth: 280 }}>
          {!currentCode ? (
            <div className="empty-hint">先创建、输入公司码，或点选一家公司</div>
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
