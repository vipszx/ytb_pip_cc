/**
 * 字幕抓取器：观察播放器 DOM 中 YouTube 当前渲染的字幕。
 *
 * 取词方式：按「行」读取 —— YouTube 每一行是一个 .caption-window，
 *   - 当前句 = 最后一行的文本
 *   - 上一句 = 上一行的文本（YouTube 自己渲染的，最准确）
 *   - 只有一行时，上一句退回我们自己的历史
 * 这样双行 / rollup 模式下不会把旧行和新行拼成一串，灰色行也不会迟迟不更新。
 *
 * 上屏模式（MODE 切换）：
 *   - 'mirror'（默认）：1:1 跟随官方节奏，字词原位增长，只有换行才淡入
 *   - 'sentence'：攒够一整句再整句替换
 *
 * 不使用 requestAnimationFrame：后台标签页 rAF 会暂停，而播放中的标签页不受定时器节流。
 */
(() => {
  const G = (window.__YTBPIP__ = window.__YTBPIP__ || {});
  if (G.createCaptionTracker) return;

  /**
   * 'mirror' = 跟随官方节奏；'sentence' = 整句上屏。
   *
   * 默认用 'sentence'：自动字幕是逐词增长的，mirror 会把每个词的变化都写到小窗
   * 上（小窗里就是「一个字一个字蹦」）。整句模式会攒到句末标点（110ms）或流式
   * 稳定（300ms）才整句替换，最长 1500ms 兜底；延时与抖动在这里取舍，
   * 具体数值见下面的 SETTLE_* 常量。
   *
   * 完整字幕轨道（timedtext / get_transcript）优先于本模块；轨道拿不到时才走这里——
   * YouTube 对 api/timedtext 加了 pot 校验，裸 baseUrl 一律返回 200 + 空 body。
   */
  const MODE = 'sentence';

  const MERGE_MS = 25; // mutation 合并窗口
  const SAFETY_MS = 200; // 兜底轮询
  const MIRROR_MIN_INTERVAL_MS = 90; // 镜像模式最小写屏间隔

  // 整句模式的防抖时长：越大越稳、越小越跟手。
  // 自动字幕是逐词增长的，流式防抖太短会把每个词都写上去（小窗里「一字一蹦」），
  // 太长则整句迟迟不上屏。当前值偏向「跟手」，想更稳就调大 SETTLE_STREAM_MS。
  const SETTLE_FIRST_MS = 170; // 新句第一次出现
  const SETTLE_STREAM_MS = 300; // 同一句继续增长（每来一个词都会重置这个计时）
  const SENTENCE_END_DELAY_MS = 110; // 已到句末标点，没必要再等
  const MAX_HOLD_MS = 1500; // 兜底：一直增长也要上屏
  const SENTENCE_END_RE = /[。．.!！?？…；;：:]\s*$/;

  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();

  /** 会被当作换行的块级标签 */
  const BLOCK_TAGS = /^(DIV|P|LI|TR|SECTION|ARTICLE|H[1-6]|BLOCKQUOTE)$/;

  /** 两侧都是拉丁字母/数字时才补空格，中文不需要 */
  function needsSpace(prevChar, nextChar) {
    if (!prevChar || !nextChar) return false;
    if (/\s/.test(prevChar) || /\s/.test(nextChar)) return false;
    return /[A-Za-z0-9]/.test(prevChar) && /[A-Za-z0-9]/.test(nextChar);
  }

  G.createCaptionTracker = function createCaptionTracker(onChange) {
    const SEL = G.selectors;
    const state = { text: '', prev: '', ccOn: false };

    let observer = null;
    let started = false;
    let lastEmit = '';
    let observedTarget = null;
    let mergeTimer = 0;
    let safetyTimer = 0;
    let recomputing = false;

    let pendingText = '';
    let pendingUpper = '';
    let pendingSince = 0;
    let pendingUpdates = 0;
    let flushTimer = 0;
    let lastCommitAt = 0;

    /**
     * 递归提取文本：
     *  - <br> 与块级元素视为换行 → 补一个空格（否则 "foo"/"bar" 会粘成 "foobar"）
     *  - 行内相邻节点（多个 .ytp-caption-segment）只在两侧都是拉丁字符时补空格，
     *    避免中文被拆成「你好 世界」
     */
    function collectText(node) {
      let out = '';
      const kids = node.childNodes;
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        if (child.nodeType === 3) {
          out += child.nodeValue;
          continue;
        }
        if (child.nodeType !== 1) continue;

        const tag = child.tagName;
        if (tag === 'BR') {
          out += ' ';
          continue;
        }

        const isBlock = BLOCK_TAGS.test(tag);
        const inner = collectText(child);
        if (!inner) continue;

        if (out) {
          const last = out.charAt(out.length - 1);
          const first = inner.charAt(0);
          if (isBlock) {
            if (!/\s/.test(last)) out += ' ';
          } else if (needsSpace(last, first)) {
            out += ' ';
          }
        }
        out += inner;
        if (isBlock && !/\s$/.test(out)) out += ' ';
      }
      return out;
    }

    /** 读取当前所有字幕行（按 DOM 顺序，最后一行是最新的一句） */
    function readCaptionLines() {
      const lines = [];
      try {
        const wins = document.querySelectorAll(SEL.CAPTION_WINDOW);
        for (let i = 0; i < wins.length; i++) {
          const t = norm(collectText(wins[i]));
          if (t) lines.push(t);
        }
        if (lines.length) return lines;

        // 兜底：没有 .caption-window 时，把所有 segment 拼成一行
        const segs = document.querySelectorAll(SEL.CAPTION_SEGMENT);
        let joined = '';
        for (let j = 0; j < segs.length; j++) {
          const t = norm(collectText(segs[j]));
          if (!t) continue;
          if (joined && needsSpace(joined.charAt(joined.length - 1), t.charAt(0))) joined += ' ';
          joined += t;
        }
        joined = norm(joined);
        if (joined) lines.push(joined);
      } catch (e) {
        /* 忽略 */
      }
      return lines;
    }

    function readCc() {
      const btn = document.querySelector(SEL.SUBTITLE_BUTTON);
      if (btn) {
        const pressed = btn.getAttribute('aria-pressed');
        if (pressed !== null) return pressed === 'true';
      }
      return !!document.querySelector(SEL.CAPTION_WINDOW);
    }

    function notify() {
      const key = state.text + '\u0001' + state.prev + '\u0001' + state.ccOn;
      if (key === lastEmit) return;
      lastEmit = key;
      try {
        onChange({ text: state.text, prev: state.prev, ccOn: state.ccOn });
      } catch (e) {
        console.warn('[ytbpip] caption onChange error', e);
      }
    }

    /** next 与 base 是否为同一句（前缀延伸 / 回退，或 rollup 模式下旧行被移出的后缀收缩） */
    function isGrowthOf(next, base) {
      if (!next || !base) return false;
      if (next.indexOf(base) === 0 || base.indexOf(next) === 0) return true;
      return next.length >= 6 && base.endsWith(next);
    }

    /**
     * @param {string} text 当前句
     * @param {string} upper YouTube 渲染的上一行（可能为空）
     */
    function commitText(text, upper) {
      if (!text) return;

      if (text === state.text) {
        // 正文没变，但 YouTube 给出了新的上一行
        if (upper && upper !== text && upper !== state.prev) {
          state.prev = upper;
          notify();
        }
        return;
      }

      if (isGrowthOf(text, state.text)) {
        // 同一句原位增长：只在 YouTube 明确给出上一行时才改灰色行
        state.text = text;
        if (upper && upper !== text && upper !== state.prev) state.prev = upper;
      } else {
        state.prev = upper && upper !== text ? upper : state.text;
        state.text = text;
      }
      lastCommitAt = Date.now();
      notify();
    }

    function clearFlush() {
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = 0;
      }
    }

    function flush() {
      clearFlush();
      const text = pendingText;
      const upper = pendingUpper;
      pendingText = '';
      pendingUpper = '';
      pendingSince = 0;
      pendingUpdates = 0;
      if (text) commitText(text, upper);
    }

    function pushRaw(text, upper) {
      if (!text) return;
      const prevPending = pendingText;
      const textChanged = text !== prevPending;
      const upperChanged = upper !== pendingUpper;
      if (!textChanged && !upperChanged) return;

      if (MODE === 'mirror') {
        pendingText = text;
        pendingUpper = upper;
        if (!flushTimer) {
          const wait = Math.max(0, MIRROR_MIN_INTERVAL_MS - (Date.now() - lastCommitAt));
          flushTimer = setTimeout(flush, wait);
        }
        return;
      }

      // ---- 整句模式 ----
      const sameAsPending = isGrowthOf(text, prevPending);
      const sameAsShown = isGrowthOf(text, state.text);
      if (!sameAsPending && !sameAsShown && prevPending) flush();

      if (!pendingText) {
        pendingSince = Date.now();
        pendingUpdates = 0;
      }
      pendingText = text;
      pendingUpper = upper;
      pendingUpdates += 1;

      let delay;
      if (SENTENCE_END_RE.test(text)) delay = SENTENCE_END_DELAY_MS;
      else if (pendingUpdates >= 2) delay = SETTLE_STREAM_MS;
      else delay = SETTLE_FIRST_MS;
      clearFlush();
      flushTimer = setTimeout(flush, delay);
    }

    function compute() {
      if (recomputing) return;
      recomputing = true;
      try {
        const ccOn = readCc();
        if (ccOn !== state.ccOn) {
          state.ccOn = ccOn;
          notify();
        }

        const lines = readCaptionLines();
        if (lines.length) {
          const text = lines[lines.length - 1];
          const upper = lines.length > 1 ? lines[lines.length - 2] : '';
          pushRaw(text, upper);
        }

        if (MODE !== 'mirror' && pendingText && pendingSince && Date.now() - pendingSince > MAX_HOLD_MS) {
          flush();
        }
      } finally {
        recomputing = false;
      }
    }

    function schedule() {
      if (mergeTimer) return;
      mergeTimer = setTimeout(() => {
        mergeTimer = 0;
        compute();
      }, MERGE_MS);
    }

    function pickTarget() {
      return document.querySelector(SEL.PLAYER) || document.body;
    }

    function attach() {
      if (observer) observer.disconnect();
      observedTarget = pickTarget();
      if (!observedTarget) return;
      observer = new MutationObserver(schedule);
      observer.observe(observedTarget, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }

    return {
      start() {
        if (started) return;
        started = true;
        attach();
        compute();
        if (!safetyTimer) safetyTimer = setInterval(compute, SAFETY_MS);
      },
      stop() {
        started = false;
        if (observer) {
          observer.disconnect();
          observer = null;
        }
        if (mergeTimer) {
          clearTimeout(mergeTimer);
          mergeTimer = 0;
        }
        clearFlush();
        if (safetyTimer) {
          clearInterval(safetyTimer);
          safetyTimer = 0;
        }
      },
      retarget() {
        if (!started) return;
        const next = pickTarget();
        if (next !== observedTarget) attach();
        compute();
      },
      reset() {
        state.text = '';
        state.prev = '';
        lastEmit = '';
        pendingText = '';
        pendingUpper = '';
        pendingSince = 0;
        pendingUpdates = 0;
        clearFlush();
        try {
          onChange({ text: '', prev: '', ccOn: readCc() });
        } catch (e) {
          /* 忽略 */
        }
      },
      getCcState: readCc,
      getState() {
        return { text: state.text, prev: state.prev, ccOn: state.ccOn };
      }
    };
  };
})();
