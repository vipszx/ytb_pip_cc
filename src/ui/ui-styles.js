/**
 * 样式常量：以字符串形式注入，PiP 窗口（独立 document）与页面内浮动小窗（Shadow DOM）共用，
 * 保证两种形态视觉完全一致。
 */
(() => {
  const G = (window.__YTBPIP__ = window.__YTBPIP__ || {});
  if (G.CSS) return;

  G.CSS = `
:root{
  --fs: 20px;
  --fg-0:#FFFFFF; --fg-1:#C7C7D1; --fg-2:#8A8A99;
}
html, body {
  margin:0; height:100%; background:#2A2A2E; overflow:hidden;
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
  background:#2A2A2E;
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

.ytbpip-text{
  flex:0 1 auto;
  min-height:0;
  /* 字号默认用用户设定值，放不下时由 ui-template 的 fitText() 按实际文字缩到 3 行内 */
  font-size:var(--fs);
  font-weight:600;
  line-height:1.28;
  letter-spacing:.01em;
  text-align:center;
  text-wrap:balance;
  color:#fff;
  text-shadow:0 1px 2px rgba(0,0,0,.55);
  display:-webkit-box;
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
  background:rgba(0,0,0,.74);
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
  background:#232327;
  border-top:1px solid rgba(255,255,255,.06);
  cursor:grab;
}
.ytbpip-bar:active{ cursor:grabbing; }

.ytbpip-status{
  flex:0 1 auto;
  font-size:10px;
  color:var(--fg-2);
  letter-spacing:.02em;
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  font-variant-numeric:tabular-nums;
}
.ytbpip-status.is-off{ color:#FBBF24; }

.ytbpip-btns{
  margin-left:auto;
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
.ytbpip-btn:hover{ background:rgba(255,255,255,.08); color:#fff; }
.ytbpip-btn:active{ transform:scale(.93); }
.ytbpip-btn:focus-visible{ outline:1px solid rgba(255,255,255,.55); outline-offset:1px; }
.ytbpip-btn svg{ width:12px; height:12px; display:block; fill:currentColor; }

/* 选中态用中性的「更亮的底 + 白字」，不引入彩色 */
.ytbpip-btn.is-on{ color:#fff; background:rgba(255,255,255,.16); }
.ytbpip-btn.is-on:hover{ background:rgba(255,255,255,.26); color:#fff; }

.ytbpip-btn.is-speed{ min-width:40px; color:#fff; letter-spacing:.02em; }
.ytbpip-btn.is-close:hover{ background:rgba(248,113,113,.16); color:#FCA5A5; }

.ytbpip-sep{
  flex:0 0 auto;
  width:1px; height:14px;
  background:rgba(255,255,255,.09);
  margin:0 2px;
}

@media (max-width: 372px){ .ytbpip-status{ display:none; } }
@media (max-width: 306px){ .ytbpip-btn.is-font{ display:none; } .ytbpip-sep{ display:none; } }
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
