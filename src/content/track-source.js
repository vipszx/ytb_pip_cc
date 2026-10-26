/**
 * 字幕来源解析（隔离世界内完成，不依赖 MAIN world）。
 *
 * 三条路：
 *  1. 页面内联脚本里的 ytInitialPlayerResponse —— 首屏就有，零延迟，
 *     但 SPA 切视频后仍是旧数据，因此要校验 videoId；
 *  2. InnerTube /youtubei/v1/player —— 适配 SPA 切视频，拿到 captionTracks；
 *  3. InnerTube /youtubei/v1/next + /get_transcript —— 直接把整段转写取回来。
 *     推荐 timedtext 需要 PO token，缺 token 时只会返回 200 + 空 body，
 *     转写接口不需要签名，是这种情况下最可靠的来源。
 */
(() => {
  const G = (window.__YTBPIP__ = window.__YTBPIP__ || {});
  if (G.resolveTrackSource) return;

  const SCRIPT_CACHE_MS = 5000;
  const CFG_CACHE_MS = 60000;

  let scriptCache = { at: 0, text: '' };
  let cfgCache = { at: 0, cfg: null };
  let cfgLogged = false;

  /** 只拼接可能含 ytcfg / playerResponse 的内联脚本，避免每次都扫全量 1MB */
  function pageScriptsText() {
    const now = Date.now();
    if (now - scriptCache.at < SCRIPT_CACHE_MS) return scriptCache.text;

    let out = '';
    try {
      const scripts = document.getElementsByTagName('script');
      for (let i = 0; i < scripts.length; i++) {
        const el = scripts[i];
        if (el.src) continue;
        const t = el.textContent;
        if (!t || t.length < 200) continue;
        // ytcfg / VISITOR_DATA / ytInitialData 常分散在不同脚本里，都要收进来
        if (
          t.indexOf('INNERTUBE_API_KEY') < 0 &&
          t.indexOf('ytInitialPlayerResponse') < 0 &&
          t.indexOf('VISITOR_DATA') < 0 &&
          t.indexOf('ytInitialData') < 0 &&
          t.indexOf('ytcfg') < 0
        ) {
          continue;
        }
        out += t + '\n';
        if (out.length > 4000000) break; // 防御性上限
      }
    } catch (e) {
      /* 忽略 */
    }
    scriptCache = { at: now, text: out };
    return out;
  }

  function grab(re, text) {
    const m = re.exec(text);
    return m ? m[1] : '';
  }

  /** 从 startIdx 处的 '{' 开始截取一个完整 JSON 对象（考虑字符串与转义） */
  function extractJsonObject(text, startIdx) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = startIdx; i < text.length; i++) {
      const ch = text.charAt(i);
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') {
        inStr = true;
        continue;
      }
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) return text.slice(startIdx, i + 1);
      }
    }
    return '';
  }

  /** 内联 ytInitialPlayerResponse（videoId 不匹配则视为过期） */
  function parseInlinePlayerResponse(videoId) {
    const text = pageScriptsText();
    if (!text) return null;

    const key = 'ytInitialPlayerResponse';
    let from = 0;
    for (let guard = 0; guard < 8; guard++) {
      const idx = text.indexOf(key, from);
      if (idx < 0) return null;
      from = idx + key.length;

      const brace = text.indexOf('{', from);
      if (brace < 0) return null;
      const raw = extractJsonObject(text, brace);
      if (!raw || raw.length < 200) continue;

      let obj;
      try {
        obj = JSON.parse(raw);
      } catch (e) {
        continue;
      }
      const vid = obj && obj.videoDetails && obj.videoDetails.videoId;
      if (!videoId || !vid || vid === videoId) return obj;
    }
    return null;
  }

  /** 从页面数据里找 visitorData：ytcfg 可能被广告拦截器抠掉，退到 responseContext */
  function findVisitorData(text) {
    let v = grab(/"VISITOR_DATA"\s*:\s*"([^"]+)"/, text);
    if (v) return v;
    v = grab(/"responseContext":\s*\{"visitorData":"([^"]+)"/, text);
    if (v) return v;
    v = grab(/"visitorData":"([A-Za-z0-9_-]{16,})"/, text);
    return v;
  }

  /** InnerTube 所需的 key / 版本 / 访客标识，来自页面 ytcfg */
  function innertubeConfig() {
    const now = Date.now();
    if (cfgCache.cfg && now - cfgCache.at < CFG_CACHE_MS) return cfgCache.cfg;

    const text = pageScriptsText();
    if (!text) return null;

    const key = grab(/"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/, text);
    const version =
      grab(/"INNERTUBE_CONTEXT_CLIENT_VERSION"\s*:\s*"([^"]+)"/, text) ||
      grab(/"clientVersion"\s*:\s*"([\d.]+)"/, text);
    if (!key || !version) return null;

    const cfg = {
      key,
      version,
      visitor: findVisitorData(text),
      hl: grab(/"HL"\s*:\s*"([^"]+)"/, text) || document.documentElement.lang || 'en',
      gl: grab(/"GL"\s*:\s*"([^"]+)"/, text) || 'US'
    };
    cfgCache = { at: now, cfg };

    if (!cfgLogged) {
      cfgLogged = true;
      log('ytcfg 摘要', {
        key: !!cfg.key,
        version: cfg.version,
        visitor: cfg.visitor ? cfg.visitor.length + ' chars' : 'EMPTY',
        hl: cfg.hl,
        gl: cfg.gl
      });
    }
    return cfg;
  }

  const log = (...args) => {
    try {
      console.log('%c[ytbpip·src]', 'color:#f59e0b;font-weight:600', ...args);
    } catch (e) {
      /* 忽略 */
    }
  };

  /** @returns {Promise<{ok:boolean,status:number,text:string}|null>} */
  async function postInnertubeRaw(path, extra, clientOverride) {
    const cfg = innertubeConfig();
    if (!cfg) {
      log('缺少 ytcfg（API key / clientVersion）');
      return null;
    }

    const client = clientOverride || {
      clientName: 'WEB',
      clientVersion: cfg.version,
      hl: cfg.hl,
      gl: cfg.gl,
      clientFormFactor: 'UNKNOWN_FORM_FACTOR',
      clientScreen: 'WATCH'
    };
    if (!clientOverride) {
      if (cfg.visitor) client.visitorData = cfg.visitor;
      else log('未取到 VISITOR_DATA');
    }

    // WEB 客户端带 user/request 等上下文；ANDROID 客户端要和真实 App 保持精简一致
    const context = { client };
    if (!clientOverride) {
      context.user = { lockedSafetyMode: false };
      context.request = { useSsl: true };
    }
    const body = Object.assign({ context }, extra);
    // ANDROID 客户端不需要 API key，混用 WEB 的 key 反而可能被拒
    let url = location.origin + path + '?prettyPrint=false';
    if (!clientOverride) url += '&key=' + encodeURIComponent(cfg.key);

    // X-Goog-Visitor-Id / X-Origin 缺失时 InnerTube 会报 "Precondition check failed"
    const headers = {
      'Content-Type': 'application/json',
      'X-Origin': location.origin,
      'X-Youtube-Client-Name': client.clientName === 'WEB' ? '1' : '3',
      'X-Youtube-Client-Version': client.clientVersion
    };
    if (cfg.visitor) headers['X-Goog-Visitor-Id'] = cfg.visitor;

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: JSON.stringify(body)
      });
    } catch (e) {
      log(path + ' 请求异常', e && e.message);
      return null;
    }

    let text = '';
    try {
      text = await res.text();
    } catch (e) {
      text = '';
    }
    if (!res.ok) log(path + ' HTTP ' + res.status, text.slice(0, 120));
    return { ok: !!res.ok, status: res.status, text };
  }

  async function postInnertube(path, extra, clientOverride) {
    const raw = await postInnertubeRaw(path, extra, clientOverride);
    if (!raw || !raw.ok) return null;
    try {
      return JSON.parse(raw.text);
    } catch (e) {
      return null;
    }
  }

  async function postInnertubeText(path, extra) {
    const raw = await postInnertubeRaw(path, extra);
    if (!raw || !raw.ok) return '';
    return raw.text;
  }

  /** InnerTube 现取播放器响应（SPA 切视频后的主路径） */
  async function fetchPlayerResponse(videoId) {
    if (!videoId) return null;
    const json = await postInnertube('/youtubei/v1/player', {
      videoId,
      contentCheckOk: true,
      racyCheckOk: true
    });
    if (!json) return null;
    const vid = json.videoDetails && json.videoDetails.videoId;
    if (videoId && vid && vid !== videoId) return null;
    return json;
  }

  /** 轨道列表 → 选中一条：优先人工字幕，其次自动生成 */
  function pickTrack(response) {
    const list =
      (response &&
        response.captions &&
        response.captions.playerCaptionsTracklistRenderer &&
        response.captions.playerCaptionsTracklistRenderer.captionTracks) ||
      [];
    if (!list.length) return null;
    for (let i = 0; i < list.length; i++) {
      if ((list[i].kind || '') !== 'asr') return list[i];
    }
    return list[0];
  }

  function trackLabel(track) {
    const n = track && track.name;
    if (!n) return '';
    if (typeof n.simpleText === 'string') return n.simpleText;
    if (n.runs && n.runs.length) return n.runs[0].text || '';
    return '';
  }

  /**
   * @param {string} videoId
   * @returns {Promise<{videoId:string,baseUrl:string,languageCode:string,kind:string,name:string,tlang:string}|null>}
   */
  G.resolveTrackSource = async function resolveTrackSource(videoId) {
    let response = parseInlinePlayerResponse(videoId);
    let from = 'inline';

    if (!response) {
      response = await fetchPlayerResponse(videoId);
      from = 'innertube';
    }
    if (!response) return null;

    const track = pickTrack(response);
    if (!track || !track.baseUrl) return null;

    return {
      videoId: (response.videoDetails && response.videoDetails.videoId) || videoId || '',
      baseUrl: track.baseUrl,
      languageCode: track.languageCode || '',
      kind: track.kind || '',
      name: trackLabel(track),
      tlang: '',
      from
    };
  };

  /* ---------------- timedtext 的 PO token（pot） ----------------
   *
   * baseUrl 直接请求只会得到 200 + 空 body，因为播放器会额外带上 pot/potc 等
   * 参数（由播放器自行生成，我们无法自行签发）。但播放器自己发出的请求地址会
   * 留在资源计时里 —— 隔离世界用 performance.getEntriesByType('resource') 就能
   * 读到完整 URL（含 pot），不需要 MAIN world。
   */

  /** 播放器曾经请求过的 timedtext 地址（含 pot），最新的在前 */
  G.getTimedTextHints = function getTimedTextHints(videoId) {
    const out = [];
    try {
      const entries = performance.getEntriesByType('resource');
      for (let i = entries.length - 1; i >= 0 && out.length < 12; i--) {
        const name = entries[i] && entries[i].name;
        if (!name || name.indexOf('/api/timedtext') < 0) continue;
        if (videoId && name.indexOf('v=' + videoId) < 0) continue;
        if (out.indexOf(name) < 0) out.push(name);
      }
    } catch (e) {
      /* 忽略 */
    }
    return out;
  };

  /** 播放器额外加的参数，baseUrl 里没有，需要从真实请求里抄过来 */
  const PLAYER_PARAMS = [
    'pot', 'potc', 'c', 'cver', 'cplayer', 'cbr', 'cbrver',
    'cos', 'cosver', 'cplatform', 'xorb', 'xobt', 'xovt', 'xoaf', 'xospf'
  ];

  /** 候选地址：整体复用带 pot 的真实请求 → 把 pot 等参数贴到 baseUrl → 裸 baseUrl */
  G.buildTimedTextUrls = function buildTimedTextUrls(baseUrl, videoId) {
    const out = [];
    const seen = Object.create(null);
    function push(href) {
      if (href && !seen[href]) {
        seen[href] = 1;
        out.push(href);
      }
    }

    const hints = G.getTimedTextHints(videoId) || [];

    // 1. 整体复用（同一视频、同一语言）
    for (let i = 0; i < hints.length; i++) push(hints[i]);

    // 2. baseUrl 补上从真实请求里抄来的参数
    for (let i = 0; i < hints.length; i++) {
      try {
        const h = new URL(hints[i], location.href);
        const u = new URL(String(baseUrl).replace(/&amp;/g, '&'), location.origin);
        for (let j = 0; j < PLAYER_PARAMS.length; j++) {
          const v = h.searchParams.get(PLAYER_PARAMS[j]);
          if (v != null) u.searchParams.set(PLAYER_PARAMS[j], v);
        }
        push(u.href);
      } catch (e) {
        /* 忽略 */
      }
    }

    // 3. 裸 baseUrl（万一放开限制）
    try {
      const a = new URL(String(baseUrl).replace(/&amp;/g, '&'), location.origin);
      a.searchParams.set('fmt', 'json3');
      a.searchParams.set('c', 'WEB');
      push(a.href);
      const b = new URL(String(baseUrl).replace(/&amp;/g, '&'), location.origin);
      b.searchParams.set('fmt', 'json3');
      push(b.href);
    } catch (e) {
      /* 忽略 */
    }

    return out;
  };

  /**
   * 从页面内联脚本里取 get_transcript 需要的 params（ytInitialData 中的
   * getTranscriptEndpoint.params）。直接在文本上正则，避免解析几 MB 的 JSON。
   */
  function transcriptParamsFromPage() {
    const text = pageScriptsText();
    if (!text) return '';
    const m = /"getTranscriptEndpoint":\{"params":"([^"]+)"/.exec(text);
    return m ? m[1] : '';
  }

  /** 取页面自己的 INNERTUBE_CONTEXT（ytcfg 里的原样上下文，不可手工拼） */
  function innerTubeContextFromPage() {
    const text = pageScriptsText();
    if (!text) return null;
    const key = '"INNERTUBE_CONTEXT"';
    const idx = text.indexOf(key);
    if (idx < 0) return null;
    const brace = text.indexOf('{', idx + key.length);
    if (brace < 0) return null;
    const raw = extractJsonObject(text, brace);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }

  /** 在 JSON 树里按 key 收集节点，用于适配经常变动的转写结构 */
  function collectNodes(root, keyName) {
    const out = [];
    const stack = [{ node: root, depth: 0 }];
    let visited = 0;

    while (stack.length && visited < 50000) {
      const item = stack.pop();
      const node = item.node;
      visited += 1;
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        if (item.depth > 40) continue;
        for (let i = 0; i < node.length; i++) {
          const v = node[i];
          if (v && typeof v === 'object') stack.push({ node: v, depth: item.depth + 1 });
        }
        continue;
      }
      if (Object.prototype.hasOwnProperty.call(node, keyName)) out.push(node[keyName]);
      if (item.depth > 40) continue;
      for (const k in node) {
        if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
        const v = node[k];
        if (v && typeof v === 'object') stack.push({ node: v, depth: item.depth + 1 });
      }
    }
    return out;
  }

  function segmentText(seg) {
    const snippet = (seg && seg.snippet) || {};
    const runs = snippet.runs || [];
    if (runs.length) {
      let s = '';
      for (let i = 0; i < runs.length; i++) s += runs[i].text || '';
      return s.replace(/\s+/g, ' ').trim();
    }
    // ANDROID 响应里文本放在 elementsAttributedString.content
    const eas = snippet.elementsAttributedString;
    if (eas && typeof eas.content === 'string') return eas.content.replace(/\s+/g, ' ').trim();
    return '';
  }

  /**
   * 转写接口 get_transcript。
   *
   * 关键点（换成页面真实数据后才不报 "Precondition check failed"）：
   *  - params 用 ytInitialData 里的 getTranscriptEndpoint.params，不要手工拼 protobuf；
   *  - context 用 ytcfg 里的 INNERTUBE_CONTEXT 原样对象，不要手工拼 client；
   *  - 走 WEB 客户端（X-Youtube-Client-Name: 1），浏览器 UA 本就是 WEB，一致。
   * 返回 [{start,end,text}]（秒）。
   */
  G.loadTranscriptCues = async function loadTranscriptCues(videoId) {
    if (!videoId) return null;

    const ctx = innerTubeContextFromPage();
    if (!ctx) {
      log('取不到页面的 INNERTUBE_CONTEXT');
      return null;
    }
    log('INNERTUBE_CONTEXT 已取到', {
      hasClient: !!(ctx && ctx.client),
      hasVisitor: !!(ctx && ctx.client && ctx.client.visitorData)
    });

    // 新版 YouTube 不再把该端点放进 ytInitialData，退一步从 next 响应里取
    let params = transcriptParamsFromPage();
    if (params) log('params 来源：页面');
    if (!params) {
      const nextText = await postInnertubeText('/youtubei/v1/next', {
        videoId,
        contentCheckOk: true,
        racyCheckOk: true
      });
      if (nextText) {
        const m = /"getTranscriptEndpoint":\{"params":"([^"]+)"/.exec(nextText);
        params = m ? m[1] : '';
        log('params 来源：next');
      }
    }
    if (!params) {
      log('拿不到 getTranscriptEndpoint.params');
      return null;
    }

    const cfg = innertubeConfig() || {};
    let url = location.origin + '/youtubei/v1/get_transcript?prettyPrint=false';
    if (cfg.key) url += '&key=' + encodeURIComponent(cfg.key);

    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'X-Youtube-Client-Name': '1',
          'X-Youtube-Client-Version': cfg.version || '2.20240101.00.00'
        },
        body: JSON.stringify({ context: ctx, params })
      });
    } catch (e) {
      log('get_transcript 请求失败', e && e.message);
      return null;
    }
    if (!res || !res.ok) {
      const body = await res.text().catch(() => '');
      log('get_transcript HTTP ' + (res && res.status), body.slice(0, 120));
      return null;
    }

    let json;
    try {
      json = await res.json();
    } catch (e) {
      return null;
    }

    const segments = collectNodes(json, 'transcriptSegmentRenderer');
    const cues = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      if (!seg) continue;
      const text = segmentText(seg);
      if (!text) continue;
      const start = (Number(seg.startMs) || 0) / 1000;
      let end = (Number(seg.endMs) || 0) / 1000;
      if (!(end > start)) end = start + 0.5;
      const prev = cues[cues.length - 1];
      if (prev && prev.text === text) {
        prev.end = Math.max(prev.end, end);
        continue;
      }
      cues.push({ start, end, text });
    }

    if (!cues.length) {
      log('转写响应里没有可用 segment');
      return null;
    }

    // 修正区间重叠
    for (let i = 0; i < cues.length; i++) {
      if (i + 1 < cues.length && cues[i].end > cues[i + 1].start) {
        cues[i].end = Math.max(cues[i].start + 0.2, cues[i + 1].start);
      }
    }
    return cues;
  };
})();
