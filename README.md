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

要求 Node.js 24+ 和 pnpm 11.6。

```bash
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm dev
```

`VITE_API_BASE_URL` 可选；不设置时使用 `https://api.file.thanejoss.com`。API 负责 Passkey 会话、访客取件令牌、短期 TURN / R2 凭据、SFU 代理、取件协调和脱敏诊断；浏览器不会持有长期服务密钥。

## 验证

```bash
pnpm typecheck
pnpm test:unit
pnpm test:e2e
pnpm build
```

`pnpm check` 串行执行全部检查。单元测试覆盖 Worker 哈希、multipart 恢复、长轮询客户端、路由超时、极速去重、完整性和取消。Playwright 除常规 API / R2 mock 场景外，还会在两个真实 Chromium 页面之间使用原生 `RTCPeerConnection` 完成一次传输，用来捕获真实浏览器对象序列化和 DataChannel 编排问题。

生产构建会生成 Vite manifest 并执行 bundle budget：初始静态 JS 不超过 115 KiB gzip、最大单块不超过 95 KiB gzip、全部 JS 不超过 175 KiB gzip。首页、登录页、账户页、R2 签名器和哈希 Worker 分块加载；阈值可用对应的 `BUNDLE_MAX_*_KIB` 环境变量临时覆盖。

## 部署注意事项

- 先部署 API 与 D1 migration `0006_guest_claim_rate_limit.sql`，再部署前端。
- R2 CORS 必须允许站点 Origin、`GET` / `PUT` / `POST` / `DELETE`、签名请求头，并暴露 `ETag`、`Content-Length` 和 `Content-Type`；仓库中的 `config/r2-cors.json` 是对应配置。
- 前端为所有页面设置 CSP、HSTS、COOP、CORP、Permissions Policy、Referrer Policy、`nosniff` 和防嵌入响应头；若更换 API 或 R2 域名，需要同步更新 `vercel.json` 的 `connect-src`。
- `/assets/*` 使用内容哈希和长期不可变缓存，其他路径回退到 `index.html`。模块脚本保留 `data-cfasync="false"`，避免 Cloudflare Rocket Loader 改写启动脚本。
- 临时对象和未完成 multipart 的最终清理由对象存储生命周期规则负责；前端恢复记录只保留 24 小时。
