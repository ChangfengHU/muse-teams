// ============================================================
// Muse Teams JS 驱动动画 —— 从原型 v4 逐个对照移植
//
// 铁律（原型 v3 血的教训）：anime.js 只操作外层 .mt-creature
// 的 transform；.mt-c-inner 的无限 CSS 动画永远不被 JS 碰。
// 欢呼用纯 CSS .cheer 类（!important 覆盖 idle 动画）。
// ============================================================
import anime from 'animejs';
import confetti from 'canvas-confetti';

function hasAnime() { return typeof anime !== 'undefined'; }
function hasConfetti() { return typeof confetti !== 'undefined'; }

/**
 * 1. 新成员从左墙木门进入（对照原型 welcomeAgent）
 *    门开 → 毛怪瞬移到门口 → 淡入 + easeOutBounce 弹到工位 → 门关
 */
export function welcomeAgent({ doorEl, creatureEl, roomEl, endLeftPct, endTopPct, onToast }) {
  if (!doorEl || !creatureEl || !roomEl) return;
  doorEl.classList.add('open');
  setTimeout(() => {
    if (hasAnime()) {
      const rr = roomEl.getBoundingClientRect();
      const startX = (26 / rr.width) * 100;
      const startY = (120 / rr.height) * 100;
      creatureEl.style.left = startX + '%';
      creatureEl.style.top = startY + '%';
      creatureEl.style.opacity = '0';
      anime({ targets: creatureEl, opacity: [0, 1], duration: 300 });
      anime({
        targets: creatureEl, left: endLeftPct + '%', top: endTopPct + '%',
        duration: 1100, easing: 'easeOutBounce',
      });
    }
    if (onToast) onToast();
    setTimeout(() => { doorEl.classList.remove('open'); }, 1600);
  }, 850);
}

/**
 * 2. 纸飞机从窗口飞入任务板（对照原型 flyInPlane）
 *    全员头顶 "!" → 飞机从窗口位置 rotate [18,-6,3,0] 飞到槽位
 */
export function flyInPlane({ planeEl, roomEl, boardEl, endXPct, endYPct, endRotate = 0, onToast }) {
  if (!planeEl) return;
  // "!" 全员抬头（纯 CSS pop，重触发）
  document.querySelectorAll('.mt-creature .mt-c-excl').forEach((e) => {
    e.classList.remove('pop');
    void e.offsetWidth;
    e.classList.add('pop');
  });
  if (hasAnime() && roomEl && boardEl) {
    const rr = roomEl.getBoundingClientRect();
    const br = boardEl.getBoundingClientRect();
    const winX = rr.right - 85 - br.left;
    // 窗口中心 Y（room 内 top 56 + 高 130/2 ≈ 121）换算到 board 坐标系
    // 结果为负值表示在 board 上方，配合 overflow:hidden 实现"从窗口飞入"效果
    const winY = (rr.top + rr.height * 0.09 + 65) - br.top;
    planeEl.style.left = winX + 'px';
    planeEl.style.top = winY + 'px';
    planeEl.style.zIndex = '20';
    const endX = (endXPct / 100) * br.width;
    const endY = (endYPct / 100) * br.height;
    anime({
      targets: planeEl, left: endX + 'px', top: endY + 'px',
      rotate: [18, -6, 3, endRotate], duration: 1400, easing: 'easeInOutQuad',
      complete() {
        planeEl.style.left = endXPct + '%';
        planeEl.style.top = endYPct + '%';
        planeEl.style.zIndex = '5';
        // 恢复 React 设定的随机倾斜角，避免被 anime 的 rotate(0) 覆盖
        planeEl.style.transform = `rotate(${endRotate}deg)`;
      },
    });
  }
  if (onToast) onToast();
}

/**
 * 3a. 抢单成功：毛怪扑向任务板（对照原型 doClaim 成功分支）
 *     挤压拉伸扑过去 → 飞机缩小消失 → 彩带 → 弹回原位
 *     注意：timeline 操作的是外层 creature 元素，不是 .mt-c-inner
 */
export function claimPounce({ creatureEl, planeEl, onConfetti, onBadge }) {
  if (!creatureEl || !planeEl || !hasAnime()) {
    if (onBadge) onBadge();
    return;
  }
  const cr = creatureEl.getBoundingClientRect();
  const pr = planeEl.getBoundingClientRect();
  const dx = (pr.left + pr.width / 2) - (cr.left + cr.width / 2);
  const dy = pr.top - (cr.top + cr.height / 2);
  const tl = anime.timeline({ easing: 'easeOutQuad' });
  tl.add({ targets: creatureEl, translateX: dx * 0.7, translateY: dy * 0.7 - 40, scaleX: 1.25, scaleY: 0.8, duration: 280 })
    .add({ targets: creatureEl, translateX: dx, translateY: dy, scaleX: 0.85, scaleY: 1.2, duration: 220 })
    .add({
      targets: planeEl, scale: 0.2, opacity: 0, duration: 400, easing: 'easeInQuad',
      complete() { planeEl.style.visibility = 'hidden'; },
    }, '-=100')
    .add({ targets: creatureEl, translateX: 0, translateY: 0, scaleX: 1, scaleY: 1, duration: 500, easing: 'easeOutBack' });
  if (hasConfetti() && onConfetti !== false) {
    confetti({
      particleCount: 80, spread: 70, startVelocity: 36,
      origin: { x: (pr.left + pr.width / 2) / window.innerWidth, y: Math.max(0.05, pr.top / window.innerHeight) },
    });
  }
  // 头顶任务徽章（700ms 后挂牌，与原型一致）
  setTimeout(() => { if (onBadge) onBadge(); }, 700);
}

