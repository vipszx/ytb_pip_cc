/**
 * 跨 world 通信协议（唯一真源）。
 *
 * 同一份文件会被注入两次：一次在 isolated world，一次在 MAIN world。
 * 两个 world 共享同一个 DOM（含 window 的事件总线），因此用 CustomEvent 通信；
 * detail 统一为 JSON 字符串，避免跨 realm 传递对象带来的兼容问题。
 */
(() => {
  const G = (window.__YTBPIP__ = window.__YTBPIP__ || {});
  if (G.protocol) return;

  const EV_TO_MAIN = 'YTBPIP_TO_MAIN';
  const EV_TO_ISOLATED = 'YTBPIP_TO_ISOLATED';

  G.protocol = {
    EV_TO_MAIN,
    EV_TO_ISOLATED,

    /** 消息类型 */
    T: {
      OPEN: 'open', // isolated -> MAIN 请求打开 PiP 窗口
      CLOSE: 'close', // isolated -> MAIN 请求关闭 PiP 窗口
      RENDER: 'render', // isolated -> MAIN 推送渲染状态
      OPENED: 'opened', // MAIN -> isolated 窗口已就绪
      CLOSED: 'closed', // MAIN -> isolated 窗口已关闭
      OPEN_FAILED: 'openFailed', // MAIN -> isolated 打开失败，需降级
      CMD: 'cmd', // MAIN -> isolated 用户指令
      TRACK_REQ: 'trackReq', // isolated -> MAIN 请求完整字幕轨道信息
      TRACK_RES: 'trackRes' // MAIN -> isolated 轨道信息
    },

    /** 用户指令 */
    CMD: {
      PLAY_PAUSE: 'playPause',
      SPEED_STEP: 'speedStep', // value: delta
      SPEED_CYCLE: 'speedCycle', // 点击倍速数值循环常用档位
      FONT_STEP: 'fontStep', // value: delta
      TOGGLE_CC: 'toggleCc',
      CLOSE_WINDOW: 'closeWindow'
    },

    post(eventName, type, payload) {
      try {
        document.dispatchEvent(
          new CustomEvent(eventName, {
            detail: JSON.stringify({ t: type, p: payload === undefined ? null : payload })
          })
        );
      } catch (e) {
        /* 静默失败：扩展被重载后可能不可用 */
      }
    },

    on(eventName, handler) {
      document.addEventListener(eventName, (event) => {
        let msg;
        try {
          msg = JSON.parse(event.detail);
        } catch (e) {
          return;
        }
        if (!msg || typeof msg.t !== 'string') return;
        try {
          handler(msg.t, msg.p);
        } catch (e) {
          console.warn('[ytbpip] handler error', e);
        }
      });
    }
  };
})();
