# 文件中转站

一个面向普通用户的临时文件发送与接收页面。发送方登录后选择文件并获得 8 位取件码和分享链接；接收方无需注册，打开链接即可让浏览器在 Direct、STUN、TURN、SFU 和 R2 中选择可用线路，完成后校验文件大小与 SHA-256。

## 当前流程

1. 发送方使用 Passkey 登录，选择文件以及智能或极速模式。
2. 页面先在 Pickup Durable Object 中预留 8 位取件码并立即显示，文件哈希与五条线路在后台并行准备。
3. 发布 `file-transfer-v3` 协议；分享 URL 只包含 `?code=` 取件码，接收方也可以直接输入 8 位取件码。
4. 接收方打开带 `?code=` 的分享链接。未登录用户会用一个只绑定该取件码、随取件码过期的访客令牌读取 Offer、提交 Answer 和确认胜者，不能创建取件码或获取 R2 上传凭据。
5. Pickup 的 Offer、Answer、selection、winner 和取消状态使用最长 20 秒的服务端长轮询；正常等待不会再每 850 ms 请求一次。
6. 智能模式根据连接时间和实测吞吐估算完成时间，逐条回退；极速模式让所有可用实时线路发送相同的有序分块，同时启动 R2 上传，接收端按 sequence 去重。
7. 只有大小和明文 SHA-256 都通过校验的结果会成为胜者。页面显示每条线路状态及一个不包含文件名、取件码或信令内容的故障编号。

旧 `file-transfer-v2` R2 取件码仍可接收。

## 大文件、恢复与取消

- 小文件在主线程以 4 MiB 读取块增量计算 SHA-256；8 MiB 及以上文件交给独立 Web Worker，避免哈希阻塞交互。
- 实时传输使用 48 KiB 有序分块、DataChannel 背压和分块确认。
- 小于 8 MiB 的 R2 文件使用单次 PUT；8 MiB 及以上文件使用 S3 兼容 multipart 上传。
- multipart 的 `uploadId`、已完成 part/ETag、对象 key 与文件指纹会在当前设备保留 24 小时。重试时 API 只会为当前用户拥有的原对象重新签发短期凭据，已完成分块不会重复上传。
- 支持 File System Access API 的 Chrome / Edge 会直接流式写入用户选择的位置；其他浏览器使用内存下载，单文件限制为 128 MiB。
- 哈希 Worker、信令、ICE、DataChannel、SFU、R2、长轮询和接收写盘都支持取消。页面卸载或新操作会终止旧会话并忽略迟到结果。

## 代码结构

- `worker/`：从原 `file-transfer-api` 仓库迁入的 Cloudflare Worker 源码，包含
  D1 migration、Durable Object 和测试；根目录 `wrangler.jsonc` 是部署配置。
- `src/styles.css`：Tailwind CSS 4 设计令牌、与 webapps 一致的浅色视觉系统、响应式规则和
  `prefers-reduced-motion` 降级策略。
- `src/component/ProductBrand.tsx`：首页、登录页与账户页复用的品牌标识。
- `src/features/transfer/FileTransferPage.tsx`：只负责上传/下载方向、登录状态和
  sender / receiver controller 的页面编排。
- `src/features/transfer/components/`：Hero、上传面板、下载面板、取件码单据、线路遥测、
  进度与状态反馈等纯 UI 组件。
- `src/features/transfer/protocol/fileProtocol.ts`：v2/v3 协议和严格运行时校验。
- `src/features/transfer/workers/hash.worker.ts`：大文件后台增量 SHA-256。
- `src/features/transfer/transports/webrtc`：Direct / STUN / TURN 信令、candidate 隔离和 DataChannel 生命周期。
- `src/features/transfer/transports/sfu`：Cloudflare Calls 双向 DataChannel。
- `src/features/transfer/services/multipathSender.ts`：发送端五路准备、测速、回退与并发发送。
- `src/features/transfer/services/multipathReceiver.ts`：接收端应答、选择监听、去重和胜者确认。
- `src/features/transfer/services/multipathCoordinator.ts`：共享超时、取消、路由排名和协调约束。
- `src/features/transfer/services/channelTransfer.ts`：实时分块、背压、确认和接收完整性。
- `src/features/transfer/services/r2Multipart.ts`：R2 multipart 上传与本地断点恢复。
- `src/features/transfer/services/r2Transfer.ts`：R2 测速、延迟正文上传和流式下载。
- `src/features/transfer/services/transferDiagnostics.ts`：隐私安全的能力、线路状态和稳定错误码。
- `src/features/transfer/hooks/useFileSender.ts` / `useFileReceiver.ts`：页面状态与操作生命周期。

