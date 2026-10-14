// 程序化毛怪 SVG —— 门牌号 hash 确定性生成外观
import React from 'react';

const PALETTES = [
  { body: '#F3E7CF', belly: '#E9D5B0', ear: '#E7D0A8' },
  { body: '#DCE8D2', belly: '#C9DBBD', ear: '#C2D4B2' },
  { body: '#F6DCD2', belly: '#EFC6B8', ear: '#EEBCAE' },
  { body: '#E4E1EA', belly: '#D3CEDF', ear: '#CBC4DB' },
  { body: '#F2E3C0', belly: '#EAD0A2', ear: '#E8C997' },
  { body: '#DCE4EA', belly: '#C7D4DE', ear: '#BCCBD8' },
];

function hashStr(s) {
  let h = 2166136261;
  s = String(s || '?');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export default function MonsterAvatar({ doorplate, size = 104, className = '' }) {
  const h = hashStr(doorplate);
  const p = PALETTES[h % PALETTES.length];
  const ears = ['round', 'pointy', 'floppy'][(h >> 3) % 3];
  const acc = ['headphones', 'bow', 'star', 'none'][(h >> 5) % 4];
  const blushO = (0.45 + ((h >> 7) % 5) / 12).toFixed(2);

  let earSvg = null;
  if (ears === 'round') {
    earSvg = (<>
      <circle cx="30" cy="26" r="14" fill={p.ear} />
      <circle cx="90" cy="26" r="14" fill={p.ear} />
    </>);
  } else if (ears === 'pointy') {
    earSvg = (<>
      <path d="M22 34 L30 6 L44 28 Z" fill={p.ear} />
      <path d="M98 34 L90 6 L76 28 Z" fill={p.ear} />
    </>);
  } else {
    earSvg = (<>
      <ellipse cx="16" cy="52" rx="10" ry="20" fill={p.ear} transform="rotate(18 16 52)" />
      <ellipse cx="104" cy="52" rx="10" ry="20" fill={p.ear} transform="rotate(-18 104 52)" />
    </>);
  }

  let accSvg = null;
  if (acc === 'headphones') {
    accSvg = (<>
      <path d="M28 44 Q28 10 60 10 Q92 10 92 44" stroke="#6B5B4C" strokeWidth="7" fill="none" strokeLinecap="round" />
      <rect x="20" y="38" width="16" height="24" rx="8" fill="#6B5B4C" />
      <rect x="84" y="38" width="16" height="24" rx="8" fill="#6B5B4C" />
    </>);
  } else if (acc === 'bow') {
    accSvg = (<g transform="translate(86,14)">
      <path d="M0 0 L-16 -10 L-16 10 Z" fill="#D97757" />
      <path d="M0 0 L16 -10 L16 10 Z" fill="#D97757" />
      <circle r="5" fill="#B85C38" />
    </g>);
  } else if (acc === 'star') {
    accSvg = (<g transform="translate(30,12)" fill="#E8B93E">
      <path d="M0 -9 L2.6 -3 L9 -3 L4 1.5 L5.8 8 L0 4 L-5.8 8 L-4 1.5 L-9 -3 L-2.6 -3 Z" />
    </g>);
  }

  return (
    <svg viewBox="0 0 120 120" className={className} width={size} height={size} aria-hidden="true">
      {earSvg}
      <path d="M60 20 C92 20 105 45 105 72 C105 98 86 110 60 110 C34 110 15 98 15 72 C15 45 28 20 60 20 Z" fill={p.body} />
      <ellipse cx="60" cy="88" rx="26" ry="16" fill={p.belly} opacity="0.85" />
      <g className="monster-eyes">
        <circle cx="46" cy="62" r="5.5" fill="#2B2620" />
        <circle cx="74" cy="62" r="5.5" fill="#2B2620" />
        <circle cx="48" cy="60" r="1.8" fill="#fff" />
        <circle cx="76" cy="60" r="1.8" fill="#fff" />
      </g>
      <path d="M53 76 Q60 82 67 76" stroke="#2B2620" strokeWidth="2.6" fill="none" strokeLinecap="round" />
      <ellipse cx="36" cy="72" rx="7" ry="4.5" fill="#E89B8B" opacity={blushO} />
      <ellipse cx="84" cy="72" rx="7" ry="4.5" fill="#E89B8B" opacity={blushO} />
      <g className="monster-paws">
        <ellipse className="paw-l" cx="44" cy="102" rx="9" ry="7" fill={p.ear} />
        <ellipse className="paw-r" cx="76" cy="102" rx="9" ry="7" fill={p.ear} />
      </g>
      {accSvg}
    </svg>
  );
}

/** 小尺寸行内头像 */
export function MonsterMini({ doorplate, size = 22 }) {
  return (
    <span style={{ display: 'inline-block', width: size, height: size, verticalAlign: -6 }}>
      <MonsterAvatar doorplate={doorplate} size={size} />
    </span>
  );
}
