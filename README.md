# YouTube 字幕画中画

一个纯前端的 Chrome 扩展（MV3）。在 YouTube 观看页点击一个入口图标，弹出一个**极小的系统级置顶窗口**，里面**只有字幕、没有画面**；窗口内可以直接调倍速、调字号、播放/暂停、开关字幕。

## 功能

| 能力 | 说明 |
| --- | --- |
| 字幕画中画 | 使用 Chrome 的 Document Picture-in-Picture API 弹出独立小窗（默认 420×132），只显示字幕，最多两行，自动换行，切换回原标签页也不会被关闭 |
| 置顶最前 | PiP 窗口天然位于所有普通窗口之上，可拖到屏幕任意角落，一边看别的软件一边看字幕 |
| 倍速控制 | 小窗内 `−` / `+` 按 0.25 步进，点击倍速数值循环 0.5→0.75→1→1.25→1.5→1.75→2，直接作用于页面 `<video>`，与画面完全同步 |
| 字号控制 | `A−` / `A+` 按 2px 步进（12–40px），跨视频、跨会话记忆 |
| 字幕来源 | 优先下载视频的**完整字幕轨道**（timedtext/json3），按「间隔 + 句末标点」合并成整句，时间轴精确、按播放进度同步；轨道拿不到时自动回退到抓取播放器渲染的字幕（整句上屏）。**支持自动翻译/任意语言**，并保留上一句作弱化提示 |
| 点击复制 | 点击字幕文字即可复制当前句，屏幕中央提示「已复制」 |
| 播放控制 | 小窗内播放/暂停；`CC` 按钮可直接开关 YouTube 字幕 |
| 自动开字幕 | 打开小窗时若字幕未开启，自动点击 YouTube 的 CC 按钮（可在 popup 中关闭） |
| 降级方案 | 浏览器不支持 Document PiP、或用户激活丢失时，自动改为页面内浮动小窗，界面与功能完全一致，额外支持拖拽 |

## 安装

1. 打开 `chrome://extensions`
2. 右上角开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择本目录 `ytb_pip_cc`
4. 需要 **Chrome 116 及以上**（Document Picture-in-Picture API）

> 扩展没有声明图标，列表中会显示默认拼图图标，不影响功能。

## 使用

1. 打开任意 YouTube 视频
2. 在播放器**右下角控制栏**找到字幕小窗图标（在设置齿轮左侧），点击即弹出置顶字幕小窗
3. 再次点击同一图标，或点小窗里的 `✕`，即可关闭
4. 点击浏览器工具栏的扩展图标可以调整默认字号、默认倍速、是否自动开字幕，也可以从这里尝试打开/关闭小窗

### 小窗工具条

```
[ 1.5× · 字幕开 ]        [▶] [−] [1.5×] [+] │ [A−] [A+] [CC] [✕]
```

- 左侧文本：当前倍速与字幕开关状态
- `▶/⏸` 播放暂停 · `−/+` 倍速微调 · `1.5×` 点击切换常用倍速
- `A−/A+` 字号 · `CC` 字幕开关 · `✕` 关闭

## 已知限制

- **首次打开必须由你亲自点击页面上的按钮**：Document PiP 要求「用户手势」，从 popup 转发消息有时会被浏览器判定为缺少激活，此时会自动降级为页面内浮动小窗。
- **整页刷新/跳转到别的网站会关闭小窗**：PiP 窗口依附于打开它的那个页面。YouTube 内部的视频切换（SPA）不会关闭小窗。
- 字幕优先来自视频的完整字幕轨道；轨道拿不到时回退到 YouTube 渲染的字幕层，因此**视频本身必须有字幕轨道**，纯音乐/无字幕视频不会有内容。视频打开期间在 YouTube 菜单里切换字幕语言，需要重开一次小窗才会同步。
- 若你改用 YouTube 原生菜单切换倍速，扩展会自动采纳你的选择，不会强行拉回。
- 广告播放期间 YouTube 会强制 1×，扩展不干预；广告结束后会恢复你设定的倍速。

## 常见问题

**点了图标没反应？**
先确认当前是 `/watch` 视频页，并刷新一次页面（安装/更新扩展后必须刷新已打开的标签页）。

