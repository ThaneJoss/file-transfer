# 文件中转站

浏览器文件传输工具，包含 Direct、STUN、TURN、SFU 和 R2 五种页面。Direct/STUN
公开使用；登录后可使用 8 位取件码自动交换信令。TURN/SFU/R2 通过 Better Auth
session 访问后端控制面。

## Scripts

```bash
pnpm dev
pnpm typecheck
pnpm test:unit
pnpm test:coverage
pnpm test:e2e
pnpm check
pnpm build
pnpm preview
```

`pnpm check` 会依次运行类型检查、Vitest 单元测试、Playwright 端到端测试和生产构建。默认测试全部使用假值和网络拦截，不需要真实 Cloudflare 凭证，也不会访问生产服务。

首次在本地运行端到端测试前安装浏览器：

```bash
pnpm exec playwright install chromium
```

如果只需要无头测试环境，可以使用：

```bash
pnpm exec playwright install chromium --only-shell
```

## Testing

- Vitest 覆盖 TURN/SFU API service、R2 SigV4 签名和通用协议边界。
- Playwright 覆盖 `/direct`、`/stun`、`/turn`、`/sfu`、`/r2` 五个页面的直接访问、刷新、前进后退、基础表单、成功路径、主要错误路径和资源清理。
- `tests/e2e/navigation-layout.spec.ts` 覆盖 1440x900、1280x800、390x844 三种视口，包含 20 个有向页面切换组合、快速切换、重复点击、前进后退和滚动条状态。

可选真实集成测试与默认测试分离：

```bash
pnpm test:e2e:live
```

live 测试默认跳过。不要把真实 session、临时凭证写入源码、fixture、`.env.example`、Playwright storage state、截图、trace、video 或报告。

## API 与鉴权

生产环境默认使用 `https://api.file.thanejoss.com`。本地连接 Worker 时设置：

```bash
VITE_API_BASE_URL=http://localhost:8787 pnpm dev
```

注册、登录、退出和 session 由 Better Auth 提供，前端只提供 Passkey 鉴权。注册时前端先调用 `POST /v1/passkey/registration-context` 取得一次性 `context`，再交给 Better Auth Passkey 注册；登录直接调用 Better Auth Passkey。所有后端 API 请求携带 session cookie；用户页展示 Direct、STUN、TURN、SFU、R2 流量和 Durable 取件码请求次数及额度。

本地 Worker 鉴权环境需要与前端 origin 匹配：

```bash
BETTER_AUTH_URL=http://localhost:8787
APP_ORIGIN=http://localhost:5173
```

## Deploy

默认构建产物在 `dist/`，可用于 Cloudflare Pages、Vercel 或其他静态前端托管平台。

## TURN

`/turn` 页面在生成 TURN Offer 或 TURN Answer 时，会通过后端自动申请临时 `iceServers`：

```text
POST /v1/turn/credentials
```

拿到临时 `iceServers` 后，页面会用 `iceTransportPolicy: "relay"` 强制通过 TURN relay 传输文件，临时 TURN 凭证不会写入连接码。

## Direct/STUN 取件码

登录用户选择文件后，前端生成 Offer，并调用 `POST /v1/pickups` 创建唯一的 8 位
取件码。接收方输入取件码读取 Offer、生成 Answer 并写回，发送方轮询 Answer 后
自动建立 DataChannel。Durable Object 只保存一小时内的信令；文件始终点对点传输。

未登录用户不会看到取件码输入或生成入口，仍可使用原有手动 Offer/Answer 流程。
Direct/STUN 发送完成后，发送端通过 `/v1/usage/transfers` 幂等上报实际文件字节。

## Security

TURN、R2、SFU 长期密钥只存在后端。R2 临时凭证仅保存在发送方页面内存中，PUT 直接上传到 R2；连接码只携带服务端生成的对象 Key、文件信息、预签名下载 URL 和过期时间。SFU 控制请求统一经过 `/v1/sfu`，前端不接触 App Token。

SFU 文件传输使用 v2 连接码和应用层流式协议：发送端根据 `RTCSctpTransport.maxMessageSize` 动态分块，每个二进制块携带文件 ID 与序号，接收端按顺序写入并校验增量 SHA-256。支持 File System Access API 的浏览器会直接写入用户选择的文件；其他浏览器仅对不超过 128 MB 的文件使用内存 Blob 回退。

## Dependency Audit

现代库和自实现能力审计见 [`docs/dependency-audit.md`](docs/dependency-audit.md)。
