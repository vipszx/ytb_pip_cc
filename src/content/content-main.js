/**
 * MAIN world 适配器：当 isolated world 无法直接创建 Document PiP 窗口时，
 * 由页面上下文代为打开，并把状态/指令在两个 world 之间转发。
 */
(() => {
  const G = window.__YTBPIP__;
  if (!G || !G.protocol || !G.openPipWindow) return;
  if (G.__mainReady) return;
  G.__mainReady = true;

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
      default:
        break;
    }
  });
})();
