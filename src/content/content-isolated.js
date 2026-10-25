/**
 * isolated world 主控：采集层。
 * 职责：注入播放器入口按钮、抓取字幕、接管 video 倍速与播放、读写设置、
 *       优先在当前 world 直接开 PiP 窗口（失败再请求 MAIN world），
 *       全部失败时降级为页面内浮动小窗。
 */
(() => {
  const G = window.__YTBPIP__;
  if (!G || !G.protocol || !G.selectors || !G.settings) return;
  if (!G.createCaptionTracker || !G.createFloatWindow || !G.openPipWindow) return;
  if (G.__isolatedReady) return;
  G.__isolatedReady = true;

  const P = G.protocol;
  const SEL = G.selectors;
  const ST = G.settings;
  const CMD = P.CMD;
  const T = P.T;

  const PIP_WIDTH = 420;
  const PIP_HEIGHT = 132;

  const log = (...args) => {
    try {
      console.log('%c[ytbpip·iso]', 'color:#8b5cf6;font-weight:600', ...args);
    } catch (e) {
      /* 忽略 */
    }
  };

  const S = {
    settings: Object.assign({}, ST.DEFAULTS),
    video: null,
    bound: new WeakSet(),
    desired: 1,
    lastWrite: 0,
    caption: { text: '', prev: '', ccOn: false },
    tracker: null,
    pipRemote: false, // MAIN world 托管的 PiP 窗口
    floatWin: null,
    floatOn: false,
    active: false,
    stick: false, // 是否把小窗设定的倍速钉住（关闭小窗后仍生效）
    lastKey: '',
    pollId: 0
  };

  let pipHost = null; // 本 world 直接托管的 PiP 窗口
  let openTimer = 0;
  let lastYtMenuAt = 0; // 最近一次操作 YouTube 原生设置菜单的时间

  function isPipOpen() {
    return !!pipHost || S.pipRemote;
  }

  function clearOpenWatchdog() {
    if (openTimer) {
      clearTimeout(openTimer);
      openTimer = 0;
    }
  }

  /** 打开链路超时兜底：保证用户点击后一定能看到小窗 */
  function armOpenWatchdog(source) {
    clearOpenWatchdog();
    openTimer = setTimeout(() => {
      openTimer = 0;
      if (isPipOpen() || S.floatOn) return;
      log('等待 PiP 结果超时（' + source + '），降级为页面内浮动小窗');
      openFloat();
    }, 1500);
  }

  /* ---------------- 播放器接管 ---------------- */

  function isAd() {
    const player = document.querySelector(SEL.PLAYER);
    return !!(player && player.classList.contains('ad-showing'));
  }

  function ensureVideo() {
    let v = null;
    try {
      v = document.querySelector(SEL.VIDEO) || document.querySelector('video.html5-main-video');
    } catch (e) {
      v = null;
    }
    if (v && v !== S.video) {
      S.video = v;
      bindVideo(v);
    } else if (!v) {
      S.video = null;
    }
    return S.video;
  }

  function bindVideo(v) {
    if (!v || S.bound.has(v)) return;
    S.bound.add(v);

    v.addEventListener('ratechange', () => {
      if (Math.abs(v.playbackRate - S.desired) < 0.01) {
        if (S.active) syncRender(false);
        return;
      }
      // 刚由我们写入，等下一轮事件确认
      if (Date.now() - S.lastWrite < 350) return;
      // 广告期间 YouTube 会强制 1x，不做干预
      if (isAd()) return;

      const fromYtMenu = Date.now() - lastYtMenuAt < 4000;
      if (!S.active && !S.stick && !fromYtMenu) return;

      if (fromYtMenu) {
        // 用户在 YouTube 原生菜单里改了倍速 → 采纳为新目标
        S.desired = ST.clampSpeed(v.playbackRate);
        S.settings.speed = S.desired;
        ST.save({ speed: S.desired });
        if (S.active) syncRender(true);
        return;
      }

      // YouTube 自行重置倍速（切清晰度、广告结束等）→ 钉回目标值
      S.lastWrite = Date.now();
      try {
        v.playbackRate = S.desired;
      } catch (e) {
        /* 忽略 */
      }
    });

    ['play', 'pause', 'seeked', 'ended', 'emptied'].forEach((ev) => {
      v.addEventListener(ev, () => syncRender(false));
    });

    v.addEventListener('playing', () => {
      if (!isAd()) reassertSpeed();
      syncRender(false);
    });

    v.addEventListener('seeking', () => {
      if (S.active && S.tracker) S.tracker.reset();
    });
  }

  function reassertSpeed() {
    const v = S.video;
    if (!v || !S.active) return;
    if (Math.abs(v.playbackRate - S.desired) < 0.01) return;
    S.lastWrite = Date.now();
    try {
      v.playbackRate = S.desired;
    } catch (e) {
      /* 忽略 */
    }
  }

  function setSpeed(raw, persist) {
    const value = ST.clampSpeed(raw);
    S.desired = value;
    S.stick = true;
    S.lastWrite = Date.now();
    const v = ensureVideo();
    if (v) {
      try {
        v.playbackRate = value;
      } catch (e) {
        /* 忽略 */
      }
    }
    if (persist !== false) {
      S.settings.speed = value;
      ST.save({ speed: value });
    }
    syncRender(true);
  }

  function applyPreferredSpeed() {
    const target = ST.clampSpeed(S.settings.speed);
    S.desired = target;
    S.stick = true;
    const v = ensureVideo();
    if (!v || isAd()) return;
    if (Math.abs(v.playbackRate - target) < 0.01) return;
    S.lastWrite = Date.now();
    try {
      v.playbackRate = target;
    } catch (e) {
      /* 忽略 */
    }
  }

  function readCc() {
    const btn = document.querySelector(SEL.SUBTITLE_BUTTON);
    if (btn) {
      const pressed = btn.getAttribute('aria-pressed');
      if (pressed !== null) return pressed === 'true';
    }
    return !!document.querySelector(SEL.CAPTION_WINDOW);
  }

  function ensureCcEnabled() {
    if (!S.settings.autoEnableCC) return;
    if (readCc()) return;
    const btn = document.querySelector(SEL.SUBTITLE_BUTTON);
    if (!btn) return;
    // 该视频没有字幕轨道时按钮不可见，避免误开设置菜单
    if (btn.offsetParent === null) return;
    try {
      btn.click();
    } catch (e) {
      /* 忽略 */
    }
    setTimeout(() => syncRender(true), 500);
  }

  function toggleCc() {
    const btn = document.querySelector(SEL.SUBTITLE_BUTTON);
    if (!btn) return;
    try {
      btn.click();
    } catch (e) {
      /* 忽略 */
    }
    setTimeout(() => syncRender(true), 320);
    setTimeout(() => syncRender(true), 900);
  }

  /* ---------------- 状态渲染 ---------------- */

  function buildState() {
    const v = S.video;
    const rate = v && Number.isFinite(v.playbackRate) ? v.playbackRate : S.desired;
    const ccOn = S.tracker ? S.tracker.getCcState() : S.caption.ccOn;
    return {
      text: S.caption.text || '',
      prev: S.caption.prev || '',
      speed: Math.round(rate * 100) / 100,
      playing: !!(v && !v.paused && !v.ended),
      ccOn: !!ccOn,
      fontSize: S.settings.fontSize
    };
  }

  function syncRender(force) {
    if (!S.active) return;
    const state = buildState();
    const key = JSON.stringify(state);
    if (!force && key === S.lastKey) return;
    S.lastKey = key;
    if (pipHost) pipHost.update(state);
    if (S.pipRemote) P.post(P.EV_TO_MAIN, T.RENDER, state);
    if (S.floatOn && S.floatWin) S.floatWin.update(state);
  }

  /* ---------------- 字幕抓取 ---------------- */

  function startTracking() {
    if (!S.tracker) {
      S.tracker = G.createCaptionTracker((cap) => {
        S.caption.text = cap.text;
        S.caption.prev = cap.prev;
        S.caption.ccOn = cap.ccOn;
        syncRender(false);
      });
    }
    S.tracker.start();
  }

  function stopTracking() {
    if (S.tracker) S.tracker.stop();
  }

  /* ---------------- 生命周期 ---------------- */

  function activate() {
    S.active = true;
    ensureVideo();
    startTracking();
    syncRender(true);
    setTimeout(applyPreferredSpeed, 80);
    setTimeout(ensureCcEnabled, 520);
  }

  function deactivateIfIdle() {
    if (isPipOpen() || S.floatOn) return;
    S.active = false;
    stopTracking();
    applyClosePolicy();
  }

  /** 关闭小窗后倍速一律恢复 1×，避免小窗关掉后视频还停在异常倍速 */
  function applyClosePolicy() {
    S.stick = false;
    S.desired = 1;
    S.lastWrite = Date.now();
    const v = ensureVideo();
    if (v) {
      try {
        v.playbackRate = 1;
      } catch (e) {
        /* 忽略 */
      }
    }
    log('小窗已关闭：倍速恢复 1×');
  }

  function openFloat() {
    if (!S.floatWin) {
      S.floatWin = G.createFloatWindow({
        onCommand: handleCommand,
        onClose: () => {
          S.floatOn = false;
          deactivateIfIdle();
        }
      });
    }
    S.floatWin.open();
    S.floatOn = true;
    activate();
  }

  function closeFloat() {
    if (S.floatWin) S.floatWin.close();
  }

  function closeAll() {
    if (S.floatOn) closeFloat();
    if (pipHost) pipHost.close();
    if (S.pipRemote) P.post(P.EV_TO_MAIN, T.CLOSE, {});
  }

  /* ---------------- PiP 打开链路 ---------------- */

  function onPipCommand(cmd, value) {
    if (cmd === CMD.CLOSE_WINDOW) {
      if (pipHost) pipHost.close();
      return;
    }
    handleCommand(cmd, value);
  }

  async function openLocalPip() {
    if (!G.pipSupported()) return false;
    if (pipHost && pipHost.isOpen()) return true;
    try {
      const host = await G.openPipWindow({
        width: PIP_WIDTH,
        height: PIP_HEIGHT,
        initialState: buildState(),
        onCommand: onPipCommand,
        onClosed: () => {
          pipHost = null;
          log('PiP 窗口已关闭（local）');
          deactivateIfIdle();
        }
      });
      pipHost = host;
      clearOpenWatchdog();
      log('PiP 窗口已创建（isolated world 直连）');
      activate();
      return true;
    } catch (err) {
      pipHost = null;
      log('isolated world 直连 PiP 失败：', (err && err.name) || '', (err && err.message) || '');
      return false;
    }
  }

  async function requestPip(source) {
    armOpenWatchdog(source);
    const ok = await openLocalPip();
    if (ok) return;
    log('改由 MAIN world 请求 PiP');
    P.post(P.EV_TO_MAIN, T.OPEN, {});
  }

  /* ---------------- 指令 ---------------- */

  function handleCommand(cmd, value) {
    const v = ensureVideo();
    switch (cmd) {
      case CMD.PLAY_PAUSE:
        if (v) {
          if (v.paused || v.ended) {
            const p = v.play();
            if (p && p.catch) p.catch(() => {});
          } else {
            v.pause();
          }
        }
        break;

      case CMD.SPEED_STEP:
        setSpeed(S.desired + (typeof value === 'number' ? value : ST.SPEED_STEP));
        break;

      case CMD.SPEED_CYCLE: {
        const cur = v ? v.playbackRate : S.desired;
        const presets = ST.PRESETS;
        let idx = -1;
        for (let i = 0; i < presets.length; i++) {
          if (Math.abs(presets[i] - cur) < 0.01) {
            idx = i;
            break;
          }
        }
        setSpeed(idx >= 0 ? presets[(idx + 1) % presets.length] : 1);
        break;
      }

      case CMD.FONT_STEP: {
        const delta = typeof value === 'number' ? value : ST.FONT_STEP;
        const next = ST.clampFont(S.settings.fontSize + delta);
        S.settings.fontSize = next;
        ST.save({ fontSize: next });
        syncRender(true);
        break;
      }

      case CMD.TOGGLE_CC:
        toggleCc();
        break;

      case CMD.CLOSE_WINDOW:
        if (S.floatOn) closeFloat();
        break;

      default:
        break;
    }
  }

  /* ---------------- 入口按钮 ---------------- */

  // 实心图标，风格与 YouTube 原生控制栏图标一致：容器 36px 见方，字形内缩 2px
  const ENTRY_ICON =
    '<svg viewBox="0 0 24 24" fill="currentColor" ' +
    'style="width:100%;height:100%;padding:2px;box-sizing:border-box;display:block">' +
    '<path fill-rule="evenodd" clip-rule="evenodd" d="M4.6 5h14.8A2.6 2.6 0 0 1 22 7.6v8.8a2.6 2.6 0 0 1-2.6 2.6H4.6A2.6 2.6 0 0 1 2 16.4V7.6A2.6 2.6 0 0 1 4.6 5Zm0 2a.6.6 0 0 0-.6.6v8.8a.6.6 0 0 0 .6.6h14.8a.6.6 0 0 0 .6-.6V7.6a.6.6 0 0 0-.6-.6H4.6Z"/>' +
    '<rect x="6.2" y="10" width="5" height="2" rx="1"/>' +
    '<rect x="12.8" y="10" width="5" height="2" rx="1"/>' +
    '<rect x="6.2" y="13.4" width="11.6" height="2" rx="1"/></svg>';

  function onEntryClick(e) {
    e.preventDefault();
    e.stopPropagation();
    log('点击入口按钮', { pipOpen: isPipOpen(), float: S.floatOn, localPip: !!pipHost });
    if (isPipOpen() || S.floatOn) {
      closeAll();
      return;
    }
    // 同步发起，确保仍在用户手势激活窗口内
    requestPip('entry-click');
    ensureVideo();
    setTimeout(ensureCcEnabled, 600);
  }

  function ensureEntryButton() {
    if (location.pathname !== '/watch') return;
    const right = document.querySelector(SEL.RIGHT_CONTROLS);
    if (!right) return;
    if (right.querySelector(SEL.ENTRY_BUTTON)) return;

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ytp-button ytbpip-entry';
    btn.title = '字幕画中画';
    btn.setAttribute('aria-label', '字幕画中画');
    // 不依赖 YouTube 的样式表：显式对齐原生按钮尺寸（36px 见方、全高、透明底）
    btn.style.cssText =
      'width:36px;min-width:36px;height:100%;padding:0;margin:0;border:0;background:transparent;' +
      'color:#fff;opacity:.9;cursor:pointer;display:inline-block;vertical-align:top;line-height:0;';
    btn.innerHTML = ENTRY_ICON;
    btn.addEventListener('mouseenter', () => {
      btn.style.opacity = '1';
    });
    btn.addEventListener('mouseleave', () => {
      btn.style.opacity = '.9';
    });
    btn.addEventListener('click', onEntryClick);
    right.insertBefore(btn, right.firstChild);
    log('入口按钮已注入播放器控制栏', { pipSupported: G.pipSupported() });
  }

  /* ---------------- 事件绑定 ---------------- */

  function tick() {
    ensureVideo();
    ensureEntryButton();
    if (!S.active) return;
    if (S.tracker) S.tracker.retarget();
    syncRender(false);
  }

  function onNavigate() {
    S.lastKey = '';
    setTimeout(() => {
      ensureVideo();
      ensureEntryButton();
      if (S.tracker) S.tracker.retarget();
      if (S.active) {
        applyPreferredSpeed();
        syncRender(true);
      }
    }, 350);
  }

  function bindBridge() {
    P.on(P.EV_TO_ISOLATED, (type, payload) => {
      switch (type) {
        case T.OPENED:
          clearOpenWatchdog();
          log('MAIN world 已托管 PiP 窗口');
          S.pipRemote = true;
          if (S.floatOn) closeFloat();
          activate();
          break;
        case T.CLOSED:
          log('MAIN world 的 PiP 窗口已关闭');
          S.pipRemote = false;
          deactivateIfIdle();
          break;
        case T.OPEN_FAILED:
          clearOpenWatchdog();
          log('MAIN world 打开 PiP 失败：', payload && payload.reason, payload && payload.message);
          S.pipRemote = false;
          openFloat();
          break;
        case T.CMD:
          handleCommand(payload && payload.cmd, payload && payload.value);
          break;
        default:
          break;
      }
    });
  }

  function bindRuntime() {
    try {
      chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
        if (!msg || typeof msg.type !== 'string') return undefined;
        if (msg.type === 'ytbpip:open') {
          requestPip('popup');
          ensureVideo();
          setTimeout(ensureCcEnabled, 600);
          sendResponse({ ok: true });
        } else if (msg.type === 'ytbpip:close') {
          closeAll();
          sendResponse({ ok: true });
        } else if (msg.type === 'ytbpip:ping') {
          sendResponse({ ok: true, active: isPipOpen() || S.floatOn });
        }
        return true;
      });
    } catch (e) {
      /* 扩展上下文失效时忽略 */
    }
  }

  function bindStorage() {
    ST.onChange((next) => {
      S.settings = next;
      if (!S.active) return;
      if (Math.abs(S.desired - next.speed) > 0.001) {
        setSpeed(next.speed, false);
      }
      syncRender(true);
    });
  }

  async function boot() {
    try {
      S.settings = await ST.load();
    } catch (e) {
      S.settings = Object.assign({}, ST.DEFAULTS);
    }
    S.desired = S.settings.speed;

    bindBridge();
    bindRuntime();
    bindStorage();

    ensureVideo();
    ensureEntryButton();

    document.addEventListener('yt-navigate-finish', onNavigate, true);
    window.addEventListener('popstate', onNavigate);

    // 记录用户操作 YouTube 原生设置菜单的时间，用于区分「用户改倍速」和「YouTube 重置倍速」
    document.addEventListener(
      'click',
      (e) => {
        const target = e.target;
        if (target && target.closest && target.closest('.ytp-settings-menu')) {
          lastYtMenuAt = Date.now();
        }
      },
      true
    );

    log('已注入', {
      path: location.pathname,
      pipSupported: G.pipSupported(),
      settings: S.settings
    });

    if (!S.pollId) S.pollId = setInterval(tick, 1000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
