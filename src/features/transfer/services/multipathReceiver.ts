import { generateCloudflareTurnIceServers } from "../../turn/services/cloudflareTurn";
import { importTransferEncryptionKey } from "../crypto/fileEncryption";
import {
  decodeTransferDescriptor,
  decodeTransferOffer,
  encodeTransferAnswer,
  fileTransferAnswerKind,
} from "../protocol/fileProtocol";
import type {
  MultipathTransferAnswer,
  R2RouteOffer,
  TransferFileManifest,
  TransferMethod,
  TransferRouteAnswer,
  WebRtcRouteOffer,
} from "../protocol/fileProtocol";
import {
  chooseReceiveTargetForFile,
  memoryReceiveLimitBytes,
} from "../protocol/fileStream";
import type { ReceiveTarget } from "../protocol/fileStream";
import { prepareSfuReceiver } from "../transports/sfu";
import type {
  SfuReceiverDescriptor,
  SfuSenderDescriptor,
  SfuTransportSession,
} from "../transports/sfu";
import { createWebRtcReceiverSession } from "../transports/webrtc";
import type {
  WebRtcReceiverSession,
  WebRtcSignal,
} from "../transports/webrtc";
import { MultipathChannelReceiver } from "./channelTransfer";
import {
  monitorPickupCancellation,
  submitPickupAnswer,
  waitForPickupOffer,
  watchPickupSelections,
} from "./pickupApi";
import type { PickupPayload } from "./pickupApi";
import {
  benchmarkR2Route,
  streamR2FileWhenReady,
} from "./r2Transfer";
import { downloadFile as downloadLegacyR2 } from "./transferRouter";
import {
  assertTargetCapacity,
  confirmPickupWinner,
  linkedAbortController,
  neverSettles,
  routeLabel,
  routePreparationTimeoutMs,
  settle,
  withRouteDeadline,
} from "./multipathCoordinator";
import type {
  ReceiverCallbacks,
  RouteState,
  RouteStates,
} from "./multipathCoordinator";

