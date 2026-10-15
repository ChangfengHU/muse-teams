// 左侧 tab 导航 —— 卡通圆角 + 选中发光
import React from 'react';

const TABS = [
  { key: 'companies', icon: '🏢', label: '公司窝' },
  { key: 'home', icon: '🏠', label: '客厅' },
  { key: 'plaza', icon: '🗺', label: '抢单广场' },
  { key: 'tasks', icon: '✈️', label: '任务' },
  { key: 'agents', icon: '🐾', label: '毛怪' },
  { key: 'arts', icon: '📦', label: '产物' },
  { key: 'feed', icon: '📻', label: '动态' },
];

export default function Sidebar({ tab, onSwitch }) {
  return (
    <nav className="sidebar">
      <div className="sidebar-cap" aria-hidden>✨</div>
      {TABS.map((t) => (
        <button
          key={t.key}
          type="button"
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
