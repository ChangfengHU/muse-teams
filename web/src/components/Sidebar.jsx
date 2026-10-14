// 左侧 tab 导航
import React from 'react';

const TABS = [
  { key: 'companies', icon: '🏢', label: '公司' },
  { key: 'home', icon: '🏠', label: '客厅' },
  { key: 'tasks', icon: '📋', label: '任务' },
  { key: 'agents', icon: '👥', label: '成员' },
  { key: 'arts', icon: '📦', label: '产物' },
  { key: 'feed', icon: '📻', label: '动态' },
];

export default function Sidebar({ tab, onSwitch }) {
  return (
    <nav className="sidebar">
      {TABS.map((t) => (
        <button
          key={t.key}
          className={`side-tab${tab === t.key ? ' active' : ''}`}
          onClick={() => onSwitch(t.key)}
        >
          <span className="ico">{t.icon}</span>
          <span>{t.label}</span>
        </button>
      ))}
    </nav>
  );
}
