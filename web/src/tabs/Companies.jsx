// 公司管理 —— 卡片网格 + 创建 / 输入公司码 / 邀请词
import React, { useEffect, useState, useCallback } from 'react';
import {
  api, getCompany, setCompany,
  listSavedCompanies, saveCompanyLocal, updateSavedCompany,
} from '../api.js';

function CompanyCard({ item, active, liveMembers, onSelect }) {
  const count = active && liveMembers != null
    ? liveMembers
    : (item.member_count ?? 0);
  return (
    <button
      type="button"
      className={`co-card${active ? ' active' : ''}`}
      onClick={() => onSelect(item)}
    >
      <div className="co-card-top">
        <div className="co-card-mark" aria-hidden>🏢</div>
        <div className="co-card-title">
          <div className="co-card-name">{item.name || item.code}</div>
          <span className="co-code-badge">{item.code}</span>
        </div>
        {active && <span className="co-card-pill">当前</span>}
      </div>
      <div className="co-card-foot">
        <span className="co-card-stat">👥 <b>{count}</b> 成员</span>
        <span className="co-card-action">{active ? '已选中' : '进入 →'}</span>
      </div>
    </button>
  );
}

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
      setList(listSavedCompanies());
      return [];
    } finally {
      if (!silent) setListLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadCompanies(false);
  }, [loadCompanies]);

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
      setJoinError('公司码格式不对，应为 C- 开头');
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
        ? `找不到公司 ${code}`
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
  const selected = list.find((c) => c.code === currentCode)
    || (currentCode ? { code: currentCode, name: (company && company.name) || currentCode } : null);

  return (
    <div className="mt-tabpane">
      <h2 className="sec-title">
        <span className="serif">🏢 公司</span>
        <span className="sec-sub">创建或选中，复制邀请词贴进 Muse</span>
      </h2>

      <div className="co-toolbar">
        <button type="button" className="btn" onClick={createOne} disabled={busy}>
          {busy ? '创建中…' : '✨ 创建公司'}
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => loadCompanies(false)}
          disabled={listLoading}
        >
          {listLoading ? '刷新中…' : '刷新'}
        </button>
        <div className="co-join">
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
            placeholder="输入公司码加入"
            disabled={joinBusy}
            autoCapitalize="characters"
            className="co-join-input"
          />
          <button
            type="button"
            className="btn btn-sm"
            onClick={joinByCode}
            disabled={joinBusy}
          >
            {joinBusy ? '…' : '加入'}
          </button>
        </div>
      </div>
      {joinError && <div className="co-join-err">{joinError}</div>}

      {listLoading && !list.length && (
        <div className="empty-hint">加载公司…</div>
      )}
      {!listLoading && listError && !list.length && (
        <div className="empty-hint" style={{ color: 'var(--danger, #c0392b)' }}>
          加载失败：{listError}
        </div>
      )}
      {!listLoading && !listError && !list.length && (
        <div className="empty-hint">还没有公司。点「创建公司」，或输入已有公司码。</div>
      )}

      {!!list.length && (
        <div className="co-grid">
          {list.map((item) => (
            <CompanyCard
              key={item.code}
              item={item}
              active={item.code === currentCode}
              liveMembers={memberCount}
              onSelect={select}
            />
          ))}
        </div>
      )}

      {selected && (
        <section className="co-invite">
          <header className="co-invite-head">
            <div>
              <div className="co-invite-title">{selected.name || selected.code}</div>
              <div className="co-invite-sub">
                <span className="co-code-badge">{selected.code}</span>
                <span>👥 {memberCount} 成员</span>
              </div>
            </div>
            <div className="co-invite-actions">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                onClick={() => copy(currentCode, '公司码已复制 📋')}
              >
                复制码
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
          </header>
          <div className="field co-invite-field">
            <label>邀请词 · 贴进 Muse 注册（含 company_code={currentCode}）</label>
            {inviteLoading && !invitePrompt ? (
              <div className="empty-hint" style={{ padding: 16 }}>加载邀请词…</div>
            ) : (
              <textarea
                rows={10}
                readOnly
                value={invitePrompt}
                className="co-invite-ta"
              />
            )}
          </div>
        </section>
      )}

      {!selected && !!list.length && (
        <div className="empty-hint" style={{ paddingTop: 8 }}>点选上方卡片进入公司，可复制邀请词</div>
      )}
    </div>
  );
}
