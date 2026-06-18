# 依赖与自实现能力审计

| 当前实现 | 候选库或原生 API | 是否替换 | 理由 | Bundle 影响 | 迁移风险 | 测试方案 |
| --- | --- | --- | --- | --- | --- | --- |
| 手写 `history.pushState` / `popstate` 路由 | React Router Declarative Mode | 是 | 路由、活动导航、前进后退交给维护活跃的路由库，删除手写浏览器历史同步逻辑 | 增加 `react-router-dom`，换取路由可靠性 | 低；保留 `/direct`、`/stun`、`/turn`、`/sfu`、`/r2` URL | 五页 e2e 直接访问、刷新、前进后退、活动导航 |
| `puppeteer-core` 自搭测试运行器依赖 | Playwright | 是 | 任务需要真实浏览器布局回归；Playwright 提供 webServer、trace、report 和 CI 安装能力 | 移除 `puppeteer-core`，增加 `@playwright/test` | 低；只影响测试工具链 | `tests/e2e/*.spec.ts` 和 CI `pnpm test:e2e` |
| 页面内散落 `fetch`、header 和错误转换 | 原生 `fetch` + service 层 + MSW | 部分替换 | `fetch` 足够；抽出 TURN/SFU service 后可用 MSW 离线模拟状态码和响应字段 | 无运行时库；MSW 仅 devDependency | 低；请求 URL/header 保持不变 | TURN/SFU unit tests + 页面 e2e 401/403/429/500 |
| R2/AWS SigV4 手写在页面组件内 | AWS SDK v3 S3/SigV4 模块或轻量 SigV4 实现 | 暂不替换库，已模块化 | AWS SDK v3 浏览器 bundle 成本明显高于当前小范围签名需求；长期密钥仍不应进入前端生产形态。当前先抽到 `r2Signing` 并补确定性签名测试 | 不增加运行时依赖；减少页面内自实现代码 | 中；SigV4 容易被边界编码破坏 | SHA-256 标准向量、canonical URI/query、固定时间签名、e2e 上传/预签名下载 |
| 输入和响应运行时校验 | Zod / Valibot | 否 | 当前不可信 JSON 边界集中在连接码和三个 API service，手写守卫较少；引入 schema 库收益暂不抵 bundle | 无新增依赖 | 低；后续外部 JSON 增多时再评估 | 连接码无效输入 e2e、service 缺字段测试 |
| 复杂传输状态 | XState 等状态机 | 否 | 状态仍局限在页面 hook 范围；引入全局/状态机库会增加迁移面 | 无新增依赖 | 低 | Direct/STUN/TURN/SFU/R2 交互 e2e |
| WebRTC 生命周期和 DataChannel backpressure | 浏览器原生 WebRTC + 小型 helper | 否 | WebRTC 是标准 API，不应为“用库”替换；已抽出 DataChannel open/buffer 等待 helper，便于复用和测试 | 无新增依赖 | 低到中；浏览器 API mock 需贴近真实形态 | WebRTC mock e2e、资源关闭计数断言 |
| 连接码 base64url/gzip 编解码 | 浏览器 `CompressionStream` / `DecompressionStream` | 否 | 已使用原生 API，并保留 `J1.`/`D1.` 兼容格式；不需要额外库 | 无新增依赖 | 低；公开连接码格式保持兼容 | Direct/STUN/TURN/SFU/R2 无效连接码和生成测试 |
| Clipboard、下载、Object URL | 浏览器原生 API | 否，已抽 helper | 原生能力足够；抽到 `lib/browser` 以集中 fallback 和测试替换 | 无新增依赖 | 低 | e2e clipboard mock、Object URL revoke 断言 |