export async function runMultipathReceiver({
  code,
  target,
  signal,
  preparedPickup,
  encryptionKey,
  callbacks = {},
}: {
  code: string;
  target: ReceiveTarget;
  signal: AbortSignal;
  preparedPickup?: PickupPayload;
  encryptionKey?: CryptoKey | null;
  callbacks?: ReceiverCallbacks;
}) {
  const routeStates: RouteStates = {};
  const setRoute = (route: TransferMethod, state: RouteState) => {
    routeStates[route] = state;
    callbacks.onRoutes?.({ ...routeStates });
  };
  callbacks.onStatus?.("正在读取取件码...");
  const pickup = preparedPickup ?? await waitForPickupOffer(code, signal, {
    onPending: () => callbacks.onStatus?.("取件码已生成，发送端仍在准备文件和线路..."),
  });
  if (Date.now() >= pickup.expiresAt) throw new Error("这个取件码已经过期，请让发送方重新生成。");

  if (pickup.variant === "r2") {
    const descriptor = await decodeTransferDescriptor(pickup.offer);
    assertTargetCapacity(target, descriptor.file.size);
    callbacks.onFile?.(descriptor.file, "legacy");
    setRoute("r2", "transferring");
    callbacks.onStatus?.("正在下载旧版 R2 文件并校验完整性...");
    const result = await downloadLegacyR2({ descriptor, target, signal, onProgress: callbacks.onProgress });
    setRoute("r2", "complete");
    return { file: descriptor.file, mode: "legacy" as const, winner: { route: "r2" as const, bytes: result.bytes, sha256: result.sha256 }, result };
  }
  if (pickup.variant !== "multipath") throw new Error("这个取件码使用了已停用的技术页面，请让发送方重新生成。");

  const offer = await decodeTransferOffer(pickup.offer);
  if (offer.encryption && !encryptionKey) throw new Error("这个文件需要通过包含端到端密钥的分享链接接收。");
  assertTargetCapacity(target, offer.file.size);
  callbacks.onFile?.(offer.file, offer.mode);
  callbacks.onStatus?.("正在并行连接五条传输线路...");
  offer.routes.forEach((route) => setRoute(route.kind, "preparing"));

  const receiverSessions: WebRtcReceiverSession[] = [];
  let sfuSession: SfuTransportSession | null = null;
  const channelController = linkedAbortController(signal);
  const r2Controller = linkedAbortController(signal);
  const cancellationController = linkedAbortController(signal);
  let selectionController: AbortController | null = null;
  const receiver = new MultipathChannelReceiver(offer, target, channelController.signal, callbacks.onProgress, encryptionKey);
  // Prevent a later cancellation from becoming an unhandled rejection while R2 is selected.
  void receiver.completion.catch(() => undefined);
  const detach: Array<() => void> = [];

  try {
    const sfuOffer = offer.routes.find((route) => route.kind === "sfu");
    const r2Offer = offer.routes.find((route): route is R2RouteOffer => route.kind === "r2") ?? null;
    const webRtcOffers = offer.routes.filter((route): route is WebRtcRouteOffer =>
      route.kind === "direct" || route.kind === "stun" || route.kind === "turn",
    );
    const webRtcWork = Promise.all(webRtcOffers.map(async (route) => {
      const result = await settle(withRouteDeadline(
        signal,
        routePreparationTimeoutMs,
        `${routeLabel(route.kind)} 应答`,
        async (routeSignal) => {
          let session: WebRtcReceiverSession | null = null;
          try {
            const iceServers = route.kind === "turn"
              ? await generateCloudflareTurnIceServers(3600, { signal: routeSignal })
              : undefined;
            session = createWebRtcReceiverSession({ route: route.kind, iceServers });
            receiverSessions.push(session);
            const answer = await session.acceptOffer(route.signal as WebRtcSignal, {
              signal: routeSignal,
              timeoutMs: routePreparationTimeoutMs,
            });
            return { session, answer };
          } catch (error) {
            session?.dispose();
            throw error;
          }
        },
      ));
      if (!result.ok) {
        setRoute(route.kind, "failed");
        await receiver.markRouteUnavailable(route.kind, result.error);
      } else {
        setRoute(route.kind, "ready");
      }
      return result;
    }));
    const sfuWork = sfuOffer
      ? settle(withRouteDeadline(
          signal,
          routePreparationTimeoutMs,
          "SFU 应答",
          (routeSignal) => prepareSfuReceiver(
            sfuOffer.descriptor as unknown as SfuSenderDescriptor,
            { signal: routeSignal, timeoutMs: 5_000 },
          ),
        ))
      : Promise.resolve(null);
    const r2MetricWork = r2Offer
      ? settle(withRouteDeadline(
          signal,
          routePreparationTimeoutMs,
          "R2 测速",
          (routeSignal) => benchmarkR2Route(r2Offer, routeSignal),
        ))
      : Promise.resolve(null);

    const [webRtcResults, sfuResult, r2MetricResult] = await Promise.all([
      webRtcWork,
      sfuWork,
      r2MetricWork,
    ]);
    const successfulWebRtc = webRtcResults.flatMap((result) => result.ok ? [result.value] : []);
    const routeAnswers: TransferRouteAnswer[] = successfulWebRtc.map(({ session, answer }) => ({
      kind: session.route,
      signal: answer,
    }));

    const preparedSfu = sfuResult?.ok ? sfuResult.value : null;
    if (sfuResult && !sfuResult.ok) {
      setRoute("sfu", "failed");
      await receiver.markRouteUnavailable("sfu", sfuResult.error);
    }
    if (preparedSfu) {
      setRoute("sfu", "ready");
      sfuSession = preparedSfu;
      detach.push(receiver.attach({ method: "sfu", channel: preparedSfu.channel, dispose: preparedSfu.dispose }));
      routeAnswers.push({
        kind: "sfu",
        descriptor: preparedSfu.answerDescriptor as unknown as Record<string, unknown>,
      });
    }
    const r2Metric = r2MetricResult?.ok ? r2MetricResult.value : undefined;
    // A failed probe only makes R2 the last fallback. The object route itself
    // can still become readable after the sender starts the real upload.
    if (r2Offer) setRoute("r2", "ready");
    if (routeAnswers.length === 0 && !preparedSfu && !r2Offer) throw new Error("取件码中的线路在当前网络都不可用。");

    const channelReady = successfulWebRtc.map(async ({ session }) => {
      try {
        const channel = await session.waitForDataChannel({ signal: channelController.signal, timeoutMs: 15_000 });
        detach.push(receiver.attach({ method: session.route, channel, dispose: session.dispose }));
      } catch (error) {
        await receiver.markRouteUnavailable(session.route, error);
        throw error;
      }
    });
    // Install all waiters before publishing the answer so no early probe is lost.
    const readyWaits: Promise<unknown>[] = [...channelReady];
    if (preparedSfu) {
      readyWaits.push(preparedSfu.ready.catch(async (error) => {
        await receiver.markRouteUnavailable("sfu", error);
        throw error;
      }));
    }
    void Promise.allSettled(readyWaits);

    const answer: MultipathTransferAnswer = {
      kind: fileTransferAnswerKind,
      transferId: offer.transferId,
      routes: routeAnswers,
      metrics: { ...(r2Metric ? { r2: r2Metric } : {}) },
    };
    await submitPickupAnswer(code, await encodeTransferAnswer(answer), signal);
    callbacks.onStatus?.(offer.mode === "turbo" ? "极速模式已启动，五条线路正在同时传输..." : "正在测速并选择最快线路...");
    // Auto mode already keeps the selection endpoint open for fallback updates;
    // it also returns 410 on cancellation, so a second status poll would only
    // double the coordination traffic. Turbo has no selection watch.
    const remoteCancellation = offer.mode === "turbo"
      ? monitorPickupCancellation(code, cancellationController.signal, pickup.expiresAt)
      : neverSettles();
    void remoteCancellation.catch(() => undefined);

    let r2Started = false;
    const startR2Route = () => {
      if (!r2Offer || r2Started) return;
      if (!receiver.startExternalRoute("r2")) return;
      r2Started = true;
      setRoute("r2", "transferring");
      void streamR2FileWhenReady({
        route: r2Offer,
        expectedSize: r2Offer.contentSize ?? offer.file.size,
        expectedSha256: offer.encryption ? null : offer.file.sha256,
        chunkSize: offer.file.chunkSize + (offer.encryption?.tagBytes ?? 0),
        signal: r2Controller.signal,
        onChunk: (sequence, chunk) => receiver.acceptExternalChunk("r2", sequence, chunk),
      }).then(async ({ totalChunks }) => {
        if (totalChunks !== offer.file.totalChunks) throw new Error("R2 文件分块数量不正确。");
        await receiver.completeExternalRoute("r2");
      }).catch((error) => receiver.failExternalRoute("r2", error));
    };

    let result;
    if (offer.mode === "auto") {
      selectionController = linkedAbortController(signal);
      let resolveFirstSelection!: (selection: { route: TransferMethod }) => void;
      let rejectFirstSelection!: (error: unknown) => void;
      const firstSelection = new Promise<{ route: TransferMethod }>((resolve, reject) => {
        resolveFirstSelection = resolve;
        rejectFirstSelection = reject;
      });
      const selectionWatch = watchPickupSelections(
        code,
        selectionController.signal,
        pickup.expiresAt,
        (selection) => {
          if (!offer.routes.some((route) => route.kind === selection.route)) {
            throw new Error("发送端选择了取件协议中不存在的线路。");
          }
          callbacks.onStatus?.(`已选择 ${routeLabel(selection.route)}，正在接收并校验文件...`);
          setRoute(selection.route, "transferring");
          if (selection.route === "r2") startR2Route();
          resolveFirstSelection(selection);
        },
      ).catch((error) => {
        rejectFirstSelection(error);
        throw error;
      });
      void selectionWatch.catch(() => undefined);

      const initial = await Promise.race([
        firstSelection.then(() => ({ kind: "selection" as const })),
        receiver.completion.then((value) => ({ kind: "complete" as const, value })),
        remoteCancellation,
      ]);
      if (initial.kind === "complete") {
        result = initial.value;
      } else {
        result = await Promise.race([receiver.completion, selectionWatch, remoteCancellation]);
      }
    } else {
      for (const route of offer.routes) {
        if (routeStates[route.kind] !== "failed") setRoute(route.kind, "transferring");
      }
      startR2Route();
      if (readyWaits.length === 0 && !r2Offer) throw new Error("没有可用的传输线路。");
      result = await Promise.race([receiver.completion, remoteCancellation]);
    }

    selectionController?.abort(new DOMException("线路选择监听已结束。", "AbortError"));
    cancellationController.abort(new DOMException("取消状态监听已结束。", "AbortError"));
    const winner = { route: result.route, bytes: result.bytes, sha256: result.sha256 };
    setRoute(winner.route, "complete");
    const coordinationConfirmed = await confirmPickupWinner(code, winner, signal).catch(() => false);
    callbacks.onProgress?.(offer.file.size, offer.file.size);
    callbacks.onStatus?.(coordinationConfirmed
      ? `接收完成，${routeLabel(winner.route)} 最先通过 SHA-256 校验。`
      : "文件已保存并通过校验，但暂时无法通知发送端。");
    return { file: offer.file, mode: offer.mode, winner, result, coordinationConfirmed };
  } catch (error) {
    await receiver.fail(error);
    throw error;
  } finally {
    channelController.abort(new DOMException("接收流程已结束。", "AbortError"));
    r2Controller.abort(new DOMException("接收流程已结束。", "AbortError"));
    cancellationController.abort(new DOMException("接收流程已结束。", "AbortError"));
    selectionController?.abort(new DOMException("接收流程已结束。", "AbortError"));
    detach.forEach((remove) => remove());
    receiverSessions.forEach((session) => session.dispose());
    (sfuSession as SfuTransportSession | null)?.dispose();
  }
}

