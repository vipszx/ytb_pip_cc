/**
 * MAIN world 适配器：当 isolated world 无法直接创建 Document PiP 窗口时，
 * 由页面上下文代为打开，并把状态/指令在两个 world 之间转发。
 *
 * 同时承担完整字幕轨道的关键一环：YouTube 的 timedtext 接口有 PO token 门禁，
 * 只有播放器自己发出的请求（带 pot/potc）才不会返回空响应。隔离世界拿不到
 * 这些地址，因此由本脚本在页面上下文里包装 fetch / XHR 把它们记下来。
 */
(() => {
  const G = window.__YTBPIP__;
  if (!G || !G.protocol || !G.openPipWindow) return;
  if (G.__mainReady) return;
  G.__mainReady = true;

  /* ---------------- 拦截播放器自己的 timedtext 请求（拿 pot 参数） ----------------
   * 必须尽早装，抢在播放器拉字幕之前。这些 URL 里带 pot/potc/xorb，重放才不被空响应。
   */
  const MAX_HINTS = 12;
  const timedTextUrls = [];

  function rememberTimedText(url) {
    try {
      const u = new URL(String(url), location.href);
      if (u.pathname.indexOf('/api/timedtext') === -1) return;
      // 播放器拉过字幕后参数会刷新，旧地址失效，因此最新的在前
      if (timedTextUrls.indexOf(u.href) === -1) timedTextUrls.unshift(u.href);
      if (timedTextUrls.length > MAX_HINTS) timedTextUrls.length = MAX_HINTS;
    } catch (e) {
      /* 忽略 */
    }
  }

  try {
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function (input) {
        try {
          rememberTimedText(typeof input === 'string' ? input : input && input.url);
        } catch (e) {
          /* 永不打断页面自己的请求 */
        }
        return origFetch.apply(this, arguments);
      };
    }
    const origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        rememberTimedText(url);
      } catch (e) {
        /* 同上 */
      }
      return origOpen.apply(this, arguments);
    };
  } catch (e) {
    /* 恶劣环境：降级为 DOM 取词仍可用 */
  }

  const P = G.protocol;
  const T = P.T;
  const WIDTH = 420;
  const HEIGHT = 132;

  const log = (...args) => {
    try {
      console.log('%c[ytbpip·main]', 'color:#22d3ee;font-weight:600', ...args);
    } catch (e) {
      /* 忽略 */
    }
  };

  /** 页面控制台可直接查看：__ytbpipDiag */
  const diag = (window.__ytbpipDiag = {
    api: G.pipSupported(),
    requests: 0,
    opened: false,
    lastError: ''
  });

  let host = null;
  let lastState = null;
  let pending = false;

  log('MAIN world 已就绪', { pipSupported: diag.api });

  function post(type, payload) {
    P.post(P.EV_TO_ISOLATED, type, payload);
  }

  async function openPip(opts) {
    diag.requests += 1;
    log('收到打开请求', { pending, hasApi: diag.api, existing: !!(host && host.isOpen()) });
    if (pending) return;
    if (host && host.isOpen()) {
      post(T.OPENED, {});
      return;
    }

    pending = true;
    try {
      host = await G.openPipWindow({
        width: WIDTH,
        height: (opts && opts.height) || HEIGHT,
        initialState: lastState,
        onCommand(cmd, value) {
          post(T.CMD, { cmd, value });
        },
        onClosed() {
          host = null;
          post(T.CLOSED, {});
        }
      });
      diag.opened = true;
      diag.lastError = '';
      log('PiP 窗口创建成功（MAIN world）');
      post(T.OPENED, {});
    } catch (err) {
      diag.lastError = (err && (err.name + ': ' + err.message)) || String(err);
      log('打开 PiP 失败：', diag.lastError);
      post(T.OPEN_FAILED, { reason: 'requestWindow', message: diag.lastError });
    } finally {
      pending = false;
    }
  }

  function closePip() {
    if (host) host.close();
  }

  /* ---------------- 完整字幕轨道 ---------------- */

  const VIDEO_ID_RE = /[?&]v=([^&]+)/;

  /** 找一条属于当前视频的 timedtext 地址（带 pot），供隔离世界直接拉取 */
  function getTimedTextHint(videoId) {
    if (!videoId) return timedTextUrls[0] || '';
    for (let i = 0; i < timedTextUrls.length; i++) {
      if (timedTextUrls[i].indexOf('v=' + videoId) >= 0) return timedTextUrls[i];
    }
    // 地址里没有 v= 参数时判断不了归属，按「就是当前视频」处理
    for (let i = 0; i < timedTextUrls.length; i++) {
      if (!VIDEO_ID_RE.test(timedTextUrls[i])) return timedTextUrls[i];
    }
    return '';
  }

  function replyTrack(payload) {
    const reqVideoId = (payload && payload.videoId) || '';
    const hint = getTimedTextHint(reqVideoId);
    log('timedtext 地址', {
      videoId: reqVideoId,
      intercepted: timedTextUrls.length,
      hit: !!hint,
      // 拦截到的地址分别属于哪个视频，用于判断是不是「拦截到了但视频对不上」
      ids: timedTextUrls.slice(0, 4).map((u) => {
        const m = VIDEO_ID_RE.exec(u);
        return m ? m[1] : '(no v=)';
      })
    });
    post(T.TRACK_RES, {
      videoId: reqVideoId,
      baseUrl: hint,
      source: 'timedtext-hint',
      languageCode: '',
      kind: '',
      tlang: ''
    });
  }

  P.on(P.EV_TO_MAIN, (type, payload) => {
    switch (type) {
      case T.OPEN:
        openPip(payload);
        break;
      case T.CLOSE:
        closePip();
        break;
      case T.RENDER:
        lastState = payload;
        if (host) host.update(payload);
        break;
      case T.TRACK_REQ:
        replyTrack(payload);
        break;
      default:
        break;
    }
  });

})();
