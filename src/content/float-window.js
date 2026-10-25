/**
 * 降级形态：页面内浮动小窗（Shadow DOM 隔离 YouTube 样式），功能与 PiP 窗口一致，额外支持拖拽。
 */
(() => {
  const G = (window.__YTBPIP__ = window.__YTBPIP__ || {});
  if (G.createFloatWindow) return;

  const WIDTH = 420;
  const HEIGHT = 132;

  /**
   * @param {{onCommand:(cmd:string, value?:number)=>void, onClose:()=>void}} options
   */
  G.createFloatWindow = function createFloatWindow(options) {
    const onCommand = (options && options.onCommand) || function () {};
    const onClose = (options && options.onClose) || function () {};

    const existing = document.getElementById(G.selectors.FLOAT_HOST_ID);
    if (existing) existing.remove();

    const host = document.createElement('div');
    host.id = G.selectors.FLOAT_HOST_ID;
    host.style.cssText = [
      'position:fixed',
      'right:24px',
      'bottom:96px',
      'width:' + WIDTH + 'px',
      'height:' + HEIGHT + 'px',
      'z-index:2147483000',
      'display:none',
      'border-radius:10px',
      'overflow:hidden',
      'box-shadow:0 18px 48px rgba(0,0,0,.55)',
      'background:#2A2A2E'
    ].join(';');

    const shadow = host.attachShadow({ mode: 'open' });
    G.injectStyles(shadow);

    const ui = G.createUI(document, {
      onCommand(cmd, value) {
        if (cmd === 'closeWindow') {
          close();
          return;
        }
        onCommand(cmd, value);
      }
    });
    shadow.appendChild(ui.root);
    (document.body || document.documentElement).appendChild(host);

    let dragging = false;
    let offsetX = 0;
    let offsetY = 0;

    ui.bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const rect = host.getBoundingClientRect();
      dragging = true;
      offsetX = e.clientX - rect.left;
      offsetY = e.clientY - rect.top;
      host.style.right = 'auto';
      host.style.bottom = 'auto';
      host.style.left = rect.left + 'px';
      host.style.top = rect.top + 'px';
      try {
        ui.bar.setPointerCapture(e.pointerId);
      } catch (err) {
        /* 忽略 */
      }
    });

    ui.bar.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const left = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - offsetX));
      const top = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - offsetY));
      host.style.left = left + 'px';
      host.style.top = top + 'px';
    });

    const stopDrag = () => {
      dragging = false;
    };
    ui.bar.addEventListener('pointerup', stopDrag);
    ui.bar.addEventListener('pointercancel', stopDrag);

    function open() {
      host.style.display = 'block';
    }

    function close() {
      host.style.display = 'none';
      onClose();
    }

    return {
      root: host,
      ui,
      open,
      close,
      isVisible() {
        return host.style.display !== 'none';
      },
      update(state) {
        ui.update(state);
      },
      destroy() {
        host.remove();
      }
    };
  };
})();