/**
 * 3b. 抢单失败（409 被抢）：毛怪左右摇晃（对照原型 doClaim catch 分支）
 */
export function claimShake({ creatureEl }) {
  if (creatureEl && hasAnime()) {
    anime({ targets: creatureEl, translateX: [-9, 9, -6, 6, 0], duration: 420, easing: 'easeInOutQuad' });
  }
}

/**
 * 4. 交付庆祝（对照原型 deliverCelebration）
 *    毛怪跳起 → 纯 CSS cheer → 产物盒划弧线飞进产物架 → 彩带
 *    跳起动画在外层 cel，cheer 类在 inner —— 严格分离
 */
export function deliverCelebration({ creatureEl, shelfEl, artifacts = [], artIcon = () => '📦' }) {
  const fire = () => {
    if (hasConfetti()) confetti({ particleCount: 120, spread: 100, origin: { y: 0.75 } });
    if (creatureEl) {
      const inner = creatureEl.querySelector('.mt-c-inner');
      if (inner) {
        inner.classList.remove('cheer');
        void inner.offsetWidth;
        inner.classList.add('cheer');
        setTimeout(() => { try { inner.classList.remove('cheer'); } catch (e) { /* noop */ } }, 700);
      }
    }
    // 产物盒划弧线飞进架子
    if (creatureEl && shelfEl && hasAnime()) {
      const cr = creatureEl.getBoundingClientRect();
      const sr = shelfEl.getBoundingClientRect();
      const n = Math.min(artifacts.length || 1, 3);
      for (let i = 0; i < n; i++) {
        const box = document.createElement('div');
        box.textContent = artIcon(artifacts[i] || {});
        box.style.cssText = 'position:fixed;left:' + (cr.left + cr.width / 2) + 'px;top:' + cr.top + 'px;font-size:34px;z-index:80;pointer-events:none';
        document.body.appendChild(box);
        ((b, delay) => {
          setTimeout(() => {
            anime({
              targets: b,
              translateX: [0, (sr.left + 80 + i * 130) - (cr.left + cr.width / 2)],
              translateY: [0, -120, (sr.top + 20) - cr.top],
              scale: [1, 1, 0.5], opacity: [1, 1, 0.9],
              duration: 1100, easing: 'easeInQuad',
              complete() { b.remove(); },
            });
          }, delay);
        })(box, i * 180);
      }
    }
  };
  if (creatureEl && hasAnime()) {
    anime({ targets: creatureEl, translateY: [0, -90], duration: 320, easing: 'easeOutQuad', direction: 'alternate', loop: 1, complete: fire });
  } else {
    fire();
  }
}

/**
 * 5. 广播：喇叭摇晃 + 全员纯 CSS 欢呼（对照原型 sendBroadcast）
 *    注意原型有个 selector 笔误（'.creature.c-inner' 匹配不到元素）；
 *    这里按意图修正为后代选择器，让欢呼真正生效。
 *    欢呼是纯 CSS .cheer 类，逐个延迟 70ms —— 不碰 JS 动画库。
 */
export function broadcastCheer({ megaEl }) {
  try {
    if (megaEl) {
      megaEl.classList.remove('go');
      void megaEl.offsetWidth;
      megaEl.classList.add('go');
    }
    // 纯 CSS 欢呼：逐个延迟加 cheer 类（inner 元素，无冲突）
    document.querySelectorAll('.mt-creature .mt-c-inner').forEach((el, i) => {
      setTimeout(() => {
        try {
          el.classList.remove('cheer');
          void el.offsetWidth;
          el.classList.add('cheer');
          setTimeout(() => { try { el.classList.remove('cheer'); } catch (e2) { /* noop */ } }, 700);
        } catch (e2) { /* noop */ }
      }, i * 70);
    });
    // "!" 抬头
    document.querySelectorAll('.mt-creature .mt-c-excl').forEach((e) => {
      e.classList.remove('pop');
      void e.offsetWidth;
      e.classList.add('pop');
    });
  } catch (e) { /* noop */ }
}

/** "!" pop 重触发（供新任务/广播复用） */
export function popAllExcl() {
  document.querySelectorAll('.mt-creature .mt-c-excl').forEach((e) => {
    e.classList.remove('pop');
    void e.offsetWidth;
    e.classList.add('pop');
  });
}
