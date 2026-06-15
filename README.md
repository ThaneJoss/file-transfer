# 文件中转站

纯前端项目架子，当前只包含静态界面和演示数据。

## Scripts

```bash
pnpm dev
pnpm build
pnpm preview
```

## Deploy

默认构建产物在 `dist/`，可用于 Cloudflare Pages、Vercel 或其他静态前端托管平台。

## TURN

`/turn` 页面使用 Cloudflare TURN keys。页面内填写 Key ID、API Token 和 TTL 后，会调用：

```text
https://rtc.live.cloudflare.com/v1/turn/keys/{key_id}/credentials/generate-ice-servers
```

拿到临时 `iceServers` 后，页面会用 `iceTransportPolicy: "relay"` 强制通过 TURN relay 传输文件。
