(() => {
  const ST = window.__YTBPIP__ && window.__YTBPIP__.settings;
  if (!ST) return;

  const fontRange = document.getElementById('fontRange');
  const fontVal = document.getElementById('fontVal');
  const speedVal = document.getElementById('speedVal');
  const speedPills = document.getElementById('speedPills');
  const autoCc = document.getElementById('autoCc');
  const sourceVal = document.getElementById('sourceVal');
  const sourcePills = document.getElementById('sourcePills');
  const sourceHint = document.getElementById('sourceHint');
  const openBtn = document.getElementById('openBtn');
  const closeBtn = document.getElementById('closeBtn');
  const tip = document.getElementById('tip');
  const DEFAULT_TIP = tip.textContent;

  const PILL_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2];

  const SOURCE_OPTIONS = [
    {
      value: 'track',
      short: '接口',
      label: '接口 · 整段轨道',
      hint: '一次取回完整字幕，时间轴精确、一句一句显示（推荐）'
    },
    {
      value: 'dom',
      short: 'DOM',
      label: 'DOM · 播放器渲染',
      hint: '直接读播放器当前渲染的字幕，兼容性最好，但只能看到当前行'
    }
  ];

  let current = Object.assign({}, ST.DEFAULTS);

  function fmt(v) {
    return String(Math.round(Number(v) * 100) / 100);
  }

  function warn(text) {
    tip.textContent = text;
    tip.classList.add('is-warn');
  }

  function resetTip() {
    tip.textContent = DEFAULT_TIP;
    tip.classList.remove('is-warn');
  }

  function paintSpeed() {
    speedVal.textContent = fmt(current.speed) + '×';
    Array.prototype.forEach.call(speedPills.children, (btn) => {
      btn.classList.toggle('is-on', Math.abs(Number(btn.dataset.speed) - current.speed) < 0.01);
    });
  }

  function paintFont() {
    fontRange.value = String(current.fontSize);
    fontVal.textContent = current.fontSize + 'px';
  }

  function buildPills() {
    speedPills.textContent = '';
    PILL_PRESETS.forEach((speed) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pill';
      btn.dataset.speed = String(speed);
      btn.textContent = fmt(speed) + '×';
      btn.addEventListener('click', async () => {
        current = await ST.save({ speed });
        paintSpeed();
      });
      speedPills.appendChild(btn);
    });
  }

  function paintSource() {
    const active = SOURCE_OPTIONS.filter((o) => o.value === current.captionSource)[0] || SOURCE_OPTIONS[0];
    sourceVal.textContent = active.short;
    sourceHint.textContent = active.hint;
    Array.prototype.forEach.call(sourcePills.children, (btn) => {
      btn.classList.toggle('is-on', btn.dataset.source === active.value);
    });
  }

  function buildSourcePills() {
    sourcePills.textContent = '';
    SOURCE_OPTIONS.forEach((opt) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pill';
      btn.dataset.source = opt.value;
      btn.textContent = opt.label;
      btn.addEventListener('click', async () => {
        current = await ST.save({ captionSource: opt.value });
        paintSource();
      });
      sourcePills.appendChild(btn);
    });
  }

  async function sendToActiveTab(type) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || typeof tab.id !== 'number') throw new Error('no-tab');
    if (!/^https:\/\/www\.youtube\.com\//.test(tab.url || '')) throw new Error('not-youtube');
    // 超时保护：页面脚本无响应时不要一直挂着
    await Promise.race([
      chrome.tabs.sendMessage(tab.id, { type }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500))
    ]);
  }

  function describeError(e) {
    const reason = e && e.message ? e.message : '';
    if (reason === 'not-youtube') return '当前标签页不是 YouTube 页面，请先打开一个视频。';
    if (reason === 'timeout') return '页面脚本未响应。请刷新 YouTube 页面后重试。';
    if (reason.indexOf('Receiving end does not exist') >= 0 || reason.indexOf('Could not establish') >= 0) {
      return '页面脚本未注入。请刷新 YouTube 页面后重试。';
    }
    return '操作失败：' + (reason || '未知错误');
  }

  /** 关闭弹窗，让用户直接看到页面里的效果 */
  function closePopup() {
    setTimeout(() => window.close(), 260);
  }

  /** 先绑事件，保证即使后续加载出错，按钮依然可用 */
  function bindEvents() {
    fontRange.addEventListener('input', () => {
      fontVal.textContent = fontRange.value + 'px';
    });
    fontRange.addEventListener('change', async () => {
      current = await ST.save({ fontSize: Number(fontRange.value) });
      paintFont();
    });

    autoCc.addEventListener('change', async () => {
      current = await ST.save({ autoEnableCC: autoCc.checked });
    });

    openBtn.addEventListener('click', async () => {
      resetTip();
      openBtn.disabled = true;
      try {
        await sendToActiveTab('ytbpip:open');
        closePopup();
      } catch (e) {
        warn(describeError(e));
      } finally {
        openBtn.disabled = false;
      }
    });

    closeBtn.addEventListener('click', async () => {
      resetTip();
      try {
        await sendToActiveTab('ytbpip:close');
        closePopup();
      } catch (e) {
        warn(describeError(e));
      }
    });
  }

  async function main() {
    bindEvents();
    try {
      current = await ST.load();
    } catch (e) {
      /* 读取失败时沿用默认值 */
    }
    buildPills();
    buildSourcePills();
    paintFont();
    paintSpeed();
    paintSource();
    autoCc.checked = !!current.autoEnableCC;
  }

  main().catch((e) => warn('初始化失败：' + ((e && e.message) || e)));
})();
