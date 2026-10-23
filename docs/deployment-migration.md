# 部署迁移记录

## 2026-10-24：单 Worker、单域名部署

本次配置将网页与 API 合并为一个 `file-transfer` Worker。前端默认请求同源 API，
不再分别部署静态前端和 API。生产主域名仍为 `https://file.thanejoss.com`。

[PR #50](https://github.com/ThaneJoss/file-transfer/pull/50) 已完成单 Worker 上线，
原独立静态 Worker 和对应构建触发器已删除。本节记录后续统一域名后的配置与核验要求；
本轮管理路径迁移和旧域名撤除的最终线上证据以对应 GitHub PR 中的实际发布记录为准。

| 配置 | 单 Worker 配置 |
| --- | --- |
| 唯一维护仓库 / 生产分支 | `ThaneJoss/file-transfer` / `main` |
| Worker 名称 | `file-transfer` |
| 保留的 Worker 内部 ID | `8b049ff2ea33447699b90810b767f3d3`，原 API 身份 |
| 唯一部署配置 | 根目录 `wrangler.jsonc`，包含 API 入口与前端 assets |
| Build command | `pnpm run build` |
| Deploy command | `npx wrangler deploy` |
| 分支版本上传 | `npx wrangler versions upload` |
| 生产触发器 | `42d8567f-6fe4-4e2f-8c90-b4edfde3d1f0` |
| 分支版本上传触发器 | `28da0b41-eb13-4940-8b4e-43d8d4228d00` |
| D1 | `file-transfer-api-db`，ID `82649145-9ce8-4c7a-9457-4ba0db3a97cf` |
| Durable Object | `PICKUP_SESSIONS` / `PickupSession`，namespace `84464ad3a1f047d098f714099aa438ac` |
| 主站和默认 API | `https://file.thanejoss.com` |
| 管理页 | `https://file.thanejoss.com/admin/`，沿用 Cloudflare Access 管理员策略 |

### 资源与切换边界

保留原 API Worker 的内部身份，通过 Cloudflare 原地改名获得 `file-transfer` 名称。
原 Runtime Secrets、D1 和 Durable Object namespace 继续使用；无需读取密钥值、
复制账户数据或重建取件会话。R2 及其生命周期和 CORS 规则保持原配置。

PR #50 上线并验证整合版后，已删除原静态 Worker 身份
`52bccc12b7d44e6ead68cc4386eb21f4` 及其独立前端触发器。
保留的生产发布和分支版本上传触发器绑定原 API 的稳定 Worker ID，构建、配置名称和部署命令应与
改名后的单 Worker 一致。不要删除保留的 API 内部身份来实现改名：删除会影响其实现的
Durable Object namespace。

网页、API 和管理页统一使用 `file.thanejoss.com`，旧 API 域名已撤除。
原 Cloudflare Access 管理员策略迁至主域名的 `/admin` 和 `/admin/*`，包含管理 API；
站点其他页面与普通 API 保持公开访问。Worker 拒绝其他主机上的管理路径，避免绕过
Access；本地开发仅在请求主机与 `APP_ORIGIN` 都为 localhost/loopback 时例外。

Passkey RP ID 一直为 `file.thanejoss.com`，已有 Passkey 仍可使用。
默认 API 改为同源后，会话 Cookie 的主机从 API 域名变成主站，已有浏览器会话可能需要
重新登录一次。数据库中的用户与 Passkey 不因此迁移或重建。

### 开发、构建与发布

- `pnpm dev` 仍运行 Vite；默认 API 请求同源，由 Vite 代理到本地 Worker `localhost:8787`。
- `pnpm dev:worker` 先构建前端资源，再启动 Wrangler；`.dev.vars` 保存本地服务端配置。
- `.env.local` 中 `VITE_API_BASE_URL` 是可选覆盖项，默认不需要设置。
- `pnpm build` 构建整个应用，不再根据 `WORKERS_CI` 切换为 API-only 构建。
- `pnpm run deploy` 构建应用、应用远程 D1 migration、发布单个 Worker；`pnpm deploy:worker` 是兼容入口。
- `pnpm preview:worker` 构建应用并上传候选版本，不更改生产流量。

推送 `main` 触发一次生产应用发布，其他分支自动构建并上传候选版本。
当前 Worker 绑定 Durable Objects，legacy `wrangler versions upload` 不生成在线预览
链接；实测上传版本为 `has_preview: false`。`preview:worker` 保留原命令名，仅代表
候选版本上传；完整应用可通过 `pnpm dev:worker`（本地 `wrangler dev`）验证。
平台默认命令 `npx wrangler deploy` 不自动应用 D1 migration；新增 migration 时先执行
`pnpm db:migrations:apply:remote`。前后端属于同一个版本，数据库变更仍需保持兼容。

### 发布核验与回滚

发布前检查 lint、类型、单元测试、Worker 集成测试、浏览器 E2E、整合构建、
绑定类型同步及 Wrangler dry-run。发布后检查主站的健康接口、同源登录接口、未知
API 的错误响应、SPA 深层路由和静态资源缓存。确认主域名 `/admin`、`/admin/*` 触发
Cloudflare Access，其他主机拒绝管理路径，旧 API 域名的 Worker 绑定和 DNS 已撤除。
最后确认 GitHub `main` 推送触发的 Workers Build 成功。

回滚优先回到经过验证的整合版 Worker 版本或相应 GitHub 提交。
合并后的回滚应同时考虑页面和 API，不直接回到只含 API 的历史版本，以免主站失去页面。
若需要恢复旧拓扑，应先核对域名、Secrets、DO namespace 和构建触发器；不能通过删除
保留的 Worker 身份来回滚。

### 已有 Cloudflare 站点设置

首次前端迁移时已配置 `file.thanejoss.com` 专用 Configuration Rule：

- Ruleset：`eecb47dd38e04ed29ee2ff2b9d2a76f7`
- Rule：`a56e14bfdfa1405cae90d1d1e234c02a`
- 匹配：`http.host eq "file.thanejoss.com"`
- 设置：`disable_rum=true`

该规则关闭此主机的自动 Analytics 脚本注入，避免它与应用 `script-src 'self'` CSP
冲突；其他主机的统计配置不受影响。既有 zone HSTS 策略将生产响应覆盖为
`max-age=2592000; includeSubDomains; preload`。应用安全响应头仍分别维护在
`public/_headers` 和 Worker 中。

## 历史：前端首次迁入 Cloudflare（2026-10-24）

这是合并为一个 Worker 之前的状态，已被上面的单 Worker 方案替代。
当时将 Vercel 前端迁入独立静态 Worker `file-transfer`，API 保留为
`file-transfer-api`，两个部署连接同一 GitHub 仓库。原域名、D1、DO 和 R2 保留。

对应 [PR #49](https://github.com/ThaneJoss/file-transfer/pull/49) 已合并，提交为
`9bff102e6bfe98b7d92d21648b1a1facc5c8e834`。当时 main 推送的生产构建记录：

| 当时项目 | Build ID | 已验证版本 |
| --- | --- | --- |
| 静态前端 | `929ca909-2e4d-4f92-9ef3-6d31d0c60c49` | `d7849b1b-46f3-4d4c-9701-fe15980fa229` |
| API | `7a1d4aee-129e-44e3-81ac-c6026f57ca5b` | `48ed65d3-ec7c-41f5-ad9f-d48154fe2b27` |

当时静态前端的生产触发器 `0df87186-1973-4c3d-a04f-b98e8580892c` 和预览触发器
`d4ea5c7f-f467-49b5-ba8f-cba74ff2b780` 已在 PR #50 的合并清理中移除。

历史 API 域名为 `api.file.thanejoss.com`。PR #50 合并单 Worker 时曾保留它作为
旧客户端和管理页的兼容入口；后续统一域名时已撤除，当前只使用 `file.thanejoss.com`。

Vercel 历史部署保留作迁移参考；当时原 DNS 为
`file.thanejoss.com CNAME cname-cn.vercel-dns.com`，DNS only，TTL 自动。
此记录不表示恢复该 DNS 足以回滚当前同源应用。

## 历史：API 合并仓库（2026-09-19）

当时唯一维护仓库调整为 `ThaneJoss/file-transfer`，生产分支 `main`；
前端仍在 Vercel，API 源码从旧仓库迁入主仓库 `worker/`，保留原 Cloudflare API Worker。
弃用的是旧 `ThaneJoss/file-transfer-api` GitHub 仓库，而不是数据库或文件存储。

当时已核验证据：

- 主仓库生产提交：`0866551d2b14f2a1fef25de96097161f706980ed`。
- Cloudflare 官方 GitHub Check `Workers Builds: file-transfer-api` 于
  2026-09-14 12:10:38 UTC 成功，版本 `a1098555-a5f7-42d4-aa31-e9e376ebafd9`。
  [构建检查](https://github.com/ThaneJoss/file-transfer/runs/103968859037)。
- 同一提交的 Vercel 状态为 success。
  [部署记录](https://vercel.com/joss-projects-83f40f4e/file-transfer/DH1idBLDSNMrXMmnPnB4WhCZopNY)。
- 旧仓库 `918a04040e53a730dd5c4995723ce9fa664169d8` 的 `src/` 和 `migrations/`
  与主仓库的 `worker/src/`、`worker/migrations/` 完全一致。
- 2026-09-19 API `/health` 返回 HTTP 200 和 `{"ok":true,"db":"ok"}`，确认 API 与 D1 连通。

当时 Dashboard 安全验证阻碍直接核对 Git 连接，旧仓库归档仍待平台维护者完成。
这些历史限制不作为当前 Worker 或构建连接状态的判断依据。
