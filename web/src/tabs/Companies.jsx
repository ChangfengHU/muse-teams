// 公司管理 —— 卡通卡片网格 + 分页 + 暖色交互
import React, { useEffect, useState, useCallback, useMemo } from 'react';
import {
  api, getCompany, setCompany,
  listSavedCompanies, saveCompanyLocal, updateSavedCompany,
} from '../api.js';
import MonsterAvatar from '../components/MonsterAvatar.jsx';

const PAGE_SIZE = 8;

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
      <div className="co-card-blob" aria-hidden />
      <div className="co-card-top">
        <div className="co-card-avatar">
          <MonsterAvatar doorplate={item.code || 'C-??'} size={48} />
        </div>
        <div className="co-card-title">
          <div className="co-card-name">{item.name || item.code}</div>
          <span className="co-code-badge">{item.code}</span>
        </div>
        {active && <span className="co-card-pill">✨ 当前</span>}
      </div>
      <div className="co-card-foot">
        <span className="co-card-stat">
          <span className="co-stat-ico" aria-hidden>🐾</span>
          <b>{count}</b> 只毛怪
        </span>
        <span className={`co-card-cta${active ? ' is-on' : ''}`}>
          {active ? '已进入' : '进去玩玩 →'}
        </span>
      </div>
    </button>
  );
}