## 本地开发

要求 Node.js 24+ 和 pnpm 11.15.1。前端与 API 共用依赖、锁文件及根目录
`wrangler.jsonc`；生产以一个 `file-transfer` Worker 发布。

首次初始化：

```bash
pnpm install --frozen-lockfile
cp .dev.vars.example .dev.vars
pnpm db:migrations:apply:local
```

分别在两个终端运行：

```bash
pnpm dev:worker
```

```bash
pnpm dev
```

`pnpm dev` 保持 Vite 热更新体验，默认地址为 `http://localhost:5173`。
页面默认请求同源 API，Vite 将 API 路径代理到 `http://localhost:8787` 的本地 Worker。
`pnpm dev:worker` 先构建一次前端资源，再启动 Wrangler；后端改动由 Wrangler 重新加载。

`.env.local` 中的 `VITE_API_BASE_URL` 只用于需要访问其他 API 地址的场景；通常不必设置。
可参考 `.env.example`。浏览器不持有长期服务密钥，开发密钥放在被 Git 忽略的 `.dev.vars`。

## 验证

```bash
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:e2e
pnpm build
pnpm check:worker
pnpm test:worker
WORKERS_CI=1 pnpm build
pnpm worker:types:check
pnpm worker:dry-run
pnpm check:all
```

`pnpm check` 串行执行 lint 和完整前端检查；`pnpm check:all` 在此基础上继续验证 Worker
构建、类型、测试与 dry-run。单元测试覆盖 Worker 哈希、multipart 恢复、长轮询客户端、
路由超时、极速去重、完整性和取消。Playwright 除常规 API / R2 mock 场景外，还会在两个
真实 Chromium 页面之间使用原生 `RTCPeerConnection` 完成一次传输，用来捕获真实浏览器
对象序列化和 DataChannel 编排问题。

ESLint 覆盖前端、Worker、测试
与构建脚本，并检查 React Hook 的调用规则和依赖；生成的绑定类型不参与 lint。
Worker 专项脚本执行类型检查、集成测试、绑定类型同步检查和本地打包 dry-run。
测试使用本地运行时及 mock，不需要线上凭据。

Playwright 通过共享 fixture 拒绝未 mock 的外部 HTTP 请求并禁用 Service Worker，
防止测试误访问线上 API；原生 WebRTC 场景仅使用本机直连，不访问外部 STUN / TURN。

`tests/e2e/accessibility.spec.ts` 使用 axe 检查访客首页、登录态首页、Passkey 登录页和
账户页，并在 390 px、768 px 与桌面布局上验证自动可检测的无障碍规则。视觉系统的所有
动效都在用户启用“减少动态效果”时自动关闭。
布局场景还覆盖 320 px 窄屏与键盘导航，并将 320 / 390 / 768 / 1440 px 上传、下载界面的
截图附在本地 Playwright 报告中，供视觉复核。

GitHub Actions 通过跟随 `github-ci/main` 的通用 reusable CI，自动发现并运行标准 `typecheck`、
`test`、`build` 脚本和高危依赖审计；存在 `lint` 脚本时也会自动执行。
浏览器、axe、原生 RTC 和 Worker 专项验证保留为上述本地脚本，不由通用 auto 模式
自动运行；涉及相关功能或依赖变动时，应单独执行并记录结果。

生产构建会生成 Vite manifest 并执行 bundle budget：初始静态 JS 不超过 115 KiB gzip、最大单块不超过 95 KiB gzip、全部 JS 不超过 175 KiB gzip。首页、登录页、账户页、R2 签名器和哈希 Worker 分块加载；阈值可用对应的 `BUNDLE_MAX_*_KIB` 环境变量临时覆盖。

