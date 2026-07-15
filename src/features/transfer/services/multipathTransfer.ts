import { ApiError } from "../../../lib/api/client";
import { generateCloudflareTurnIceServers } from "../../turn/services/cloudflareTurn";
import { throwIfAborted } from "../hooks/useTransferLifecycle";
import {
  decodeTransferAnswer,
  decodeTransferDescriptor,
  decodeTransferOffer,
  encodeTransferAnswer,
  encodeTransferOffer,
  fileTransferAnswerKind,
  fileTransferProtocolKind,
} from "../protocol/fileProtocol";
import type {
  MultipathTransferAnswer,
  MultipathTransferOffer,
  R2RouteOffer,
  TransferFileManifest,
  TransferMethod,
  TransferMode,
  TransferRouteAnswer,
  TransferRouteOffer,
  WebRtcRouteOffer,
} from "../protocol/fileProtocol";
import {
  chooseReceiveTargetForFile,
  memoryReceiveLimitBytes,
  sha256Blob,
} from "../protocol/fileStream";
import type { ReceiveTarget } from "../protocol/fileStream";
import {
  prepareSfuReceiver,
  prepareSfuSender,
} from "../transports/sfu";
import type {
  SfuReceiverDescriptor,
  SfuSenderDescriptor,
  SfuSenderSession,
  SfuTransportSession,
} from "../transports/sfu";
import {
  createWebRtcReceiverSession,
  createWebRtcSenderSession,
} from "../transports/webrtc";
import type {
  WebRtcReceiverSession,
  WebRtcSenderSession,
  WebRtcSignal,
} from "../transports/webrtc";
import {
  estimateCompletionMs,
  MultipathChannelReceiver,
  probeChannel,
  sendFileOnChannel,
} from "./channelTransfer";
import type { ProbeResult, RouteChannel } from "./channelTransfer";
import {
  createPickup,
  getPickup,
  monitorPickupCancellation,
  pollPickupAnswer,
  pollPickupWinner,
  setPickupSelection,
  setPickupWinner,
  submitPickupAnswer,
  watchPickupSelections,
} from "./pickupApi";
import type { PickupPayload } from "./pickupApi";
import {
  benchmarkR2Route,
  prepareR2Route,
  streamR2FileWhenReady,
  uploadR2File,
} from "./r2Transfer";
import type { R2SenderSession } from "./r2Transfer";
import { reportVerifiedTransferUsage } from "./transferUsage";
import { downloadFile as downloadLegacyR2 } from "./transferRouter";

export const multipathChunkSize = 48 * 1024;
const routePreparationTimeoutMs = 15_000;
const winnerRecoveryTimeoutMs = 3_000;

export type RouteState = "preparing" | "ready" | "probing" | "selected" | "transferring" | "complete" | "failed";
export type RouteStates = Partial<Record<TransferMethod, RouteState>>;

type CommonCallbacks = {
  onStatus?: (message: string) => void;
  onProgress?: (bytes: number, total: number) => void;
  onRoutes?: (states: RouteStates) => void;
};

export type SenderCallbacks = CommonCallbacks & {
  onHashProgress?: (bytes: number, total: number) => void;
  onPickup?: (pickup: { code: string; expiresAt: number }, offer: MultipathTransferOffer) => void;
};

export type ReceiverCallbacks = CommonCallbacks & {
  onFile?: (file: TransferFileManifest, mode: TransferMode | "legacy") => void;
};

