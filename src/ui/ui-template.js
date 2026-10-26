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

  const LH_RATIO = 1.28; // 当前句行高 / 字号（与 .ytbpip-text 的 line-height 一致）
  const MIN_FIT_PX = 11; // 自动缩字号的下限，再小就看不清了
  const LYRIC_MAX_CUR_LINES = 4; // 歌词模式当前句最多占几行
  const WHEEL_STEP = 60; // 滚轮累计多少算翻一行

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
    const linesEl = el('div', 'ytbpip-lines');
    // 歌词模式五行：上两句 / 当前句 / 下两句（离当前句越远越靠外）
    const farPrevEl = el('div', 'ytbpip-ghost');
    const prevEl = el('div', 'ytbpip-ghost');
    const textEl = el('div', 'ytbpip-text is-placeholder', '等待字幕…');
    const nextEl = el('div', 'ytbpip-ghost');
    const farNextEl = el('div', 'ytbpip-ghost');
    const toastEl = el('div', 'ytbpip-toast', '已复制');
    const ghostEls = [farPrevEl, prevEl, nextEl, farNextEl];

    ghostEls.slice(0, 2).forEach((n) => linesEl.appendChild(n));
    linesEl.appendChild(textEl);
    ghostEls.slice(2).forEach((n) => linesEl.appendChild(n));

    const copy = makeCopier(doc);
    let toastTimer = 0;
    const win = doc.defaultView || window;
    let isLyrics = false; // false = 字幕模式（单行大字），true = 歌词模式（三行）

    /** 0 = 上下各两句；1 = 上下各一句；2 = 只留当前句 */
    function setGhostLevel(level) {
      farPrevEl.style.display = level >= 1 ? 'none' : '';
      farNextEl.style.display = level >= 1 ? 'none' : '';
      prevEl.style.display = level >= 2 ? 'none' : '';
      nextEl.style.display = level >= 2 ? 'none' : '';
    }

    /**
     * 尽量把整句显示完整，且**尽量不动字号**：
     *  1. 先用用户设定的字号算出当前句能占几行；
     *  2. 放不下就收起外侧的上下文行（五行 → 三行 → 一行）；
     *  3. 收到只剩当前句还放不下，才真的缩字号。
     * 这样长句来的时候变的是「行数」，而不是「字体突然变小」。
     */
    function fitText() {
      linesEl.style.fontSize = '';
      const base = parseFloat(win.getComputedStyle(linesEl).fontSize) || 20;
      const avail = Math.max(24, body.clientHeight - 8); // body 上下内边距各 4px
      const min = Math.min(base, MIN_FIT_PX);
      const levels = isLyrics ? [0, 1, 2] : [0];

      /** 在某个字号 + 某个行数档位下量一次：当前句真实高度 vs 剩余空间能放几行 */
      const probe = (size, level) => {
        setGhostLevel(level);
        linesEl.style.fontSize = size + 'px';
        // 量真实高度时必须解除当前句的行数上限，否则量到的永远是被截断后的高度
        textEl.style.webkitLineClamp = '99';
        let ghostHeight = 0;
        for (let i = 0; i < ghostEls.length; i++) ghostHeight += ghostEls[i].scrollHeight;
        const lh = LH_RATIO * size;
        let lines = Math.floor((avail - ghostHeight) / lh);
        if (isLyrics) lines = Math.min(lines, LYRIC_MAX_CUR_LINES);
        lines = Math.max(1, lines);
        return { ok: textEl.scrollHeight <= lines * lh + 1, lines: lines };
      };

      const apply = (size, level, lines) => {
        setGhostLevel(level);
        linesEl.style.fontSize = size === base ? '' : size + 'px';
        textEl.style.webkitLineClamp = String(lines);
      };

      // 1) 字号不动，依次收起上下文行
      for (let i = 0; i < levels.length; i++) {
        const r = probe(base, levels[i]);
        if (r.ok) {
          apply(base, levels[i], r.lines);
          return;
        }
      }

      // 2) 只剩当前句还放不下，才缩字号（字号越小行数只会不变或变少，可以二分）
      const last = levels[levels.length - 1];
      if (!probe(min, last).ok) {
        const r = probe(min, last);
        apply(min, last, r.lines);
        return;
      }
      let lo = min;
      let hi = base;
      for (let i = 0; i < 7 && hi - lo > 0.5; i++) {
        const mid = (lo + hi) / 2;
        if (probe(mid, last).ok) lo = mid;
        else hi = mid;
      }
      apply(lo, last, probe(lo, last).lines);
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

    /* 歌词模式：滚轮上下翻看整段字幕。
     * 累计滚动量达到一档（WHEEL_STEP）才发一次指令，避免触控板连续微调刷屏。
     */
    let wheelAcc = 0;
    let wheelIdle = 0;
    body.addEventListener(
      'wheel',
      (e) => {
        if (!isLyrics) return;
        e.preventDefault();
        wheelAcc += e.deltaY;
        const step = wheelAcc >= WHEEL_STEP ? 1 : wheelAcc <= -WHEEL_STEP ? -1 : 0;
        if (step) {
          wheelAcc = 0;
          onCommand('scroll', step);
        }
        if (wheelIdle) clearTimeout(wheelIdle);
        wheelIdle = setTimeout(() => {
          wheelIdle = 0;
          wheelAcc = 0;
        }, 300);
      },
      { passive: false }
    );

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
    body.appendChild(linesEl);
    root.appendChild(body);
    root.appendChild(bar);
    root.appendChild(toastEl);

    let lastSpeed = '';
    let lastPlaying = false;
    let lastFontSize = 0;
    let needFit = true;

    /** 写入上下文行，内容没变就不动（避免无谓的重排与 fitText） */
    function setGhost(node, value) {
      const v = (value || '').trim();
      if (node.textContent === v) return;
      node.textContent = v;
      needFit = true;
    }

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

      // 显示模式切换：歌词模式才显示上下句
      const wantLyrics = !!state.lyrics;
      if (wantLyrics !== isLyrics) {
        isLyrics = wantLyrics;
        linesEl.classList.toggle('is-lyrics', isLyrics);
        needFit = true;
      }

      // 上下文行：没内容时留空，由 .ytbpip-ghost:empty 隐藏。数组按「离当前句由近到远」排列
      const prev = isLyrics && Array.isArray(state.prev) ? state.prev : [];
      const next = isLyrics && Array.isArray(state.next) ? state.next : [];
      setGhost(farPrevEl, prev[1]);
      setGhost(prevEl, prev[0]);
      setGhost(nextEl, next[0]);
      setGhost(farNextEl, next[1]);

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
