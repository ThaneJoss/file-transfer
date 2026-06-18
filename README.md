# 文件中转站

纯前端文件传输实验工具，包含 Direct、STUN、TURN、SFU 和 R2 五种页面。

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

`pnpm check` 会依次运行类型检查、Vitest 单元测试、Playwright 端到端测试和生产构建。默认测试全部使用假值和网络拦截，不需要真实 Cloudflare、SFU 或 R2 凭证，也不会访问生产服务。

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

live 测试默认跳过，只应在具备短期、低权限、可撤销凭证的受控环境运行。不要把真实 Token 写入源码、fixture、`.env.example`、Playwright storage state、截图、trace、video 或报告。

## Deploy

默认构建产物在 `dist/`，可用于 Cloudflare Pages、Vercel 或其他静态前端托管平台。

## TURN

`/turn` 页面使用 Cloudflare TURN keys。页面内填写 Key ID、API Token 和 TTL 后，会调用：

```text
https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate-ice-servers
```

拿到临时 `iceServers` 后，页面会用 `iceTransportPolicy: "relay"` 强制通过 TURN relay 传输文件。

## Security

TURN、SFU 和 R2 凭证都由用户在浏览器运行时手动输入，默认不持久化到 `localStorage`。默认自动化测试只使用 `test-token`、`fake-app-id`、`example-access-key`、`fake-secret` 等明显假值，并通过 MSW 或 Playwright route 拦截验证请求 method、URL、headers 和 body。

R2 页面保留前端手动输入 S3 API 凭证的演示模式。生产环境如需长期后台密钥，应增加最小化 serverless/edge 代理，由服务端保存长期密钥，前端只获取作用域受限、短期有效的凭证。

## Dependency Audit

现代库和自实现能力审计见 [`docs/dependency-audit.md`](docs/dependency-audit.md)。
