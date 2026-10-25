/**
 * YouTube DOM 选择器集中管理，便于改版时单点修复。
 */
(() => {
  const G = (window.__YTBPIP__ = window.__YTBPIP__ || {});
  if (G.selectors) return;

  G.selectors = {
    PLAYER: '#movie_player',
    VIDEO: '#movie_player video.html5-main-video',
    CAPTION_SEGMENT: '.ytp-caption-segment',
    CAPTION_WINDOW: '.caption-window',
    RIGHT_CONTROLS: '.ytp-right-controls',
    SUBTITLE_BUTTON: '.ytp-subtitles-button',
    SETTINGS_BUTTON: '.ytp-settings-button',

    /** 我们自己的入口按钮 */
    ENTRY_BUTTON: '.ytbpip-entry',
    FLOAT_HOST_ID: 'ytbpip-float-host'
  };
})();
