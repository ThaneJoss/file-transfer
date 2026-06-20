# 文件中转站

浏览器文件传输工具，包含 Direct、STUN、TURN、SFU 和 R2 五种页面。Direct/STUN 公开使用，TURN/SFU/R2 通过 Better Auth session 访问后端控制面。

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

注册、登录、退出和 session 由 Better Auth 提供，前端只提供 Passkey 鉴权。注册时前端先调用 `POST /v1/passkey/registration-context` 取得一次性 `context`，再交给 Better Auth Passkey 注册；登录直接调用 Better Auth Passkey。所有后端 API 请求携带 session cookie；页面顶部展示当前用户与 TURN/R2/SFU 事件数。

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

## Security

TURN、R2、SFU 长期密钥只存在后端。R2 临时凭证仅保存在发送方页面内存中，PUT 直接上传到 R2；连接码只携带服务端生成的对象 Key、文件信息、预签名下载 URL 和过期时间。SFU 控制请求统一经过 `/v1/sfu`，前端不接触 App Token。

## Dependency Audit

现代库和自实现能力审计见 [`docs/dependency-audit.md`](docs/dependency-audit.md)。
