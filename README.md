# 文件中转站

一个面向普通用户的临时文件发送与接收页面。发送方选择文件后先获得 8 位取件码；接收方输入取件码后，页面自动在 Direct、STUN、TURN、SFU 和 R2 中选择可用且预计最快的线路并校验完整性。

## 当前流程

1. 使用 Passkey 登录。
2. 选择文件和模式。浏览器分块计算 SHA-256，并行准备五条线路；此时只会发送信令和小型测速对象，不发送文件正文。
3. 页面发布 `file-transfer-v3` 多路协议并生成 8 位取件码。协议包含文件清单和可用线路描述，不包含 R2 临时 secret access key。
4. 接收方输入取件码后，双方建立可用线路并做端到端吞吐探测。
5. 智能模式根据连接时间和实测吞吐估算完成时间，只让预计最快的线路发送正文；失败时继续尝试其他可用线路。
6. 极速模式让所有可用实时线路发送相同的有序分块，同时启动 R2 上传；接收端按 sequence 去重，只写入一份文件，首个通过大小和 SHA-256 校验的结果获胜并取消其他任务。

产品页只有“上传文件”和“下载文件”两个入口，不再提供五个技术详情页面。网络或浏览器不支持某条线路时，该线路会被排除，不会阻止其他线路生成取件码。旧 `file-transfer-v2` R2 取件码仍可下载。

## 大文件与取消

- 准备阶段以 4 MiB 分块计算 SHA-256；实时传输以 48 KiB 分块并使用 DataChannel 背压，R2 上传直接传递浏览器 `File`，不会先把整个文件转成 `ArrayBuffer`。
- 支持 File System Access API 的 Chrome / Edge 会把下载流直接写入用户选择的位置。
- 其他浏览器使用内存下载，单文件限制为 128 MiB，避免不可控的内存占用。
- 哈希、信令、ICE、DataChannel、SFU、R2 XHR/fetch、取件轮询和接收写盘都支持取消。新的操作会终止旧操作，并通过操作编号忽略迟到结果；页面卸载会关闭所有会话。
- 当前临时上传授权、下载链接和取件码按一小时有效设计；最终时限以 API 返回值为准。

## 代码结构

- `src/features/transfer/protocol/fileProtocol.ts`：版本化文件协议和运行时校验。
- `src/features/transfer/protocol/fileFrames.ts`：公共测速、分块、完成和确认帧。
- `src/features/transfer/protocol/fileStream.ts`：增量哈希、流式接收、大小与 SHA-256 校验。
- `src/features/transfer/transports/webrtc`：Direct / STUN / TURN 的结构化信令、candidate 隔离和 DataChannel 生命周期。
- `src/features/transfer/transports/sfu`：将 Cloudflare Calls 两条单向 DataChannel 组合为可确认的双向通道。
- `src/features/transfer/services/multipathTransfer.ts`：五路准备、测速、选择、并发、回退和胜者协调。
- `src/features/transfer/services/channelTransfer.ts`：实时分块发送、背压、去重和接收端完整性确认。
- `src/features/transfer/services/r2Transfer.ts`：R2 测速对象、延迟正文上传和流式下载。
- `src/features/transfer/services/transferRouter.ts`：旧 R2 取件码兼容下载。
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

`VITE_API_BASE_URL` 可选；不设置时使用生产 API `https://api.file.thanejoss.com`。API 负责 Passkey 会话、临时 TURN / R2 凭证、SFU 代理、取件信令以及 selection / winner 协调，浏览器不会持有长期密钥。

## 验证

```bash
pnpm typecheck
pnpm test:unit
pnpm test:e2e
pnpm build
```

`pnpm check` 会串行执行全部检查。单元测试覆盖 v3 协议、candidate 隔离、DataChannel 超时与清理、极速分块去重、完整性、取消和后端协调；端到端测试使用网络 mock，不会写入真实账户或对象存储。

## 部署注意事项

- 前端 `file-transfer-v3` 必须与支持 `multipath`、384 KiB 信令以及 selection / winner 接口的 API 版本一起部署；API 应先于前端上线。
- 对象存储 CORS 需要允许站点 Origin、`PUT` / `GET` 和签名请求头，并暴露 `Content-Length`。
- `/assets/*` 使用带内容哈希的长期不可变缓存，其他路径回退到 `index.html`。
- `index.html` 的模块脚本标记了 `data-cfasync="false"`，避免 Cloudflare Rocket Loader 改写启动脚本。
- 临时对象的最终清理策略由对象存储生命周期规则负责，前端只控制访问链接的有效期。