export async function runMultipathSender({
  file,
  mode,
  signal,
  callbacks = {},
}: {
  file: File;
  mode: TransferMode;
  signal: AbortSignal;
  callbacks?: SenderCallbacks;
}) {
  const routeStates: RouteStates = {};
  const setRoute = (route: TransferMethod, state: RouteState) => {
    routeStates[route] = state;
    callbacks.onRoutes?.({ ...routeStates });
  };
  const senderSessions: WebRtcSenderSession[] = [];
  let sfuSession: SfuTransportSession | null = null;
  let r2Session: R2SenderSession | null = null;

  try {
    callbacks.onStatus?.("正在计算文件 SHA-256...");
    const sha256 = await sha256Blob(file, { signal, onProgress: callbacks.onHashProgress });
    throwIfAborted(signal);
    const transferId = crypto.randomUUID();
    const totalChunks = file.size === 0 ? 0 : Math.ceil(file.size / multipathChunkSize);

    for (const route of ["direct", "stun", "turn", "sfu", "r2"] as const) setRoute(route, "preparing");
    callbacks.onStatus?.("正在并行准备五条传输线路...");

    const prepareWebRtc = (route: "direct" | "stun" | "turn") => withRouteDeadline(
      signal,
      routePreparationTimeoutMs,
      `${routeLabel(route)} 准备`,
      async (routeSignal) => {
        let session: WebRtcSenderSession | null = null;
        try {
          const iceServers = route === "turn"
            ? await generateCloudflareTurnIceServers(3600, { signal: routeSignal })
            : undefined;
          session = createWebRtcSenderSession({ route, iceServers });
          senderSessions.push(session);
          const offer = await session.prepareOffer({ signal: routeSignal, timeoutMs: routePreparationTimeoutMs });
          return { session, offer };
        } catch (error) {
          session?.dispose();
          throw error;
        }
      },
    );
    const directOfferPromise = prepareWebRtc("direct");
    const stunOfferPromise = prepareWebRtc("stun");
    const turnPromise = prepareWebRtc("turn");
    const sfuPromise = withRouteDeadline(
      signal,
      routePreparationTimeoutMs,
      "SFU 准备",
      (routeSignal) => prepareSfuSender({ signal: routeSignal, timeoutMs: 5_000 }),
    ).then((session) => {
      sfuSession = session;
      return session;
    });
    const r2Promise = withRouteDeadline(
      signal,
      routePreparationTimeoutMs,
      "R2 准备",
      (routeSignal) => prepareR2Route({ file, signal: routeSignal }),
    ).then((session) => {
      r2Session = session;
      return session;
    });

    const [directResult, stunResult, turnResult, sfuResult, r2Result] = await Promise.all([
      settle(directOfferPromise), settle(stunOfferPromise), settle(turnPromise), settle(sfuPromise), settle(r2Promise),
    ]);
    const preparationErrors: Error[] = [];
    const preparedWebRtc: Array<{ session: WebRtcSenderSession; offer: WebRtcSignal }> = [];
    const routeOffers: TransferRouteOffer[] = [];
    if (directResult.ok) {
      preparedWebRtc.push(directResult.value);
      routeOffers.push({ kind: "direct", signal: directResult.value.offer });
      setRoute("direct", "ready");
    } else { preparationErrors.push(directResult.error); setRoute("direct", "failed"); }
    if (stunResult.ok) {
      preparedWebRtc.push(stunResult.value);
      routeOffers.push({ kind: "stun", signal: stunResult.value.offer });
      setRoute("stun", "ready");
    } else { preparationErrors.push(stunResult.error); setRoute("stun", "failed"); }
    if (turnResult.ok) {
      preparedWebRtc.push(turnResult.value);
      routeOffers.push({ kind: "turn", signal: turnResult.value.offer });
      setRoute("turn", "ready");
    } else { preparationErrors.push(turnResult.error); setRoute("turn", "failed"); }
    let preparedSfu = null as SfuSenderSession | null;
    if (sfuResult.ok) {
      preparedSfu = sfuResult.value;
      routeOffers.push({ kind: "sfu", descriptor: preparedSfu.descriptor as unknown as Record<string, unknown> });
      setRoute("sfu", "ready");
    } else { preparationErrors.push(sfuResult.error); setRoute("sfu", "failed"); }
    let preparedR2 = null as R2SenderSession | null;
    if (r2Result.ok) {
      preparedR2 = r2Result.value;
      routeOffers.push(preparedR2.route);
      setRoute("r2", "ready");
    } else { preparationErrors.push(r2Result.error); setRoute("r2", "failed"); }
    if (routeOffers.length === 0) throw new AggregateError(preparationErrors, "五条传输线路都无法准备。");

    const offer: MultipathTransferOffer = {
      kind: fileTransferProtocolKind,
      transferId,
      mode,
      createdAt: Date.now(),
      file: {
        id: crypto.randomUUID(),
        name: file.name,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
        sha256,
        chunkSize: multipathChunkSize,
        totalChunks,
      },
      routes: routeOffers,
    };

    callbacks.onStatus?.(`五路准备完成，${routeOffers.length} 条线路可用，正在生成取件码...`);
    const encodedOffer = await encodeTransferOffer(offer);
    const pickup = await createPickup(encodedOffer, signal, "multipath");
    callbacks.onPickup?.(pickup, offer);
    callbacks.onStatus?.("取件码已生成，等待接收方加入...");

    const encodedAnswer = await pollPickupAnswer(pickup.code, signal, pickup.expiresAt);
    const answer = await decodeTransferAnswer(encodedAnswer);
    if (answer.transferId !== transferId) throw new Error("接收端应答与当前文件不匹配。");
    callbacks.onStatus?.("接收方已加入，正在进行端到端测速...");

    const answers = new Map(answer.routes.map((route) => [route.kind, route]));
    const realtimeRoutes: RouteChannel[] = [];
    const connectPromises = preparedWebRtc.map(async ({ session }) => {
      const routeAnswer = answers.get(session.route);
      if (!routeAnswer || routeAnswer.kind === "sfu") throw new Error(`${session.route} 线路没有收到应答。`);
      await session.applyAnswer(routeAnswer.signal as WebRtcSignal, { signal });
      const channel = await withTimeout(session.waitForDataChannel({ signal }), 15_000, () => session.dispose());
      realtimeRoutes.push({ method: session.route, channel, dispose: () => session.dispose() });
    });
    const sfuAnswer = answers.get("sfu");
    if (preparedSfu && sfuAnswer?.kind === "sfu") {
      connectPromises.push(withTimeout(
        preparedSfu.acceptAnswer(
          sfuAnswer.descriptor as unknown as SfuReceiverDescriptor,
          { signal, timeoutMs: 15_000 },
        ),
        15_000,
        () => preparedSfu.dispose(),
      ).then((channel) => {
        realtimeRoutes.push({ method: "sfu", channel, dispose: () => preparedSfu.dispose() });
      }).catch((error) => {
        setRoute("sfu", "failed");
        throw error;
      }));
    } else if (preparedSfu) {
      preparedSfu.dispose();
      setRoute("sfu", "failed");
    }
    const connected = await Promise.allSettled(connectPromises);
    connected.forEach((result, index) => {
      if (result.status === "rejected" && index < preparedWebRtc.length) setRoute(preparedWebRtc[index].session.route, "failed");
    });
    if (realtimeRoutes.length === 0 && !r2Session) throw new Error("五条传输线路都无法连接。");

    realtimeRoutes.forEach((route) => setRoute(route.method, "probing"));
    const probeSettled = await Promise.allSettled(realtimeRoutes.map((route) => probeChannel(route, transferId, signal)));
    const probes: ProbeResult[] = [];
    probeSettled.forEach((result, index) => {
      if (result.status === "fulfilled") probes.push(result.value);
      else {
        setRoute(realtimeRoutes[index].method, "failed");
        void realtimeRoutes[index].dispose();
      }
    });
    const usableRealtimeRoutes = realtimeRoutes.filter((route) =>
      probes.some((probe) => probe.method === route.method),
    );
    const ranked = rankTransferRoutes(file.size, probes, answer, preparedR2);
    if (ranked.length === 0) throw new Error("没有可用的传输线路。");
    let winner: { route: TransferMethod; bytes: number; sha256: string } | undefined;
    if (mode === "turbo") {
      callbacks.onStatus?.("极速模式已启动：所有可用线路同时传输...");
      for (const route of usableRealtimeRoutes) setRoute(route.method, "transferring");
      if (preparedR2) setRoute("r2", "transferring");
      await setPickupSelection(pickup.code, ranked[0], signal);
      const childControllers = [...usableRealtimeRoutes, ...(preparedR2 ? [{ method: "r2" as const }] : [])].map(() => linkedAbortController(signal));
      const realtimeTasks = usableRealtimeRoutes.map((route, index) =>
        sendFileOnChannel({ route, offer, file, signal: childControllers[index].signal, onProgress: callbacks.onProgress })
          .finally(() => route.dispose()),
      );
      const startedMethods = new Set<TransferMethod>(usableRealtimeRoutes.map((route) => route.method));
      if (preparedR2) startedMethods.add("r2");
      const deliveryTasks: Promise<unknown>[] = [...realtimeTasks];
      const confirmationCandidates: Array<Promise<{ route: TransferMethod; bytes: number; sha256: string }>> = [];
      if (realtimeTasks.length) {
        confirmationCandidates.push(Promise.any(realtimeTasks).then((confirmation) => assertWinnerMatches({
          route: confirmation.route,
          bytes: confirmation.bytes,
          sha256: confirmation.sha256,
        }, offer, startedMethods)));
      }
      if (preparedR2) {
        const r2Controller = childControllers[childControllers.length - 1];
        deliveryTasks.push(uploadR2File({
          session: preparedR2,
          file,
          sha256,
          signal: r2Controller.signal,
          onProgress: callbacks.onProgress,
        }));
      }
      const coordinationController = linkedAbortController(signal);
      confirmationCandidates.push(
        pollPickupWinner(pickup.code, coordinationController.signal, pickup.expiresAt)
          .then((candidate) => assertWinnerMatches(candidate, offer, startedMethods)),
      );
      const allDeliveriesFailed = Promise.allSettled(deliveryTasks).then(async (results) => {
        if (results.some((result) => result.status === "fulfilled")) return neverSettles();
        // Give the receiver's HTTP winner confirmation a short path around a
        // DataChannel that closed immediately after the final disk write.
        await coordinationDelay(winnerRecoveryTimeoutMs, signal);
        throw new AggregateError(
          results.map((result) => result.status === "rejected" ? result.reason : undefined),
          "所有极速线路都失败了。",
        );
      });
      try {
        winner = await Promise.race([Promise.any(confirmationCandidates), allDeliveriesFailed]);
      } finally {
        coordinationController.abort(new DOMException("胜者确认已结束。", "AbortError"));
      }
      for (const controller of childControllers) controller.abort(new DOMException("已有线路完成。", "AbortError"));
      setRoute(winner.route, "complete");
      callbacks.onProgress?.(file.size, file.size);
      callbacks.onStatus?.(`传输完成，${routeLabel(winner.route)} 最先通过完整性校验。`);
    } else {
      const rankedRealtime = new Set(ranked.filter((method) => method !== "r2"));
      for (const route of usableRealtimeRoutes) {
        if (!rankedRealtime.has(route.method)) await route.dispose();
      }
      const failures: Error[] = [];
      const attemptedMethods = new Set<TransferMethod>();
      for (const method of ranked) {
        throwIfAborted(signal);
        attemptedMethods.add(method);
        setRoute(method, "selected");
        callbacks.onStatus?.(`已选择 ${routeLabel(method)}，正在传输文件...`);
        try {
          await setPickupSelection(pickup.code, method, signal);
          if (method === "r2") {
            if (!preparedR2) continue;
            await uploadR2File({ session: preparedR2, file, sha256, signal, onProgress: callbacks.onProgress });
            winner = assertWinnerMatches(
              await pollPickupWinner(pickup.code, signal, pickup.expiresAt),
              offer,
              new Set<TransferMethod>(["r2"]),
            );
            setRoute(winner.route, "complete");
            callbacks.onStatus?.("传输完成，文件完整性校验通过。");
            break;
          }
          const route = usableRealtimeRoutes.find((candidate) => candidate.method === method);
          if (!route) continue;
          setRoute(method, "transferring");
          const confirmation = await sendFileOnChannel({ route, offer, file, signal, onProgress: callbacks.onProgress });
          winner = { route: method, bytes: confirmation.bytes, sha256: confirmation.sha256 };
          setRoute(method, "complete");
          callbacks.onStatus?.(`传输完成，${routeLabel(method)} 完整性校验通过。`);
          break;
        } catch (error) {
          throwIfAborted(signal);
          if (isRemoteCancellation(error)) throw error;
          const recovered = await recoverVerifiedWinner(
            pickup.code,
            offer,
            attemptedMethods,
            signal,
            pickup.expiresAt,
          );
          if (recovered) {
            winner = recovered;
            setRoute(recovered.route, "complete");
            callbacks.onStatus?.(`传输完成，${routeLabel(recovered.route)} 已通过后端完整性确认。`);
            break;
          }
          const normalized = error instanceof Error ? error : new Error(`${method} 传输失败。`);
          failures.push(normalized);
          setRoute(method, "failed");
          const route = usableRealtimeRoutes.find((candidate) => candidate.method === method);
          await route?.dispose();
        }
      }
      if (!winner) throw new AggregateError(failures, "所有传输线路都失败了。");
    }

    await reportVerifiedTransferUsage({
      service: winner.route,
      bytes: winner.bytes,
      transferId: offer.transferId,
    });
    return { pickup, offer, winner };
  } finally {
    for (const session of senderSessions) session.dispose();
    (sfuSession as SfuTransportSession | null)?.dispose();
  }
}

