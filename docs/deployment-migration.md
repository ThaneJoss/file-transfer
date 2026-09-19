# 部署迁移收尾记录

核验日期：2026-09-19。

## 维护与部署归属

| 项目 | 当前归属 |
| --- | --- |
| 唯一维护仓库 | `ThaneJoss/file-transfer`，生产分支 `main` |
| 前端 | Vercel；`https://file.thanejoss.com` |
| API 源码 | 主仓库 `worker/`；根目录 `wrangler.jsonc` |
| API 运行实例 | 原 Cloudflare Worker `file-transfer-api` |
| API 域名 | `https://api.file.thanejoss.com` |
| D1 | 原 `file-transfer-api-db`，ID `82649145-9ce8-4c7a-9457-4ba0db3a97cf` |
| Durable Object | 原 `PICKUP_SESSIONS` / `PickupSession`，migration `v1` |
| 旧 GitHub 仓库 | `ThaneJoss/file-transfer-api`，弃用，仅保留历史 |

弃用的是旧 GitHub 仓库。不要删除同名 Worker、D1、Durable Object、R2 或 Runtime Secrets。

## 已核验证据

- 主仓库生产分支提交：`0866551d2b14f2a1fef25de96097161f706980ed`。
- Cloudflare 官方 GitHub Check `Workers Builds: file-transfer-api` 于
  2026-09-14 12:10:38 UTC 成功完成，记录版本
  `a1098555-a5f7-42d4-aa31-e9e376ebafd9`。
  [构建检查](https://github.com/ThaneJoss/file-transfer/runs/103968859037)。
- 同一提交的 Vercel 状态为 `success`。
  [部署记录](https://vercel.com/joss-projects-83f40f4e/file-transfer/DH1idBLDSNMrXMmnPnB4WhCZopNY)。
- 旧仓库 `918a04040e53a730dd5c4995723ce9fa664169d8` 的 `src/` 与主仓库
  `worker/src/` 完全一致，`migrations/` 与 `worker/migrations/` 完全一致。
- Wrangler 的 Worker 名称、API 自定义域名、D1 ID、Durable Object binding、
  migration 和必需 Secret 名称一致；源码与 migration 路径已适配主仓库。
- 2026-09-19 实测 API `/health` 返回 HTTP 200 与 `{"ok":true,"db":"ok"}`。
  此检查确认 API 可达及 D1 连通，不代表已核验全部生产表、密钥或真实文件传输。

## 后续发布

两个平台保持默认仓库根目录和 `pnpm build`。Cloudflare 注入 `WORKERS_CI=1`
后仅检查 Worker；Vercel 默认构建 `dist/`。Worker 配置不包含 `assets`。

Cloudflare 生产命令保持 `npx wrangler deploy`，非生产命令保持
`npx wrangler versions upload`，构建变量 `PNPM_VERSION=11.15.1`。
默认 Wrangler 发布不自动应用 D1 migration；新增 migration 时先从主仓库执行
`pnpm db:migrations:apply:remote`，或者使用包含该前置步骤的 `pnpm deploy:worker`。

## 平台收尾状态

- 已有主仓库生产分支的成功 Cloudflare 构建证据；无需新建 Worker 或迁移数据。
- 本次 Cloudflare Dashboard 被浏览器安全验证阻挡，未直接读取当前 Git 连接设置，
  也未在 Dashboard 修改配置。平台维护者仍需确认没有旧仓库的额外构建连接。
- 旧仓库应合并弃用说明并停用 `pnpm deploy`，随后在 GitHub Settings 中归档。
  归档完成前，不将旧仓库标记为已归档。
- 回滚从主仓库的已知良好提交或原 Worker 的已知良好版本执行，不恢复旧仓库自动部署。
