/**
 * 样式常量：以字符串形式注入，PiP 窗口（独立 document）与页面内浮动小窗（Shadow DOM）共用，
 * 保证两种形态视觉完全一致。
 *
 * 配色全部走 CSS 变量：深色是默认值，`.ytbpip-root.is-light` 只覆盖变量即可切到浅色，
 * 不需要任何渐变或额外规则。
 */
(() => {
  const G = (window.__YTBPIP__ = window.__YTBPIP__ || {});
  if (G.CSS) return;

  /** 页面级底色（PiP 窗口的 html/body），由宿主按主题写入 */
  G.SURFACE = { dark: '#2A2A2E', light: '#FAFAFB' };

  G.CSS = `
.ytbpip-root{
  --fs: 20px;
  --fg-0:#FFFFFF;   /* 主要文字 */
  --fg-1:#C7C7D1;   /* 按钮文字 */
  --fg-2:#8A8A99;   /* 上下文行 / 占位文字 */
  --surface:#2A2A2E;
  --bar:#232327;
  --line:rgba(255,255,255,.06);
  --sep:rgba(255,255,255,.09);
  --text:#FFFFFF;   /* 字幕文字 */
  --shadow:0 1px 2px rgba(0,0,0,.55);
  --toast:rgba(0,0,0,.74);
  --btn-hover:rgba(255,255,255,.08);
  --btn-on:rgba(255,255,255,.16);
  --btn-on-hover:rgba(255,255,255,.26);
  --outline:rgba(255,255,255,.55);
  --close-hover:rgba(248,113,113,.16);
  --close-fg:#FCA5A5;
}
/* 浅色：刻意不用纯白 + 近黑，底色与文字都留一档，避免刺眼 */
.ytbpip-root.is-light{
  --fg-0:#3F4858;
  --fg-1:#4E5766;
  --fg-2:#757E8F;
  --surface:#FAFAFB;
  --bar:#F0F1F4;
  --line:rgba(16,24,40,.07);
  --sep:rgba(16,24,40,.11);
  --text:#3F4858;
  --shadow:none;
  --toast:rgba(16,24,40,.78);
  --btn-hover:rgba(16,24,40,.05);
  --btn-on:rgba(16,24,40,.08);
  --btn-on-hover:rgba(16,24,40,.13);
  --outline:rgba(16,24,40,.35);
  --close-hover:rgba(220,38,38,.10);
  --close-fg:#A8342A;
}
/* 页面底色不在这里写：--surface 定义在 .ytbpip-root 上，html 取不到，
   由宿主（pip-host / float-window）按主题直接写成内联样式 */
html, body {
  margin:0; height:100%; overflow:hidden;
}
*, *::before, *::after { box-sizing: border-box; }

.ytbpip-root{
  position:relative;
  display:flex;
  flex-direction:column;
  height:100%;
  min-height:0;
  color:var(--fg-0);
  font-family: system-ui, -apple-system, "Noto Sans SC", "Noto Sans", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size:12px;
  line-height:1.3;
  -webkit-font-smoothing:antialiased;
  background:var(--surface);
  border:0;
  border-radius:0;
  overflow:hidden;
  isolation:isolate;
  user-select:none;
  -webkit-user-select:none;
}

.ytbpip-body{
  flex:1 1 auto;
  min-height:0;
  display:flex; flex-direction:column; justify-content:center;
  padding:4px 12px;
  overflow:hidden;
}

/* 歌词式五行：上下各两句 + 当前句。字号由 ui-template 的 fitText() 实测后调整 */
.ytbpip-lines{
  flex:0 1 auto;
  min-height:0;
  display:flex; flex-direction:column; align-items:stretch; justify-content:center;
  overflow:hidden;
  font-size:var(--fs);
}
.ytbpip-lines > *{ flex:0 0 auto; }

/* 上下文行：只比正常小一点点 + 压暗 + 单行截断 */
.ytbpip-ghost{
  font-size:.88em;
  line-height:1.3;
  color:var(--fg-2);
  text-align:center;
  white-space:nowrap;
  overflow:hidden;
  text-overflow:ellipsis;
}
.ytbpip-ghost:empty{ display:none; }

.ytbpip-text{
  /* 1em = .ytbpip-lines 的字号，所有行共用同一个缩放比例 */
  font-size:1em;
  font-weight:600;
  line-height:1.28;
  letter-spacing:.01em;
  text-align:center;
  text-wrap:balance;
  color:var(--text);
  text-shadow:var(--shadow);
  display:-webkit-box;
  /* 具体几行由 ui-template 的 fitText() 实测后写成内联样式，这里只是首帧前的兜底 */
  -webkit-line-clamp:3;
  -webkit-box-orient:vertical;
  overflow:hidden;
  overflow-wrap:anywhere;
  word-break:break-word;
}
.ytbpip-text:not(.is-placeholder){ cursor:pointer; }

.ytbpip-toast{
  position:absolute;
  left:50%; top:50%;
  z-index:2;
  transform:translate(-50%,-50%) scale(.96);
  padding:3px 9px;
  border-radius:6px;
  background:var(--toast);
  color:#fff;
  font-size:11px;
  font-weight:600;
  letter-spacing:.02em;
  white-space:nowrap;
  opacity:0;
  pointer-events:none;
  transition:opacity .16s ease, transform .16s ease;
}
.ytbpip-toast.is-on{
  opacity:1;
  transform:translate(-50%,-50%) scale(1);
}

.ytbpip-text.is-placeholder{
  font-size:11px; font-weight:500; color:var(--fg-2); text-shadow:none;
}
.ytbpip-text.is-fading{ animation:ytbpip-fade .12s ease-out; }
@keyframes ytbpip-fade{
  from{ opacity:.55; }
  to{ opacity:1; }
}

.ytbpip-bar{
  flex:0 0 auto;
  height:30px;
  display:flex; align-items:center; gap:6px;
  padding:0 8px;
  background:var(--bar);
  border-top:1px solid var(--line);
  cursor:grab;
}
.ytbpip-bar:active{ cursor:grabbing; }

.ytbpip-btns{
  margin:0 auto; /* 去掉左侧状态文本后，按钮组居中 */
  display:flex; align-items:center; gap:2px;
  flex:0 0 auto;
}

.ytbpip-btn{
  appearance:none; -webkit-appearance:none;
  border:0; background:transparent; margin:0;
  height:22px; min-width:22px; padding:0 5px;
  display:inline-flex; align-items:center; justify-content:center;
  border-radius:6px;
  color:var(--fg-1);
  font:inherit; font-size:11px; font-weight:600; line-height:1;
  font-variant-numeric:tabular-nums;
  cursor:pointer;
  transition:background .12s ease, color .12s ease, transform .1s ease;
  -webkit-tap-highlight-color:transparent;
}
.ytbpip-btn:hover{ background:var(--btn-hover); color:var(--fg-0); }
.ytbpip-btn:active{ transform:scale(.93); }
.ytbpip-btn:focus-visible{ outline:1px solid var(--outline); outline-offset:1px; }
.ytbpip-btn svg{ width:12px; height:12px; display:block; fill:currentColor; }

/* 选中态用中性的「更亮的底 + 主文字色」，不引入彩色 */
.ytbpip-btn.is-on{ color:var(--fg-0); background:var(--btn-on); }
.ytbpip-btn.is-on:hover{ background:var(--btn-on-hover); color:var(--fg-0); }

.ytbpip-btn.is-speed{ min-width:40px; color:var(--fg-0); letter-spacing:.02em; }
.ytbpip-btn.is-vol{ min-width:40px; color:var(--fg-0); letter-spacing:.02em; }
.ytbpip-btn.is-muted{ color:var(--fg-2); }
.ytbpip-btn.is-close:hover{ background:var(--close-hover); color:var(--close-fg); }

.ytbpip-sep{
  flex:0 0 auto;
  width:1px; height:14px;
  background:var(--sep);
  margin:0 2px;
}

/* 窄窗口依次收起：音量 → 字号，保证倍速和播放控制始终可见 */
@media (max-width: 348px){
  .ytbpip-btn.is-vol-group, .ytbpip-sep.is-vol-group{ display:none; }
}
@media (max-width: 300px){ .ytbpip-btn.is-font{ display:none; } .ytbpip-sep{ display:none; } }
`;

  /**
   * 把样式注入到 Document 或 ShadowRoot。
   */
  G.injectStyles = function injectStyles(target) {
    const doc = target.ownerDocument || target;
    const style = doc.createElement('style');
    style.setAttribute('data-ytbpip', '1');
    style.textContent = G.CSS;
    if (target.head) target.head.appendChild(style);
    else target.appendChild(style);
    return style;
  };
})();
