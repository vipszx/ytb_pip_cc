/**
 * 渲染层：与宿主解耦。PiP 窗口（MAIN world 创建于 PiP document）与浮动小窗
 * （isolated world 创建于 Shadow DOM）复用同一套 DOM 结构与更新逻辑。
 */
(() => {
  const G = (window.__YTBPIP__ = window.__YTBPIP__ || {});
  if (G.createUI) return;

  const ICON_PLAY = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.2v13.6a.8.8 0 0 0 1.22.68l10.4-6.8a.8.8 0 0 0 0-1.36L9.22 4.52A.8.8 0 0 0 8 5.2z"/></svg>';
  const ICON_PAUSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>';
  const ICON_CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12 19 6.4 17.6 5 12 10.6z"/></svg>';

  function fmtSpeed(v) {
    const n = Math.round((Number(v) || 1) * 100) / 100;
    return String(n);
  }

  const MAX_TEXT_LINES = 3; // 最多占 3 行
  const MIN_FIT_PX = 11; // 自动缩字号的下限，再小就看不清了

  /**
   * 复制到剪贴板：优先 Clipboard API（PiP 与 YouTube 页均为安全上下文），
   * 失败时退回「临时 textarea + execCommand」。
   * @param {Document} doc UI 所在的文档（PiP document 或主页面 document）
   */
  function makeCopier(doc) {
    const win = doc.defaultView || window;
    return async function copy(text) {
      if (!text) return false;
      try {
        const nav = win.navigator;
        if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
          await nav.clipboard.writeText(text);
          return true;
        }
      } catch (e) {
        /* 落到兜底方案 */
      }
      try {
        const ta = doc.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.cssText =
          'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;';
        const host = doc.body || doc.documentElement;
        host.appendChild(ta);
        ta.select();
        ta.setSelectionRange(0, text.length);
        const ok = doc.execCommand('copy');
        ta.remove();
        return !!ok;
      } catch (e) {
        return false;
      }
    };
  }

  /**
   * @param {Document} doc 创建 DOM 的文档（PiP document 或主页面 document）
   * @param {{onCommand:(cmd:string, value?:number)=>void, label?:string}} options
   */
  G.createUI = function createUI(doc, options) {
    const onCommand = (options && options.onCommand) || function () {};

    const el = (tag, cls, text) => {
      const node = doc.createElement(tag);
      if (cls) node.className = cls;
      if (text != null) node.textContent = text;
      return node;
    };

    const root = el('div', 'ytbpip-root');
    const body = el('div', 'ytbpip-body');
    const textEl = el('div', 'ytbpip-text is-placeholder', '等待字幕…');
    const toastEl = el('div', 'ytbpip-toast', '已复制');

    const copy = makeCopier(doc);
    let toastTimer = 0;
    const win = doc.defaultView || window;

    /**
     * 尽量把整句显示完整：3 行放不下就缩字号。
     * 字号越小、行数只会不变或变少，所以「放不放得下」对字号是单调的，可以二分。
     */
    function fitText() {
      textEl.style.fontSize = '';
      const cs = win.getComputedStyle(textEl);
      const base = parseFloat(cs.fontSize) || 20;
      const lhRatio = (parseFloat(cs.lineHeight) || base * 1.28) / base;
      const avail = Math.max(24, body.clientHeight - 8); // body 上下内边距各 4px
      const min = Math.min(base, MIN_FIT_PX);

      const fits = (size) => {
        textEl.style.fontSize = size + 'px';
        // 高度预算：可用高度 与 3 行行高，取小的那个
        return textEl.scrollHeight <= Math.min(avail, size * lhRatio * MAX_TEXT_LINES) + 1;
      };

      // 量真实高度时必须解除行数上限，否则量到的永远是被截断后的高度
      const savedClamp = textEl.style.webkitLineClamp;
      textEl.style.webkitLineClamp = '99';
      try {
        if (fits(base)) {
          textEl.style.fontSize = ''; // 原字号就放得下，交回 CSS 控制
          return;
        }
        if (!fits(min)) return; // 最小字号仍放不下，只能交给 line-clamp 截断

        let lo = min;
        let hi = base;
        for (let i = 0; i < 7 && hi - lo > 0.5; i++) {
          const mid = (lo + hi) / 2;
          if (fits(mid)) lo = mid;
          else hi = mid;
        }
        fits(lo);
      } finally {
        textEl.style.webkitLineClamp = savedClamp;
      }
    }

    // 窗口被拖动缩放后重新适配（观察 body，字体变化不会反过来触发它）
    let ro = null;
    if (typeof win.ResizeObserver === 'function') {
      let rafId = 0;
      ro = new win.ResizeObserver(() => {
        if (rafId) return;
        rafId = win.requestAnimationFrame(() => {
          rafId = 0;
          fitText();
        });
      });
      ro.observe(body);
    }

    function showToast(msg) {
      toastEl.textContent = msg;
      toastEl.classList.add('is-on');
      if (toastTimer) clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('is-on'), 1100);
    }

    // 点击字幕文字即复制当前句
    textEl.title = '点击复制字幕';
    textEl.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (textEl.classList.contains('is-placeholder')) return;
      const text = (textEl.textContent || '').trim();
      if (!text) return;
      const ok = await copy(text);
      showToast(ok ? '已复制' : '复制失败');
    });

    const bar = el('div', 'ytbpip-bar');
    const statusEl = el('div', 'ytbpip-status', '1× · 字幕关');
    const btns = el('div', 'ytbpip-btns');

    const makeBtn = (cls, content, title, onClick) => {
      const b = el('button', 'ytbpip-btn ' + cls);
      b.type = 'button';
      b.title = title;
      b.setAttribute('aria-label', title);
      if (content.charAt(0) === '<') b.innerHTML = content;
      else b.textContent = content;
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        onClick(e);
      });
      // 避免点击工具条按钮时被外层拖拽逻辑吞掉
      b.addEventListener('pointerdown', (e) => e.stopPropagation());
      return b;
    };

    const playBtn = makeBtn('is-play', ICON_PLAY, '播放/暂停', () => onCommand('playPause'));
    const slowerBtn = makeBtn('', '−', '减速 0.25×', () => onCommand('speedStep', -0.25));
    const speedBtn = makeBtn('is-speed', '1×', '切换常用倍速', () => onCommand('speedCycle'));
    const fasterBtn = makeBtn('', '+', '加速 0.25×', () => onCommand('speedStep', 0.25));
    const sep = el('div', 'ytbpip-sep');
    const fontDownBtn = makeBtn('is-font', 'A−', '减小字号', () => onCommand('fontStep', -2));
    const fontUpBtn = makeBtn('is-font', 'A+', '增大字号', () => onCommand('fontStep', 2));
    const ccBtn = makeBtn('', 'CC', '开/关 YouTube 字幕', () => onCommand('toggleCc'));
    const closeBtn = makeBtn('is-close', ICON_CLOSE, '关闭小窗', () => onCommand('closeWindow'));

    [playBtn, slowerBtn, speedBtn, fasterBtn, sep, fontDownBtn, fontUpBtn, ccBtn, closeBtn].forEach((n) => btns.appendChild(n));

    bar.appendChild(statusEl);
    bar.appendChild(btns);
    body.appendChild(textEl);
    root.appendChild(body);
    root.appendChild(bar);
    root.appendChild(toastEl);

    let lastSpeed = '';
    let lastPlaying = false;
    let lastFontSize = 0;
    let needFit = true;

    function update(state) {
      if (!state) return;

      const fontSize = Number(state.fontSize);
      if (Number.isFinite(fontSize) && fontSize > 0 && fontSize !== lastFontSize) {
        root.style.setProperty('--fs', fontSize + 'px');
        lastFontSize = fontSize;
        needFit = true;
      }

      const text = (state.text || '').trim();
      const hasText = text.length > 0;
      const nextText = hasText ? text : state.ccOn ? '等待字幕…' : '字幕未开启 · 点 CC 开启';

      if (textEl.textContent !== nextText) {
        needFit = true;
        // 同一句的流式增长不做动画，只有真正换句才淡入，避免逐字闪烁
        const shown = textEl.dataset.shown || '';
        const grew =
          !!shown && hasText && (nextText.indexOf(shown) === 0 || shown.indexOf(nextText) === 0);
        textEl.textContent = nextText;
        if (hasText && !grew) {
          textEl.classList.remove('is-fading');
          // 强制重排以重放淡入动画
          void textEl.offsetWidth;
          textEl.classList.add('is-fading');
        }
        textEl.dataset.shown = nextText;
      }
      textEl.classList.toggle('is-placeholder', !hasText);

      // 文字或字号变了才重新量高度，避免每个 tick 都触发重排
      if (needFit) {
        needFit = false;
        fitText();
      }

      const speed = fmtSpeed(state.speed);
      if (speed !== lastSpeed) {
        speedBtn.textContent = speed + '×';
        lastSpeed = speed;
      }
      statusEl.textContent = speed + '× · ' + (state.ccOn ? '字幕开' : '字幕关');
      statusEl.classList.toggle('is-off', !state.ccOn);

      ccBtn.classList.toggle('is-on', !!state.ccOn);

      const playing = !!state.playing;
      if (playing !== lastPlaying) {
        playBtn.innerHTML = playing ? ICON_PAUSE : ICON_PLAY;
        playBtn.title = playing ? '暂停' : '播放';
        playBtn.setAttribute('aria-label', playBtn.title);
        lastPlaying = playing;
      }
    }

    function destroy() {
      if (ro) ro.disconnect();
      if (root.parentNode) root.parentNode.removeChild(root);
    }

    return { root, bar, update, destroy };
  };
})();