export async function runMultipathReceiver({
  code,
  target,
  signal,
  preparedPickup,
  callbacks = {},
}: {
  code: string;
  target: ReceiveTarget;
  signal: AbortSignal;
  preparedPickup?: PickupPayload;
  callbacks?: ReceiverCallbacks;
}) {
  callbacks.onStatus?.("正在读取取件码...");
  const pickup = preparedPickup ?? await getPickup(code, signal);
  if (Date.now() >= pickup.expiresAt) throw new Error("这个取件码已经过期，请让发送方重新生成。");

  if (pickup.variant === "r2") {
    const descriptor = await decodeTransferDescriptor(pickup.offer);
    assertTargetCapacity(target, descriptor.file.size);
    callbacks.onFile?.(descriptor.file, "legacy");
    callbacks.onStatus?.("正在下载旧版 R2 文件并校验完整性...");
    const result = await downloadLegacyR2({ descriptor, target, signal, onProgress: callbacks.onProgress });
    return { file: descriptor.file, mode: "legacy" as const, winner: { route: "r2" as const, bytes: result.bytes, sha256: result.sha256 }, result };
  }
  if (pickup.variant !== "multipath") throw new Error("这个取件码使用了已停用的技术页面，请让发送方重新生成。");

  const offer = await decodeTransferOffer(pickup.offer);
  assertTargetCapacity(target, offer.file.size);
  callbacks.onFile?.(offer.file, offer.mode);
  callbacks.onStatus?.("正在并行连接五条传输线路...");

  const receiverSessions: WebRtcReceiverSession[] = [];
  let sfuSession: SfuTransportSession | null = null;
  const channelController = linkedAbortController(signal);
  const r2Controller = linkedAbortController(signal);
  const cancellationController = linkedAbortController(signal);
  let selectionController: AbortController | null = null;
  const receiver = new MultipathChannelReceiver(offer, target, channelController.signal, callbacks.onProgress);
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
      if (!result.ok) await receiver.markRouteUnavailable(route.kind, result.error);
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
    if (sfuResult && !sfuResult.ok) await receiver.markRouteUnavailable("sfu", sfuResult.error);
    if (preparedSfu) {
      sfuSession = preparedSfu;
      detach.push(receiver.attach({ method: "sfu", channel: preparedSfu.channel, dispose: preparedSfu.dispose }));
      routeAnswers.push({
        kind: "sfu",
        descriptor: preparedSfu.answerDescriptor as unknown as Record<string, unknown>,
      });
    }
    const r2Metric = r2MetricResult?.ok ? r2MetricResult.value : undefined;
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
      void streamR2FileWhenReady({
        route: r2Offer,
        expectedSize: offer.file.size,
        expectedSha256: offer.file.sha256,
        chunkSize: offer.file.chunkSize,
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
      startR2Route();
      if (readyWaits.length === 0 && !r2Offer) throw new Error("没有可用的传输线路。");
      result = await Promise.race([receiver.completion, remoteCancellation]);
    }

    selectionController?.abort(new DOMException("线路选择监听已结束。", "AbortError"));
    cancellationController.abort(new DOMException("取消状态监听已结束。", "AbortError"));
    const winner = { route: result.route, bytes: result.bytes, sha256: result.sha256 };
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

export async function inspectPickupFile(code: string, signal?: AbortSignal) {
  const pickup = await getPickup(code, signal);
  if (Date.now() >= pickup.expiresAt) throw new Error("这个取件码已经过期，请让发送方重新生成。");
  if (pickup.variant === "r2") {
    const descriptor = await decodeTransferDescriptor(pickup.offer);
    return { pickup, file: descriptor.file, mode: "legacy" as const };
  }
  if (pickup.variant !== "multipath") throw new Error("这个取件码使用了已停用的传输协议。");
  const offer = await decodeTransferOffer(pickup.offer);
  return { pickup, file: offer.file, mode: offer.mode };
}

export async function chooseInitialReceiveTarget(file?: Pick<TransferFileManifest, "name" | "size">) {
  if (typeof window !== "undefined" && "showSaveFilePicker" in window) {
    return chooseReceiveTargetForFile(file ?? { name: "接收文件", size: 0 });
  }
  if (file && file.size > memoryReceiveLimitBytes) return chooseReceiveTargetForFile(file);
  return { kind: "memory" } as ReceiveTarget;
}

export function rankTransferRoutes(
  fileSize: number,
  probes: ProbeResult[],
  answer: MultipathTransferAnswer,
  r2: R2SenderSession | null,
) {
  const scores = new Map<TransferMethod, number>();
  for (const result of probes) scores.set(result.method, estimateCompletionMs(fileSize, result));
  const r2Download = answer.metrics.r2;
  if (r2Download && r2) {
    const uploadBps = r2.route.probeSize * 1000 / r2.probeUploadElapsedMs;
    const downloadBps = r2Download.bytes * 1000 / r2Download.elapsedMs;
    scores.set(
      "r2",
      r2.probeUploadElapsedMs + fileSize / Math.max(1, uploadBps) * 1000 +
        r2Download.elapsedMs + fileSize / Math.max(1, downloadBps) * 1000,
    );
  } else if (r2) {
    scores.set("r2", Number.MAX_SAFE_INTEGER);
  }
  return [...scores.entries()].sort((left, right) => left[1] - right[1]).map(([route]) => route);
}

function linkedAbortController(parent: AbortSignal) {
  const controller = new AbortController();
  if (parent.aborted) controller.abort(parent.reason);
  else parent.addEventListener("abort", () => controller.abort(parent.reason), { once: true });
  return controller;
}

export async function withRouteDeadline<T>(
  parent: AbortSignal,
  milliseconds: number,
  label: string,
  work: (signal: AbortSignal) => Promise<T>,
) {
  const controller = linkedAbortController(parent);
  const timer = globalThis.setTimeout(() => {
    controller.abort(new DOMException(`${label}超时（${milliseconds}ms）。`, "TimeoutError"));
  }, milliseconds);
  try {
    return await work(controller.signal);
  } finally {
    globalThis.clearTimeout(timer);
  }
}

async function recoverVerifiedWinner(
  code: string,
  offer: MultipathTransferOffer,
  attemptedMethods: Set<TransferMethod>,
  signal: AbortSignal,
  pickupExpiresAt: number,
) {
  const controller = linkedAbortController(signal);
  const deadline = Math.min(pickupExpiresAt, Date.now() + winnerRecoveryTimeoutMs);
  try {
    const winner = await pollPickupWinner(code, controller.signal, deadline);
    return assertWinnerMatches(winner, offer, attemptedMethods);
  } catch (error) {
    throwIfAborted(signal);
    if (isRemoteCancellation(error) || error instanceof ApiError) throw error;
    return null;
  } finally {
    controller.abort(new DOMException("胜者恢复查询已结束。", "AbortError"));
  }
}

function isRemoteCancellation(error: unknown) {
  if (!(error instanceof Error)) return false;
  if (error.message.includes("取消传输") || error.message.includes("cancelled")) return true;
  return error.cause instanceof ApiError && error.cause.status === 410;
}

function neverSettles(): Promise<never> {
  return new Promise(() => undefined);
}

async function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error : new Error(String(error)) };
  }
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number, onTimeout: () => void) {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      onTimeout();
      reject(new Error(`线路连接超时（${milliseconds}ms）。`));
    }, milliseconds);
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function assertTargetCapacity(target: ReceiveTarget, fileSize: number) {
  if (target.kind === "memory" && fileSize > memoryReceiveLimitBytes) {
    throw new Error("当前浏览器无法流式保存这个大文件，请改用最新版 Chrome 或 Edge。");
  }
}