## GitHub 自动部署到 Cloudflare

网页、静态资源和 API 由同一个 Cloudflare Worker `file-transfer` 提供，统一使用
`https://file.thanejoss.com`。`worker/` 是同一项目中的服务端源码目录，不是第二个部署项目。

| 配置 | 值 |
| --- | --- |
| GitHub 仓库 / 生产分支 | `ThaneJoss/file-transfer` / `main` |
| Worker / Wrangler 配置 | `file-transfer` / `wrangler.jsonc` |
| Build command | `pnpm run build` |
| Deploy command | `npx wrangler deploy` |
| 非生产分支版本上传 | `npx wrangler versions upload` |
| Root Directory | 仓库根目录 |

推送 `main` 自动构建并发布整个应用；其他分支自动构建并上传候选版本，不切换生产流量。
`pnpm build` 同时构建前端并检查 Worker，Cloudflare 注入的 `WORKERS_CI=1`
不会改变构建目标。仓库只维护一份 Wrangler 配置，以及生产发布和分支版本上传触发器。

当前 Worker 绑定 Durable Objects，legacy `wrangler versions upload` 不生成在线预览
链接（实测版本 `has_preview: false`）。可用 `pnpm dev:worker` 启动本地 Wrangler
验证完整应用；分支上传成功仅表示候选版本已保存。

手动发布或验证：

```bash
pnpm build
pnpm worker:dry-run
pnpm run deploy
# 上传候选版本，不替换生产版本，也不生成在线预览链接：
pnpm preview:worker
```

`pnpm run deploy` 依次构建应用、执行待处理的 D1 migration、发布 Worker；
旧命令 `pnpm deploy:worker` 保留为它的兼容入口。
Cloudflare 的默认 `npx wrangler deploy` 不自动执行 D1 migration，含新 migration
的提交仍需在生产发布前运行 `pnpm db:migrations:apply:remote`。

原 `file-transfer-api` Worker 通过原地改名保留内部身份、Runtime Secrets 和
Durable Object namespace，D1 与 R2 沿用原资源。网页与 API 仅使用
`https://file.thanejoss.com`，旧 API 域名已撤除。
管理页位于 `https://file.thanejoss.com/admin/`，沿用原 Cloudflare Access 管理员策略；
该策略覆盖 `/admin` 和 `/admin/*`，其他主机的管理路径返回 404。

Passkey 的 RP ID 仍为 `file.thanejoss.com`，已有 Passkey 可继续使用。
浏览器会话 Cookie 从旧 API 主机改为站点主机后，现有用户可能需要重新登录一次。
完整 Passkey 登录与传输使用生产域名或本地开发环境；生产 Origin 允许列表不为
其他测试域名放宽。

`ThaneJoss/file-transfer` 是唯一维护仓库；旧 API GitHub 仓库仅保留历史。
资源、平台设置和回滚说明见 [迁移记录](docs/deployment-migration.md)。

## 部署注意事项

- 前后端随同一个 Worker 版本发布；有数据库结构变化时，先应用兼容的 D1 migration。
- R2 CORS 必须允许站点 Origin、`GET` / `PUT` / `POST` / `DELETE`、签名请求头，并暴露 `ETag`、`Content-Length` 和 `Content-Type`；仓库中的 `worker/config/r2-cors.json` 是对应配置。
- 静态页面安全响应头由 `public/_headers` 设置，API 响应头由 Worker 设置。若更换 R2 域名或增加外部 API，需要同步检查 CSP 的 `connect-src`。Cloudflare zone 的 HSTS 设置可能覆盖应用头。
- 哈希资源 `/assets/*` 使用长期不可变缓存，页面路由回退到 `index.html`；API、健康检查和管理员路径交给 Worker，未知 API 返回错误而非 SPA HTML。
- `file.thanejoss.com` 的 Cloudflare Configuration Rule 关闭自动统计脚本注入，保持现有 CSP；模块脚本保留 `data-cfasync="false"`。
- 临时对象和未完成 multipart 的最终清理由对象存储生命周期规则负责；前端恢复记录只保留 24 小时。
