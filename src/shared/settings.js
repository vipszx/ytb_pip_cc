/**
 * 设置仓库（仅 isolated world 使用，依赖 chrome.storage）。
 */
(() => {
  const G = (window.__YTBPIP__ = window.__YTBPIP__ || {});
  if (G.settings) return;

  const KEY = 'ytbpip:settings';

  const DEFAULTS = {
    fontSize: 20, // 字幕字号 px
    speed: 1, // 默认倍速
    autoEnableCC: true, // 打开小窗时自动开启 YouTube 字幕
    // 'track' = 接口取完整字幕轨道；'dom' = 抓取播放器当前渲染的字幕
    captionSource: 'track',
    // 'lyrics' = 歌词式多行（可滚轮翻看）；'subtitle' = 单行大字
    displayMode: 'lyrics',
    // 'dark' = 深色小窗；'light' = 白底浅色小窗
    windowTheme: 'dark'
  };

  const FONT_MIN = 12;
  const FONT_MAX = 40;
  const FONT_STEP = 2;
  const SPEED_MIN = 0.25;
  const SPEED_MAX = 3;
  const SPEED_STEP = 0.25;
  const PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

  function clampFont(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return DEFAULTS.fontSize;
    return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n / FONT_STEP) * FONT_STEP));
  }

  function clampSpeed(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return DEFAULTS.speed;
    return Math.min(SPEED_MAX, Math.max(SPEED_MIN, Math.round(n * 100) / 100));
  }

  function normalize(raw) {
    const merged = Object.assign({}, DEFAULTS, raw || {});
    return {
      fontSize: clampFont(merged.fontSize),
      speed: clampSpeed(merged.speed),
      autoEnableCC: !!merged.autoEnableCC,
      captionSource: merged.captionSource === 'dom' ? 'dom' : 'track',
      displayMode: merged.displayMode === 'subtitle' ? 'subtitle' : 'lyrics',
      windowTheme: merged.windowTheme === 'light' ? 'light' : 'dark'
    };
  }

  let cache = normalize(null);

  async function load() {
    try {
      const got = await chrome.storage.local.get(KEY);
      cache = normalize(got && got[KEY]);
    } catch (e) {
      cache = normalize(null);
    }
    return cache;
  }

  async function save(patch) {
    cache = normalize(Object.assign({}, cache, patch || {}));
    try {
      await chrome.storage.local.set({ [KEY]: cache });
    } catch (e) {
      /* 扩展被重载时忽略 */
    }
    return cache;
  }

  function onChange(fn, onExternal) {
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area !== 'local' || !changes[KEY]) return;
        const next = normalize(changes[KEY].newValue);
        const prev = cache;
        cache = next;
        fn(next, prev);
      });
    } catch (e) {
      /* 忽略 */
    }
  }

  G.settings = {
    KEY,
    DEFAULTS,
    FONT_MIN,
    FONT_MAX,
    FONT_STEP,
    SPEED_MIN,
    SPEED_MAX,
    SPEED_STEP,
    PRESETS,
    clampFont,
    clampSpeed,
    normalize,
    load,
    save,
    onChange,
    get current() {
      return cache;
    }
  };
})();