async function confirmPickupWinner(
  code: string,
  winner: { route: TransferMethod; bytes: number; sha256: string },
  signal: AbortSignal,
) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    throwIfAborted(signal);
    try {
      await setPickupWinner(code, winner, signal);
      return true;
    } catch (error) {
      if (error instanceof ApiError && (
        error.status === 400 || error.status === 403 || error.status === 404 ||
        error.status === 409 || error.status === 410
      )) throw error;
      lastError = error;
      await coordinationDelay(300 * 2 ** attempt, signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("无法通知发送端传输已完成。");
}

function coordinationDelay(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = window.setTimeout(done, milliseconds);
    const cancel = () => { window.clearTimeout(timer); signal.removeEventListener("abort", cancel); reject(signal.reason); };
    function done() { signal.removeEventListener("abort", cancel); resolve(); }
    signal.addEventListener("abort", cancel, { once: true });
  });
}

export function routeLabel(route: TransferMethod) {
  return ({ direct: "Direct", stun: "STUN", turn: "TURN", sfu: "SFU", r2: "R2" } as const)[route];
}

function assertWinnerMatches<T extends { route: TransferMethod; bytes: number; sha256: string }>(
  winner: T,
  offer: MultipathTransferOffer,
  startedMethods: Set<TransferMethod>,
) {
  if (!startedMethods.has(winner.route) || winner.bytes !== offer.file.size || winner.sha256.toLowerCase() !== offer.file.sha256) {
    throw new Error("接收端返回的胜者完整性信息与当前文件不一致。");
  }
  return winner;
}
