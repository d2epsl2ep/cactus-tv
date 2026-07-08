# Cactus TV v0.6.0 检查记录

## 播放器

- HLS.js、Safari 原生 HLS 与 dash.js 三条播放链路。
- 首帧确认后才判定启动成功，稳定播放后才累计片源成功率。
- 卡死检测会先恢复当前引擎，再按 48 秒总预算和最多 7 次尝试切换线路/数据源。
- 支持无扩展名 HLS/DASH 探测、下一集清单预热、弱网缓冲策略和隐藏诊断面板。
- 支持外挂字幕、本地 SRT/VTT、常见中文编码、HLS/DASH 内嵌字幕与多音轨。
- 切集、退出和换源时统一销毁引擎、媒体请求、字幕轨道与 Blob URL。

## 受控代理

- 只代理已启用数据源白名单中的 HTTPS 媒体域名。
- HLS 清单重写分片和密钥地址；DASH 清单修正上游 BaseURL，分片继续走受控代理。
- 无后缀清单通过 MIME 与前 64 KB 内容识别。
- 播放列表短缓存，媒体分片保留 Range 与 5 分钟浏览器/边缘缓存策略。
- 字幕代理限制 5 MB、10 秒超时，并逐跳校验重定向目标。

## 兼容性与交互

- 手机横屏保留关闭和工具入口，小屏保留上一集/下一集。
- 电视遥控器支持方向键焦点移动、返回键、媒体键和快捷键。
- 现代浏览器使用 ES Module，旧浏览器使用预生成的 `app-legacy.js`。
- `ADMIN_TOKEN` 的前端、后端和健康检查最低长度统一为 8 个字符。

## 本地验证

```bash
npm ci
npm run check
```

`npm run check` 会编译 Cloudflare Functions、生成旧浏览器兼容包、检查全部 JavaScript 语法并执行项目预检。

部署后可使用真实 D1、环境变量和数据源执行：

```bash
BASE_URL=https://你的项目.pages.dev \
ADMIN_TOKEN=你的管理密钥 \
npm run smoke
```
