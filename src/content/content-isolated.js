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
  const PIP_HEIGHT_SUBTITLE = 132;
  // 歌词模式五行：190 才能在当前句占两行时仍保住 20px 字号，180 会逼着收起上下句
  const PIP_HEIGHT_LYRICS = 190;

  /** 歌词模式需要更多高度，否则五行会逼着字号一路缩小 */
  function pipHeight() {
    return S.settings.displayMode === 'lyrics' ? PIP_HEIGHT_LYRICS : PIP_HEIGHT_SUBTITLE;
  }

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
    // prev / next 是数组，按「离当前句由近到远」排列，最多 LYRIC_CONTEXT 条
    caption: { text: '', prev: [], next: [], ccOn: false },
    tracker: null,
    pipRemote: false, // MAIN world 托管的 PiP 窗口
    floatWin: null,
    floatOn: false,
    active: false,
    stick: false, // 是否把小窗设定的倍速钉住（关闭小窗后仍生效）
    lastKey: '',
    pollId: 0,
    // 完整字幕轨道（优先通道）；失败则退回 DOM 取词
    cue: {
      list: null, // [{start,end,text}] 秒
      mode: 'dom', // 'track' = 轨道驱动，'dom' = DOM 取词
      videoId: '', // 当前 cue 属于哪个视频
      pending: false,
      attempts: 0, // 同一视频的请求次数（超时重试用）
      timer: 0,
      timeout: 0,
      retryTimer: 0 // pot 要等播放器拉过字幕，失败后延迟重试一次
    },
    // 歌词模式滚轮翻看：翻看时以 base 为锚点，不跟着播放进度漂移
    lyric: { active: false, base: 0, offset: 0, timer: 0 }
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
      if (S.cue.mode === 'track') updateFromCues();
    });

    v.addEventListener('emptied', () => {
      if (S.active) resetTrackForNewVideo();
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
      prev: S.caption.prev,
      next: S.caption.next,
      speed: Math.round(rate * 100) / 100,
      playing: !!(v && !v.paused && !v.ended),
      ccOn: !!ccOn,
      fontSize: S.settings.fontSize,
      lyrics: S.settings.displayMode === 'lyrics'
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
        S.caption.ccOn = cap.ccOn;
        // 轨道模式由 cue 驱动文本，DOM 取词只用来同步 CC 状态
        if (S.cue.mode === 'track') {
          syncRender(false);
          return;
        }
        S.caption.text = cap.text;
        S.caption.prev = cap.prev ? [cap.prev] : [];
        S.caption.next = []; // DOM 只能拿到已渲染的行，没有「下一句」
        syncRender(false);
      });
    }
    S.tracker.start();
    if (S.cue.mode === 'track') startCueDriver();
  }

  function stopTracking() {
    if (S.tracker) S.tracker.stop();
  }

  /* ---------------- 完整字幕轨道（优先通道） ---------------- */

  const CUE_TICK_MS = 100;
  const TRACK_TIMEOUT_MS = 1500; // 等 MAIN world 回轨道地址的超时
  const CUE_RETRY_MS = 1800; // pot 要等播放器先拉过字幕，失败后延迟重试
  const LYRIC_BROWSE_MS = 6000; // 歌词模式翻看后停多久自动回到播放位置
  const LYRIC_CONTEXT = 2; // 歌词模式当前句上下各显示几句
  const CUE_LINGER_S = 3; // 句间空隙超过这个时长就清屏

  function currentVideoId() {
    try {
      return new URLSearchParams(location.search).get('v') || '';
    } catch (e) {
      return '';
    }
  }

  function stopCueDriver() {
    if (S.cue.timer) {
      clearInterval(S.cue.timer);
      S.cue.timer = 0;
    }
  }

  function clearTrackTimeout() {
    if (S.cue.timeout) {
      clearTimeout(S.cue.timeout);
      S.cue.timeout = 0;
    }
  }

  /** 回退到 DOM 取词 */
  function useDomCaptions(reason) {
    clearTrackTimeout();
    stopLyricBrowse(); // DOM 模式没有整段列表，翻看不可用
    S.cue.pending = false;
    const wasTrack = S.cue.mode === 'track';
    S.cue.mode = 'dom';
    S.cue.list = null;
    stopCueDriver();
    if (wasTrack) {
      S.caption.text = '';
      S.caption.prev = [];
      S.caption.next = [];
      syncRender(true);
    }
    log('改用 DOM 取词：' + reason);
  }

  /** 切换视频时清空轨道缓存 */
  function resetTrackForNewVideo() {
    const vid = currentVideoId();
    if (vid && vid === S.cue.videoId && S.cue.mode === 'track') return;
    clearTrackTimeout();
    S.cue.pending = false;
    S.cue.mode = 'dom';
    S.cue.list = null;
    S.cue.videoId = '';
    S.cue.attempts = 0;
    if (S.cue.retryTimer) {
      clearTimeout(S.cue.retryTimer);
      S.cue.retryTimer = 0;
    }
    stopLyricBrowse();
    stopCueDriver();
    S.caption.text = '';
    S.caption.prev = [];
    S.caption.next = [];
  }

  /** timedtext 地址只能由 MAIN world 提供（它才拦得到带 pot 的请求） */
  function requestTrack(force) {
    if (!G.loadTrackCues) return;
    const vid = currentVideoId();
    if (!vid || S.cue.pending) return;
    if (!force && S.cue.mode === 'track' && S.cue.videoId === vid) return;

    // 已手动切到 DOM 取词：不再请求轨道
    if (S.settings.captionSource === 'dom') {
      if (S.cue.mode !== 'dom') useDomCaptions('已切换到 DOM 取词模式');
      return;
    }

    S.cue.pending = true;
    clearTrackTimeout();
    P.post(P.EV_TO_MAIN, T.TRACK_REQ, { videoId: vid });

    S.cue.timeout = setTimeout(() => {
      S.cue.timeout = 0;
      if (!S.cue.pending) return; // 已响应
      S.cue.pending = false;
      if (S.active && S.cue.attempts < 2) {
        S.cue.attempts += 1;
        log('MAIN world 未响应轨道请求，重试', { videoId: vid });
        requestTrack(true);
        return;
      }
      useDomCaptions('MAIN world 未返回字幕地址');
    }, TRACK_TIMEOUT_MS);
  }

  /** pot 要等播放器真正拉过字幕才有，失败后延迟再问一次 */
  function armCueRetry(vid) {
    if (S.cue.retryTimer) return;
    if (S.settings.captionSource === 'dom') return; // DOM 模式下不必再问接口
    S.cue.retryTimer = setTimeout(() => {
      S.cue.retryTimer = 0;
      if (!S.active || S.cue.mode === 'track') return;
      if (currentVideoId() !== vid) return;
      log('重试取轨道（等播放器拉过字幕）');
      requestTrack(true);
    }, CUE_RETRY_MS);
  }

  function sameList(a, b) {
    if (!a || !b || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) return false;
    }
    return true;
  }

  /** 歌词模式滚轮翻看：delta = +1 向下（看后面的）/ -1 向上 */
  function scrollLyrics(delta) {
    if (!delta) return;
    if (S.settings.displayMode !== 'lyrics') return;
    const list = S.cue.list;
    if (S.cue.mode !== 'track' || !list || !list.length) return;

    if (!S.lyric.active) {
      const auto = S.video && Number.isFinite(S.video.currentTime)
        ? findCueIndex(list, S.video.currentTime)
        : 0;
      S.lyric.active = true;
      S.lyric.base = auto < 0 ? 0 : auto;
    }

    const max = list.length - 1;
    const limit = Math.max(-S.lyric.base, Math.min(max - S.lyric.base, S.lyric.offset + delta));
    if (limit === S.lyric.offset) return; // 到头了
    S.lyric.offset = limit;

    if (S.lyric.timer) clearTimeout(S.lyric.timer);
    S.lyric.timer = setTimeout(() => {
      S.lyric.timer = 0;
      S.lyric.active = false;
      S.lyric.offset = 0;
      updateFromCues();
    }, LYRIC_BROWSE_MS);

    updateFromCues();
  }

  /** 退出翻看状态并回到播放位置 */
  function stopLyricBrowse() {
    if (S.lyric.timer) {
      clearTimeout(S.lyric.timer);
      S.lyric.timer = 0;
    }
    S.lyric.active = false;
    S.lyric.offset = 0;
  }

  function findCueIndex(list, t) {
    let lo = 0;
    let hi = list.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid].start <= t) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  function updateFromCues() {
    const list = S.cue.list;
    if (!list || !list.length || !S.video) return;
    const t = S.video.currentTime;
    if (!Number.isFinite(t)) return;

    // 翻看中：以进入翻看时的位置为锚点，播放进度继续走也不影响你正在看的地方
    const auto = findCueIndex(list, t);
    const idx = S.lyric.active ? S.lyric.base + S.lyric.offset : auto;
    let text = '';
    const prev = [];
    const next = [];
    // 句间小空隙保持上一句，避免闪烁；长空隙（超过 CUE_LINGER_S）清屏（翻看时不生效）
    if (idx >= 0 && idx < list.length && (S.lyric.active || t <= list[idx].end + CUE_LINGER_S)) {
      text = list[idx].text;
      // 上下文：由近到远各取 LYRIC_CONTEXT 句
      for (let i = 1; i <= LYRIC_CONTEXT; i++) {
        if (idx - i >= 0) prev.push(list[idx - i].text);
        if (idx + i < list.length) next.push(list[idx + i].text);
      }
    }

    if (
      text === S.caption.text &&
      sameList(prev, S.caption.prev) &&
      sameList(next, S.caption.next)
    ) {
      return;
    }
    S.caption.text = text;
    S.caption.prev = prev;
    S.caption.next = next;
    syncRender(false);
  }

  function startCueDriver() {
    stopCueDriver();
    S.cue.timer = setInterval(updateFromCues, CUE_TICK_MS);
    updateFromCues();
  }

  async function onTrackInfo(info) {
    clearTrackTimeout();
    S.cue.pending = false;

    // 小窗已关：不建立驱动，下次激活时重新请求
    if (!S.active) {
      S.cue.mode = 'dom';
      S.cue.list = null;
      stopCueDriver();
      return;
    }

    const vid = currentVideoId();
    if (info && info.videoId && vid && info.videoId !== vid) {
      log('轨道信息已过期，忽略');
      return;
    }
    if (!info || !info.baseUrl) {
      armCueRetry(vid);
      useDomCaptions('还没有可用的字幕地址');
      return;
    }
    if (!G.loadTrackCues) {
      useDomCaptions('缺少轨道解析模块');
      return;
    }

    try {
      const cues = await G.loadTrackCues(info.baseUrl, info.tlang);
      if (cues && cues.length) {
        applyCues(cues, vid, info.videoId || vid, 'timedtext');
        return;
      }
    } catch (err) {
      log('timedtext 取字幕失败：', (err && err.message) || err);
    }

    armCueRetry(vid);
    useDomCaptions('取不到完整字幕轨道');
  }

  /** 把 cue 列表接到渲染管线 */
  function applyCues(cues, currentId, cueVideoId, source) {
    if (currentId && currentVideoId() !== currentId) return; // 期间已切视频
    S.cue.list = cues;
    S.cue.videoId = cueVideoId;
    S.cue.mode = 'track';
    startCueDriver();
    log('已启用完整字幕轨道', { from: source, count: cues.length });
  }

  /* ---------------- 生命周期 ---------------- */

  function activate() {
    S.active = true;
    ensureVideo();
    startTracking();
    requestTrack(false);
    syncRender(true);
    setTimeout(applyPreferredSpeed, 80);
    setTimeout(ensureCcEnabled, 520);
  }

  function deactivateIfIdle() {
    if (isPipOpen() || S.floatOn) return;
    S.active = false;
    stopTracking();
    stopCueDriver();
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
        height: pipHeight(),
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
        height: pipHeight(),
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
    P.post(P.EV_TO_MAIN, T.OPEN, { height: pipHeight() });
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

      case CMD.SCROLL:
        scrollLyrics(typeof value === 'number' ? value : 0);
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
    resetTrackForNewVideo();
    setTimeout(() => {
      ensureVideo();
      ensureEntryButton();
      if (S.tracker) S.tracker.retarget();
      if (S.active) {
        applyPreferredSpeed();
        requestTrack(false);
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
        case T.TRACK_RES:
          onTrackInfo(payload);
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
    ST.onChange((next, prev) => {
      S.settings = next;
      if (!S.active) return;

      // 字幕来源被切换：立刻换轨，不用等下次开小窗
      if (prev && prev.captionSource !== next.captionSource) {
        if (next.captionSource === 'dom') {
          if (S.cue.retryTimer) {
            clearTimeout(S.cue.retryTimer);
            S.cue.retryTimer = 0;
          }
          useDomCaptions('已切换到 DOM 取词模式');
        } else {
          S.cue.videoId = '';
          S.cue.attempts = 0;
          requestTrack(true);
        }
      }

      // 展示模式被切换：歌词模式的翻看状态只在歌词模式有意义
      if (prev && prev.displayMode !== next.displayMode) {
        stopLyricBrowse();
        // PiP 窗口开出来后无法改尺寸，只能改浮动小窗；PiP 需重开才生效
        if (S.floatOn && S.floatWin) S.floatWin.setHeight(pipHeight());
        if (S.cue.mode === 'track') updateFromCues();
      }

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
