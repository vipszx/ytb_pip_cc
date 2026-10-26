/**
 * MAIN world 适配器：当 isolated world 无法直接创建 Document PiP 窗口时，
 * 由页面上下文代为打开，并把状态/指令在两个 world 之间转发。
 *
 * 同时也承担「完整字幕轨道」的获取：MAIN world 能直接读 window.ytcfg /
 * window.ytInitialData 与页面私有播放器对象，还能拦到播放器自己发出的
 * timedtext 请求（带 pot 参数），这些都是隔离世界做不到的。
 */
(() => {
  const G = window.__YTBPIP__;
  if (!G || !G.protocol || !G.openPipWindow) return;
  if (G.__mainReady) return;
  G.__mainReady = true;

  /* ---------------- 拦截播放器自己的 timedtext 请求（拿 pot 参数） ----------------
   * 必须尽早装，抢在播放器拉字幕之前。这些 URL 里带 pot/potc/xorb，重放才不被空响应。
   */
  const timedTextUrls = [];
  function rememberTimedText(url) {
    try {
      const u = new URL(String(url), location.href);
      if (u.pathname.indexOf('/api/timedtext') === -1) return;
      if (timedTextUrls.indexOf(u.href) === -1) timedTextUrls.unshift(u.href);
      if (timedTextUrls.length > 12) timedTextUrls.length = 12;
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
    /* 恶劣环境：其它路线仍可用 */
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

  /** 供隔离世界读取的 DOM 通道（不依赖 CustomEvent，事件被吞时也能拿到） */
  const ATTR_MAIN = 'data-ytbpip-main';
  const ATTR_TRACK = 'data-ytbpip-track';
  let lastTrackAttr = '';

  function post(type, payload) {
    P.post(P.EV_TO_ISOLATED, type, payload);
  }

  async function openPip() {
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
        height: HEIGHT,
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

  function getPlayer() {
    try {
      return document.getElementById('movie_player') || null;
    } catch (e) {
      return null;
    }
  }

  function getPlayerResponse() {
    const player = getPlayer();
    try {
      if (player && typeof player.getPlayerResponse === 'function') {
        const res = player.getPlayerResponse();
        if (res && res.captions) return res;
      }
    } catch (e) {
      /* 忽略 */
    }
    return window.ytInitialPlayerResponse || null;
  }

  function findKeyDeep(node, key, hits, depth) {
    hits = hits || [];
    if (!node || typeof node !== 'object' || (depth || 0) > 30 || hits.length > 4) return hits;
    for (const k in node) {
      if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
      if (k === key) hits.push(node[k]);
      else if (node[k] && typeof node[k] === 'object') {
        findKeyDeep(node[k], key, hits, (depth || 0) + 1);
      }
    }
    return hits;
  }

  /** 从 ytInitialData 里找转写端点 params（get_transcript 需要） */
  function transcriptParams() {
    try {
      const eps = findKeyDeep(window.ytInitialData, 'getTranscriptEndpoint', [], 0);
      for (let i = 0; i < eps.length; i++) {
        if (eps[i] && eps[i].params) return eps[i].params;
      }
    } catch (e) {
      /* 无 ytInitialData */
    }
    return null;
  }

  function segmentText(seg) {
    const snip = (seg && seg.snippet) || {};
    if (Array.isArray(snip.runs)) {
      let t = '';
      for (let i = 0; i < snip.runs.length; i++) t += (snip.runs[i] && snip.runs[i].text) || '';
      return t.replace(/\s+/g, ' ').trim();
    }
    return (typeof snip.simpleText === 'string' ? snip.simpleText : '').replace(/\s+/g, ' ').trim();
  }

  /** 从 next 响应里取 params（ytInitialData 里没有时的退路） */
  async function fetchParamsFromNext(videoId) {
    const cfg = window.ytcfg;
    let ctx = null;
    let ver = '2.20240101.00.00';
    let key = '';
    try {
      if (cfg && cfg.get) {
        ctx = cfg.get('INNERTUBE_CONTEXT');
        ver = cfg.get('INNERTUBE_CLIENT_VERSION') || ver;
        key = cfg.get('INNERTUBE_API_KEY') || '';
      }
    } catch (e) {
      /* 忽略 */
    }
    if (!ctx || !videoId) return '';

    let url = '/youtubei/v1/next?prettyPrint=false';
    if (key) url += '&key=' + encodeURIComponent(key);
    try {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Youtube-Client-Name': '1',
          'X-Youtube-Client-Version': ver
        },
        body: JSON.stringify({ context: ctx, videoId, contentCheckOk: true, racyCheckOk: true })
      });
      if (!res.ok) return '';
      const text = await res.text();
      const m = /"getTranscriptEndpoint":\{"params":"([^"]+)"/.exec(text);
      return m ? m[1] : '';
    } catch (e) {
      return '';
    }
  }

  /** InnerTube get_transcript：WEB 客户端 + 页面活 ytcfg context，不设 UA 也能拿到 */
  async function fetchTranscriptCues(videoId) {
    let params = transcriptParams();
    if (params) log('params 来源：ytInitialData');
    if (!params) {
      params = await fetchParamsFromNext(videoId);
      if (params) log('params 来源：next');
    }
    if (!params) {
      log('拿不到 getTranscriptEndpoint.params');
      return null;
    }

    const cfg = window.ytcfg;
    let ctx = null;
    let ver = '2.20240101.00.00';
    let key = '';
    try {
      if (cfg && cfg.get) {
        ctx = cfg.get('INNERTUBE_CONTEXT');
        ver = cfg.get('INNERTUBE_CLIENT_VERSION') || ver;
        key = cfg.get('INNERTUBE_API_KEY') || '';
      }
    } catch (e) {
      /* ytcfg 缺失 */
    }
    if (!ctx) return null;

    let url = '/youtubei/v1/get_transcript?prettyPrint=false';
    if (key) url += '&key=' + encodeURIComponent(key);

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Youtube-Client-Name': '1',
          'X-Youtube-Client-Version': ver
        },
        body: JSON.stringify({ context: ctx, params })
      });
    } catch (e) {
      return null;
    }
    if (!res || !res.ok) {
      const body = res ? await res.text().catch(() => '') : '';
      log('get_transcript HTTP ' + (res && res.status), body.slice(0, 160));
      return null;
    }

    let json;
    try {
      json = await res.json();
    } catch (e) {
      return null;
    }

    // 收集 transcriptSegmentRenderer（结构常变，按 key 递归找）
    const segs = [];
    (function walk(n, d) {
      if (!n || typeof n !== 'object' || d > 30 || segs.length > 20000) return;
      if (Array.isArray(n)) {
        for (let i = 0; i < n.length; i++) walk(n[i], d + 1);
        return;
      }
      if (n.transcriptSegmentRenderer) segs.push(n.transcriptSegmentRenderer);
      for (const k in n) {
        if (Object.prototype.hasOwnProperty.call(n, k)) walk(n[k], d + 1);
      }
    })(json, 0);

    const cues = [];
    for (let i = 0; i < segs.length; i++) {
      const text = segmentText(segs[i]);
      if (!text) continue;
      const start = (Number(segs[i].startMs) || 0) / 1000;
      let end = (Number(segs[i].endMs) || 0) / 1000;
      if (!(end > start)) end = start + 0.5;
      const prev = cues[cues.length - 1];
      if (prev && prev.text === text) {
        prev.end = Math.max(prev.end, end);
        continue;
      }
      cues.push({ start, end, text });
    }
    return cues.length ? cues : null;
  }

  /** 找一条属于当前视频的 timedtext URL（带 pot），供隔离世界直接拉取 */
  function getTimedTextHint(videoId) {
    for (let i = 0; i < timedTextUrls.length; i++) {
      const u = timedTextUrls[i];
      if (videoId && u.indexOf('v=' + videoId) >= 0) return u;
    }
    return timedTextUrls[0] || '';
  }

  /* ---------------- 轨道信息（playerResponse 兜底） ---------------- */

  function trackName(track) {
    const n = track && track.name;
    if (!n) return '';
    if (typeof n.simpleText === 'string') return n.simpleText;
    if (n.runs && n.runs.length) return n.runs[0].text || '';
    return '';
  }

  function pickTrack(tracks, current) {
    if (!tracks.length) return null;
    if (current && current.languageCode) {
      for (let i = 0; i < tracks.length; i++) {
        const t = tracks[i];
        if (t.languageCode !== current.languageCode) continue;
        if ((t.kind || '') !== (current.kind || '')) continue;
        return t;
      }
    }
    for (let i = 0; i < tracks.length; i++) {
      if ((tracks[i].kind || '') !== 'asr') return tracks[i];
    }
    return tracks[0];
  }

  function buildTrackInfo() {
    const res = getPlayerResponse();
    const videoId = (res && res.videoDetails && res.videoDetails.videoId) || '';
    const list =
      (res &&
        res.captions &&
        res.captions.playerCaptionsTracklistRenderer &&
        res.captions.playerCaptionsTracklistRenderer.captionTracks) ||
      [];
    const track = pickTrack(list, null);

    const info = {
      videoId,
      baseUrl: (track && track.baseUrl) || '',
      languageCode: (track && track.languageCode) || '',
      kind: (track && track.kind) || '',
      name: trackName(track),
      isTranslatable: !!(track && track.isTranslatable),
      tlang: '',
      tracks: []
    };
    for (let i = 0; i < list.length; i++) {
      info.tracks.push({
        languageCode: list[i].languageCode || '',
        kind: list[i].kind || '',
        name: trackName(list[i])
      });
    }
    return info;
  }

  function publishTrack() {
    let info;
    try {
      info = buildTrackInfo();
    } catch (e) {
      return null;
    }
    const slim = {
      videoId: info.videoId,
      baseUrl: info.baseUrl,
      languageCode: info.languageCode,
      kind: info.kind,
      name: info.name,
      tlang: info.tlang
    };
    const json = JSON.stringify(slim);
    if (json !== lastTrackAttr) {
      lastTrackAttr = json;
      try {
        document.documentElement.setAttribute(ATTR_TRACK, json);
      } catch (e) {
        /* 忽略 */
      }
    }
    return info;
  }

  async function replyTrack(payload) {
    const reqVideoId = (payload && payload.videoId) || '';

    // 1) 完整转写（默认语言，最可靠）
    const cues = await fetchTranscriptCues(reqVideoId);
    if (cues && cues.length) {
      log('回传完整转写', { count: cues.length });
      post(T.TRACK_RES, { videoId: reqVideoId, cues, source: 'transcript' });
      return;
    }

    // 2) 玩家自己请求过的 timedtext（带 pot，能避开空响应）
    const hint = getTimedTextHint(reqVideoId);
    log('timedtext 拦截数', { count: timedTextUrls.length });
    if (hint) {
      log('回传 timedtext 地址（带 pot）');
      post(T.TRACK_RES, { videoId: reqVideoId, baseUrl: hint, source: 'timedtext-hint', languageCode: '', kind: '' });
      return;
    }

    // 3) playerResponse 的 baseUrl（无 pot，多半空响应，仅兜底）
    const info = publishTrack() || { videoId: reqVideoId, baseUrl: '', tracks: [] };
    log('回传字幕轨道', { videoId: info.videoId, lang: info.languageCode, kind: info.kind, count: info.tracks.length });
    post(T.TRACK_RES, info);
  }

  P.on(P.EV_TO_MAIN, (type, payload) => {
    switch (type) {
      case T.OPEN:
        openPip();
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

  /* ---------------- DOM 就绪后再做依赖 documentElement 的事 ---------------- */

  function whenReady(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn, { once: true });
    } else {
      fn();
    }
  }

  document.addEventListener(
    'yt-navigate-finish',
    () => {
      setTimeout(publishTrack, 300);
    },
    true
  );

  function maintainTrackAttr() {
    if (location.pathname !== '/watch') return;
    publishTrack();
  }

  whenReady(() => {
    try {
      document.documentElement.setAttribute(ATTR_MAIN, '1');
    } catch (e) {
      /* 忽略 */
    }
    publishTrack();
    setInterval(maintainTrackAttr, 1500);
  });
})();