**小窗里一直显示「字幕未开启 · 点 CC 开启」？**
点小窗里的 `CC` 按钮，或在 YouTube 播放器上手动开字幕。部分视频没有字幕轨道。

**小窗太小/想更小？**
拖动 PiP 窗口边缘即可缩放，布局会按比例自适应；也可以用 `A−` 缩小字号让两行更紧凑。

## 目录结构

```
manifest.json                 MV3 清单（两条内容脚本：isolated + MAIN world）
src/shared/protocol.js        跨 world 事件协议（唯一契约）
src/shared/selectors.js       YouTube DOM 选择器集中管理
src/shared/settings.js        设置仓库（chrome.storage.local）
src/content/content-isolated.js  采集层：入口按钮、字幕、倍速接管、设置、降级判定
src/content/content-main.js      呈现层宿主：开 PiP 窗口、渲染 UI
src/content/caption-tracker.js   字幕抓取器（DOM 兜底）
src/content/track-source.js      轨道来源解析（内联 playerResponse / InnerTube）
src/content/track-cues.js        完整字幕轨道下载与解析（优先通道）
src/content/float-window.js      页面内浮动小窗（降级形态）
src/ui/ui-styles.js           样式常量（PiP 与浮动小窗共用）
src/ui/ui-template.js         渲染函数（PiP 与浮动小窗共用）
src/ui/pip-host.js            Document PiP 窗口宿主（两个 world 通用）
src/popup/                    工具栏配置面板
```

## 架构

```
                 ┌──────────────── 首选 ────────────────┐
YouTube DOM ──> isolated world（字幕/倍速/设置）──requestWindow──> PiP 窗口
                 │        │  document CustomEvent        │
                 │        ▼                              │
                 └──> MAIN world（备选开窗 / 指令转发）──→ 失败时
                          │
                          └──> 页面内浮动小窗（最终降级）
```

- **开窗双保险**：isolated world 优先直接调 `documentPictureInPicture.requestWindow()`；若该 world 取不到 API 或调用被拒，再通过 `document` 上的 CustomEvent 请求 MAIN world 代为开窗；两者都失败则 1.5 秒内降级为页面内浮动小窗。
- **单向数据流**：isolated world 负责全部数据采集与设置持久化，窗口宿主只负责渲染与回收指令。
- **MAIN world 必须在 `document_start` 注入**：用 `document_idle` 时它不会注入（实测如此），而字幕链路依赖它。

### 完整字幕轨道是怎么拿到的

YouTube 对 `captionTracks[].baseUrl` 加了门禁：直接请求（哪怕带 `&fmt=json3`、同源、带 cookie）一律返回 **HTTP 200 + 零字节 body**。播放器自己会额外带上 `pot`/`potc`（proof-of-origin token）等参数，我们无法自行签发。

做法是复用播放器的请求：MAIN world 在 `document_start` 时包装 `window.fetch` 与 `XMLHttpRequest.prototype.open`，记下播放器自己发出的 `/api/timedtext` 地址（含 `pot`），隔离世界再用这些地址取整轨。顺序见 `track-source.js` 的 `buildTimedTextUrls()`：

1. 整体复用拦截到的地址（同一视频、同一语言）
2. 把 `pot`/`potc`/`c`/`cver`/`xorb`… 抄到 `baseUrl` 上
3. 裸 `baseUrl`（万一放开限制）

**因此字幕要先在页面上显示过一次**，`pot` 才会存在——这就是「自动开字幕」（`autoEnableCC`）的意义。整轨到手后不再有「一个字一个字蹦」的问题。拿不到时回退到 DOM 取词，此时用整句上屏（`caption-tracker.js` 的 `MODE = 'sentence'`）来抑制抖动。

## 排障

在 YouTube 页面按 `F12`，Console 里过滤 `ytbpip` 可以看到完整链路日志（`[ytbpip·iso]` / `[ytbpip·main]`）。另外可直接在 Console 执行：

```js
__ytbpipDiag
// { api: true, requests: 1, opened: true, lastError: "" }
```

- `api: false` 表示当前浏览器不提供 Document Picture-in-Picture（需要 Chrome 116+，且非受限环境）
- `lastError` 会给出 `requestWindow` 失败的具体原因（如 `NotAllowedError` 表示缺少用户手势）
