/**
 * 完整字幕轨道读取：抓 YouTube 的 timedtext 接口（json3 格式），解析成时间轴 cue。
 *
 * 相比 DOM 取词的优点：
 *  - 拿到整段字幕，不依赖播放器当前渲染的文本
 *  - 时间轴精确，不受「逐词追加」影响
 *  - YouTube 关掉 CC 也照样能显示
 *
 * json3 对自动生成字幕会给出很细的片段（接近逐词），这里按「间隔 + 句末标点」
 * 合并成整句，避免小窗里一个字一个字蹦 —— 但每次只上屏一句：句末标点必断，
 * 攒够长度后遇到句中标点也断，整段没有标点时最多攒 MAX_LINE_LEN 个字符。
 */
(() => {
  const G = (window.__YTBPIP__ = window.__YTBPIP__ || {});
  if (G.loadTrackCues) return;

  const MERGE_GAP_MS = 600; // 相邻片段间隔小于此值视为同一句
  const MAX_LINE_LEN = 60; // 一句的字符上限，超了就断开（整段没标点时的兜底）
  const CLAUSE_BREAK_LEN = 30; // 攒到这个长度后，遇到句中标点就断开
  const SENTENCE_END_RE = /[。．.!！?？…]["'”’）)]*$/;
  const CLAUSE_END_RE = /[，,、；;：:]["'”’）)]*$/;

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  function needsSpace(prevChar, nextChar) {
    if (!prevChar || !nextChar) return false;
    if (/\s/.test(prevChar) || /\s/.test(nextChar)) return false;
    return /[A-Za-z0-9]/.test(prevChar) && /[A-Za-z0-9]/.test(nextChar);
  }

  /** json3 -> 原始片段 */
  function parseJson3(json) {
    const raw = [];
    const events = (json && json.events) || [];
    for (let i = 0; i < events.length; i++) {
      const ev = events[i];
      if (!ev || !ev.segs) continue;
      let text = '';
      for (let j = 0; j < ev.segs.length; j++) {
        text += (ev.segs[j] && ev.segs[j].utf8) || '';
      }
      text = norm(text.replace(/\n/g, ' '));
      if (!text) continue;
      const start = (Number(ev.tStartMs) || 0) / 1000;
      let end = start + (Number(ev.dDurationMs) || 0) / 1000;
      if (!(end > start)) end = start + 0.4;
      raw.push({ start, end, text });
    }
    return raw;
  }

  /** 把细碎片段合并成整句 */
  function groupLines(raw) {
    const lines = [];
    for (let i = 0; i < raw.length; i++) {
      const cur = raw[i];
      const last = lines[lines.length - 1];
      const gapMs = last ? (cur.start - last.end) * 1000 : Infinity;
      // 断开的四种情况：间隔太久 / 已经到句末 / 攒够长度遇到句中标点 / 超过字符上限
      // last 在第一个片段时是 undefined，所有取值都必须先挡住
      const clauseBreak =
        !!last && last.text.length >= CLAUSE_BREAK_LEN && CLAUSE_END_RE.test(last.text);
      const joinable =
        !!last &&
        gapMs < MERGE_GAP_MS &&
        !SENTENCE_END_RE.test(last.text) &&
        !clauseBreak &&
        last.text.length < MAX_LINE_LEN;

      if (joinable) {
        const sep = needsSpace(last.text.charAt(last.text.length - 1), cur.text.charAt(0)) ? ' ' : '';
        last.text = last.text + sep + cur.text;
        last.end = Math.max(last.end, cur.end);
      } else {
        lines.push({ start: cur.start, end: cur.end, text: cur.text });
      }
    }

    // 修正时间区间，避免重叠
    for (let i = 0; i < lines.length; i++) {
      if (i + 1 < lines.length && lines[i].end > lines[i + 1].start) {
        lines[i].end = Math.max(lines[i].start + 0.2, lines[i + 1].start);
      }
    }

    // 去掉连续重复
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const prev = out[out.length - 1];
      if (prev && prev.text === lines[i].text) {
        prev.end = Math.max(prev.end, lines[i].end);
        continue;
      }
      out.push(lines[i]);
    }
    return out;
  }

  /** 统一成 json3 地址：保留原本所有参数（含 pot），只覆盖 fmt */
  function toJson3Url(raw, tlang) {
    const url = new URL(String(raw).replace(/&amp;/g, '&'), location.origin);
    url.searchParams.set('fmt', 'json3');
    if (tlang) url.searchParams.set('tlang', tlang);
    return url;
  }

  /** 取一次并解析；失败返回 {err}，不抛异常 */
  async function attempt(url) {
    let res;
    try {
      res = await fetch(url.href, { credentials: 'include' });
    } catch (e) {
      return { err: 'fetch-failed' };
    }
    if (!res.ok) return { err: 'http-' + res.status };

    let raw = '';
    try {
      raw = await res.text();
    } catch (e) {
      return { err: 'read-failed' };
    }

    const body = raw.replace(/^\uFEFF/, '').trim();
    const ct = res.headers.get('content-type') || '';
    if (!body) return { err: 'empty status=' + res.status + ' ct=' + ct };
    if (body.charAt(0) !== '{') {
      return { err: 'not-json ct=' + ct + ' head=' + body.slice(0, 40) };
    }

    let json;
    try {
      json = JSON.parse(body);
    } catch (e) {
      return { err: 'bad-json' };
    }

    const cues = groupLines(parseJson3(json));
    if (!cues.length) return { err: 'no-events' };
    return { cues };
  }

  /**
   * @param {string} baseUrl 拦截器拿到的 timedtext 地址（必须自带 pot，否则只会返回空响应）
   * @param {string} tlang 自动翻译目标语言（可选）
   * @returns {Promise<Array<{start:number,end:number,text:string}>>}
   */
  G.loadTrackCues = async function loadTrackCues(baseUrl, tlang) {
    if (!baseUrl) throw new Error('no-track-url');

    const r = await attempt(toJson3Url(baseUrl, tlang));
    if (r.cues) return r.cues;
    throw new Error(r.err || 'no-track-url');
  };
})();