export async function inspectPickupFile(
  code: string,
  signal?: AbortSignal,
  onPending?: () => void,
  allowGuest = false,
  encryptionSecret = "",
) {
  const pickup = await waitForPickupOffer(code, signal, { onPending, allowGuest });
  if (Date.now() >= pickup.expiresAt) throw new Error("这个取件码已经过期，请让发送方重新生成。");
  if (pickup.variant === "r2") {
    const descriptor = await decodeTransferDescriptor(pickup.offer);
    return { pickup, file: descriptor.file, mode: "legacy" as const, encryptionKey: null };
  }
  if (pickup.variant !== "multipath") throw new Error("这个取件码使用了已停用的传输协议。");
  const offer = await decodeTransferOffer(pickup.offer);
  const encryptionKey = offer.encryption
    ? await importTransferEncryptionKey(encryptionSecret, offer.encryption)
    : null;
  return { pickup, file: offer.file, mode: offer.mode, encryptionKey };
}

export async function chooseInitialReceiveTarget(file?: Pick<TransferFileManifest, "name" | "size">) {
  if (typeof window !== "undefined" && "showSaveFilePicker" in window) {
    return chooseReceiveTargetForFile(file ?? { name: "接收文件", size: 0 });
  }
  if (file && file.size > memoryReceiveLimitBytes) return chooseReceiveTargetForFile(file);
  return { kind: "memory" } as ReceiveTarget;
}

