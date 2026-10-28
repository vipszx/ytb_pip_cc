/**
 * Document PiP 窗口宿主：在「当前 world」里直接创建并托管小窗。
 * isolated world 与 MAIN world 都会加载本文件，谁先拿到用户手势谁就先开窗口，
 * 互不依赖，避免单点失败导致点击无反应。
 */
(() => {
  const G = (window.__YTBPIP__ = window.__YTBPIP__ || {});
  if (G.openPipWindow) return;

  const CMD_CLOSE = 'closeWindow';

  G.pipSupported = function pipSupported() {
    try {
      const dpp = window.documentPictureInPicture;
      return !!dpp && typeof dpp.requestWindow === 'function';
    } catch (e) {
      return false;
    }
  };

  /**
   * @param {{
   *   width?:number, height?:number, initialState?:object,
   *   onCommand?:(cmd:string, value?:number)=>void,
   *   onClosed?:()=>void
   * }} opts
   * @returns {Promise<{win:Window, ui:object, update:Function, close:Function, isOpen:Function}>}
   */
  G.openPipWindow = async function openPipWindow(opts) {
    const o = opts || {};
    const onCommand = o.onCommand || function () {};
    const onClosed = o.onClosed || function () {};

    if (!G.pipSupported()) throw new Error('unsupported: documentPictureInPicture');

    const dpp = window.documentPictureInPicture;
    let win = dpp.window || null;
    if (!win) {
      // 必须在本函数的同步段内调用，以保住用户手势激活
      win = await dpp.requestWindow({
        width: o.width || 420,
        height: o.height || 132,
        disallowReturnToOpener: true
      });
    }

    const doc = win.document;
    // 标题栏由浏览器绘制、无法移除，尽量用短标题减少占用
    try {
      doc.title = '字幕';
    } catch (e) {
      /* 忽略 */
    }
    /** PiP 窗口的 html/body 拿不到 .ytbpip-root 上的变量，只能按主题写成内联样式 */
    function paintPage(isLight) {
      const bg = (G.SURFACE && (isLight ? G.SURFACE.light : G.SURFACE.dark)) || '#2A2A2E';
      doc.documentElement.style.cssText =
        'height:100%;margin:0;overflow:hidden;background:' + bg;
      doc.body.style.cssText = 'margin:0;height:100%;overflow:hidden;background:' + bg;
      // color-scheme 会带动浏览器原生 UI（滚动条、窗口边框等）一起切到浅色
      try {
        doc.documentElement.style.colorScheme = isLight ? 'light' : 'dark';
      } catch (e) {
        /* 老版本不支持，忽略 */
      }
    }

    doc.body.textContent = '';
    G.injectStyles(doc);
    paintPage((o.initialState && o.initialState.theme) === 'light');

    const ui = G.createUI(doc, {
      onThemeChange: paintPage,
      onCommand(cmd, value) {
        if (cmd === CMD_CLOSE) {
          handle.close();
          return;
        }
        onCommand(cmd, value);
      }
    });
    doc.body.appendChild(ui.root);
    ui.bar.style.cursor = 'default';

    if (o.initialState) ui.update(o.initialState);

    let closed = false;

    function cleanup() {
      if (closed) return false;
      closed = true;
      try {
        win.removeEventListener('pagehide', onPageHide);
      } catch (e) {
        /* 忽略 */
      }
      try {
        ui.destroy();
      } catch (e) {
        /* 忽略 */
      }
      return true;
    }

    function onPageHide() {
      if (cleanup()) onClosed();
    }

    win.addEventListener('pagehide', onPageHide);

    const handle = {
      win,
      ui,
      update(state) {
        if (!closed) ui.update(state);
      },
      close() {
        const target = win;
        const wasOpen = cleanup();
        try {
          if (target && !target.closed) target.close();
        } catch (e) {
          /* 忽略 */
        }
        if (wasOpen) onClosed();
      },
      isOpen() {
        return !closed && !win.closed;
      }
    };

    try {
      win.focus();
    } catch (e) {
      /* 忽略 */
    }

    return handle;
  };
})();
