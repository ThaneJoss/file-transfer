# 文件中转站

一个面向普通用户的临时文件上传与下载页面。发送方上传文件后获得 8 位取件码；接收方输入取件码，页面按照协议中的路由下载文件并校验完整性。

## 当前流程

1. 使用 Passkey 登录。
2. 上传文件。浏览器分块计算 SHA-256，并把 `File` 直接流向对象存储。
3. 页面发布 `file-transfer-v2` 协议和 8 位取件码；协议包含文件清单、短期签名下载路由和过期时间，不包含签名所用的 secret access key。
4. 接收方读取取件码，确认文件名和大小后下载。
5. 下载过程中逐块校验字节数和 SHA-256；数据不完整或被篡改时不会提示成功。

产品页只有“上传文件”和“下载文件”两个入口。Direct、STUN、TURN、SFU、R2 等实现细节不再作为用户可选页面；当前协议路由到临时对象存储，后续可以在协议路由层扩展其他实现。

## 大文件与取消

- 上传前以 4 MiB 分块计算 SHA-256，上传时直接传递浏览器 `File`，不会先把整个文件转成 `ArrayBuffer`。
- 支持 File System Access API 的 Chrome / Edge 会把下载流直接写入用户选择的位置。
- 其他浏览器使用内存下载，单文件限制为 128 MiB，避免不可控的内存占用。
- 上传、读取取件码和下载都支持取消。新的操作会终止旧操作，并通过操作编号忽略迟到的异步结果。
- 当前临时上传授权、下载链接和取件码按一小时有效设计；最终时限以 API 返回值为准。

## 代码结构

- `src/features/transfer/protocol/fileProtocol.ts`：版本化文件协议和运行时校验。
- `src/features/transfer/protocol/fileStream.ts`：增量哈希、流式接收、大小与 SHA-256 校验。
- `src/features/transfer/services/r2Transfer.ts`：发送端上传及取件码发布。
- `src/features/transfer/services/transferRouter.ts`：按协议解析下载路由并保存文件。
- `src/features/transfer/hooks/useFileSender.ts`：发送端状态和动作。
- `src/features/transfer/hooks/useFileReceiver.ts`：接收端状态和动作。
- `src/features/transfer/hooks/useTransferLifecycle.ts`：取消、竞态隔离和卸载清理。
- `src/features/transfer/FileTransferPage.tsx`：统一上传 / 下载产品页。

## 本地开发

要求 Node.js 24 和 pnpm 11.6。

```bash
pnpm install --frozen-lockfile
cp .env.example .env.local
pnpm dev
```

`VITE_API_BASE_URL` 可选；不设置时使用生产 API `https://api.file.thanejoss.com`。API 负责 Passkey 会话、临时对象存储凭证和取件码，浏览器不会持有长期存储密钥。

## 验证

```bash
pnpm typecheck
pnpm test:unit
pnpm test:e2e
pnpm build
```

`pnpm check` 会串行执行全部检查。端到端测试使用网络 mock 覆盖上传、协议发布、完整下载、内容损坏、取消竞态和旧协议拒绝，不会写入真实账户或对象存储。

## 部署注意事项

- 对象存储 CORS 需要允许站点 Origin、`PUT` / `GET` 和签名请求头。
- `/assets/*` 使用带内容哈希的长期不可变缓存，其他路径回退到 `index.html`。
- `index.html` 的模块脚本标记了 `data-cfasync="false"`，避免 Cloudflare Rocket Loader 改写启动脚本。
- 临时对象的最终清理策略由对象存储生命周期规则负责，前端只控制访问链接的有效期。