function EmptyCompanions() {
  return (
    <div className="co-empty">
      <div className="co-empty-art" aria-hidden>
        <MonsterAvatar doorplate="empty-left" size={72} />
        <MonsterAvatar doorplate="empty-mid" size={88} />
        <MonsterAvatar doorplate="empty-right" size={72} />
      </div>
      <div className="co-empty-title serif">客厅还空着呢</div>
      <div className="co-empty-sub">点「开一家公司」生出新窝，或输入朋友的公司码挤进去。</div>
    </div>
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
  const [page, setPage] = useState(1);
  const [showJoin, setShowJoin] = useState(false);
  const [createPulse, setCreatePulse] = useState(false);
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
      const selectedCode = getCompany() || '';
      companies.sort((a, b) => {
        const na = a.member_count || 0;
        const nb = b.member_count || 0;
        if (nb !== na) return nb - na;
        const aSel = a.code === selectedCode ? 1 : 0;
        const bSel = b.code === selectedCode ? 1 : 0;
        if (bSel !== aSel) return bSel - aSel;
        const ta = a.created_at || 0;
        const tb = b.created_at || 0;
        return tb - ta;
      });
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

  // keep page in range when list shrinks
  const totalPages = Math.max(1, Math.ceil(list.length / PAGE_SIZE));
  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [page, totalPages]);

  // jump to page containing selected company
  useEffect(() => {
    if (!currentCode || !list.length) return;
    const idx = list.findIndex((c) => c.code === currentCode);
    if (idx >= 0) setPage(Math.floor(idx / PAGE_SIZE) + 1);
  }, [currentCode, list]);

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

  const pageItems = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return list.slice(start, start + PAGE_SIZE);
  }, [list, page]);

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
    setCreatePulse(true);
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
      toast(`🎉 新窝开张：${c.name}（${c.code}）`);
      const companies = await loadCompanies(true);
      const idx = (companies || []).findIndex((x) => x.code === c.code);
      if (idx >= 0) setPage(Math.floor(idx / PAGE_SIZE) + 1);
      else setPage(1);
    } catch (e) {
      toast('创建失败: ' + e.message, true);
    } finally {
      setBusy(false);
      setTimeout(() => setCreatePulse(false), 600);
    }
  };

  const joinByCode = async () => {
    const code = String(joinCode || '').trim().toUpperCase();
    setJoinError('');
    if (!code) {
      setJoinError('先写上公司码，例如 C-78CR');
      return;
    }
    if (!/^C-[A-Z0-9]+$/.test(code)) {
      setJoinError('格式要像 C-78CR 这样哦');
      return;
    }
    setJoinBusy(true);
    try {
      const info = await api.getCompanyInfo(code);
      if (!info || !info.code) {
        setJoinError('服务器没认出这家公司');
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
      setShowJoin(false);
      toast(`欢迎来到 ${info.name}（${info.code}）`);
      await loadCompanies(true);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      setJoinError(msg.includes('HTTP 404') || /not found|不存在/i.test(msg)
        ? `找不到 ${code}，再核对一下？`
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
      toast(`已溜进 ${info.name}`);
    } catch (e) {
      setCompany(item.code);
      onSelectCompany && onSelectCompany({ code: item.code, name: item.name });
      toast('校验失败，仍已切换: ' + e.message, true);
    }
  };

  const memberCount = agents ? agents.length : 0;
  const selected = list.find((c) => c.code === currentCode)
    || (currentCode ? { code: currentCode, name: (company && company.name) || currentCode } : null);

  return (
    <div className="mt-tabpane">
      <h2 className="sec-title">
        <span className="serif">🏢 公司窝</span>
        <span className="sec-sub">开一家 · 选一家 · 把邀请词贴进 Muse</span>
      </h2>

      <div className="co-toolbar">
        <button
          type="button"
          className={`btn co-btn-create${createPulse ? ' pulse' : ''}`}
          onClick={createOne}
          disabled={busy}
        >
          {busy ? '毛怪正在搭窝…' : '✨ 开一家公司'}
        </button>
        <button
          type="button"
          className={`btn btn-sm btn-ghost${showJoin ? ' co-ghost-on' : ''}`}
          onClick={() => setShowJoin((v) => !v)}
        >
          🚪 用公司码加入
        </button>
        <button
          type="button"
          className="btn btn-sm btn-ghost"
          onClick={() => loadCompanies(false)}
          disabled={listLoading}
        >
          {listLoading ? '刷新中…' : '刷新'}
        </button>
        {!!list.length && (
          <span className="co-toolbar-meta">共 {list.length} 家 · 第 {page}/{totalPages} 页</span>
        )}
      </div>

      {showJoin && (
        <div className="co-join-panel">
          <div className="co-join-panel-art" aria-hidden>
            <MonsterAvatar doorplate="join-buddy" size={40} />
          </div>
          <div className="co-join-panel-body">
            <div className="co-join-panel-title">敲敲门，进去串门</div>
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
                placeholder="C-78CR"
                disabled={joinBusy}
                autoCapitalize="characters"
                className="co-join-input"
                autoFocus
              />
              <button
                type="button"
                className="btn btn-sm"
                onClick={joinByCode}
                disabled={joinBusy}
              >
                {joinBusy ? '查询中…' : '进去！'}
              </button>
            </div>
            {joinError
              ? <div className="co-join-err">{joinError}</div>
              : <div className="co-join-hint">不区分大小写 · 对不上再问朋友要码</div>}
          </div>
        </div>
      )}

      {listLoading && !list.length && (
        <div className="co-loading">
          <MonsterAvatar doorplate="loading-spin" size={56} />
          <span>毛怪正在翻花名册…</span>
        </div>
      )}
      {!listLoading && listError && !list.length && (
        <div className="empty-hint" style={{ color: 'var(--danger, #c0392b)' }}>
          加载失败：{listError}
        </div>
      )}
      {!listLoading && !listError && !list.length && <EmptyCompanions />}

      {!!list.length && (
        <>
          <div className="co-grid">
            {pageItems.map((item) => (
              <CompanyCard
                key={item.code}
                item={item}
                active={item.code === currentCode}
                liveMembers={memberCount}
                onSelect={select}
              />
            ))}
          </div>

          {totalPages > 1 && (
            <nav className="co-pager" aria-label="公司分页">
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
              >
                ← 上一页
              </button>
              <div className="co-pager-dots">
                {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`co-dot${n === page ? ' on' : ''}`}
                    onClick={() => setPage(n)}
                    aria-label={`第 ${n} 页`}
                    aria-current={n === page ? 'page' : undefined}
                  >
                    {n}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="btn btn-sm btn-ghost"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              >
                下一页 →
              </button>
            </nav>
          )}
        </>
      )}

      {selected && (
        <section className="co-invite">
          <header className="co-invite-head">
            <div className="co-invite-identity">
              <MonsterAvatar doorplate={selected.code} size={44} />
              <div>
                <div className="co-invite-title">{selected.name || selected.code}</div>
                <div className="co-invite-sub">
                  <span className="co-code-badge">{selected.code}</span>
                  <span>🐾 {memberCount} 只毛怪</span>
                </div>
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
            <label>邀请词 · 贴进 Muse 就能报到</label>
            {inviteLoading && !invitePrompt ? (
              <div className="empty-hint" style={{ padding: 16 }}>毛怪正在写邀请信…</div>
            ) : (
              <textarea
                rows={9}
                readOnly
                value={invitePrompt}
                className="co-invite-ta"
              />
            )}
          </div>
        </section>
      )}

      {!selected && !!list.length && (
        <div className="co-hint-pick">点一张卡片进窝，再复制邀请词叫小伙伴</div>
      )}
    </div>
  );
}
