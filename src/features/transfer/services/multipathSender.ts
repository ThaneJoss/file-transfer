import { ApiError } from "../../../lib/api/client";
import { generateCloudflareTurnIceServers } from "../../turn/services/cloudflareTurn";
import { throwIfAborted } from "../hooks/useTransferLifecycle";
import {
  decodeTransferAnswer,
  encryptedFileTransferProtocolKind,
  encodeTransferOffer,
  fileTransferProtocolKind,
} from "../protocol/fileProtocol";
import type { TransferEncryptionContext } from "../crypto/fileEncryption";
import type {
  MultipathTransferOffer,
  TransferMethod,
  TransferMode,
  TransferRouteOffer,
} from "../protocol/fileProtocol";
import { sha256Blob } from "../protocol/fileStream";
import { prepareSfuSender } from "../transports/sfu";
import type {
  SfuReceiverDescriptor,
  SfuSenderSession,
  SfuTransportSession,
} from "../transports/sfu";
import { createWebRtcSenderSession } from "../transports/webrtc";
import type {
  WebRtcSenderSession,
  WebRtcSignal,
} from "../transports/webrtc";
import {
  probeChannel,
  sendFileOnChannel,
} from "./channelTransfer";
import type { ProbeResult, RouteChannel } from "./channelTransfer";
import {
  pollPickupAnswer,
  pollPickupWinner,
  publishPickupOffer,
  reservePickup,
  setPickupSelection,
} from "./pickupApi";
import {
  prepareR2Route,
  uploadR2File,
} from "./r2Transfer";
import type { R2SenderSession } from "./r2Transfer";
import { reportVerifiedTransferUsage } from "./transferUsage";
import {
  assertWinnerMatches,
  coordinationDelay,
  isRemoteCancellation,
  linkedAbortController,
  multipathChunkSize,
  neverSettles,
  rankTransferRoutes,
  routeLabel,
  routePreparationTimeoutMs,
  settle,
  winnerRecoveryTimeoutMs,
  withRouteDeadline,
  withTimeout,
} from "./multipathCoordinator";
import type { RouteState, RouteStates, SenderCallbacks } from "./multipathCoordinator";

export async function runMultipathSender({
  file,
  mode,
  signal,
  encryption,
  callbacks = {},
}: {
  file: File;
  mode: TransferMode;
  signal: AbortSignal;
  encryption?: TransferEncryptionContext | null;
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
    callbacks.onStatus?.("正在生成取件码...");
    const pickup = await reservePickup(signal, "multipath");
    callbacks.onPickup?.(pickup);
    callbacks.onStatus?.("取件码已生成，正在后台校验文件并准备线路...");
    throwIfAborted(signal);

    const transferId = crypto.randomUUID();
    const totalChunks = file.size === 0 ? 0 : Math.ceil(file.size / multipathChunkSize);

    for (const route of ["direct", "stun", "turn", "sfu", "r2"] as const) setRoute(route, "preparing");
    callbacks.onStatus?.("正在并行校验文件并准备五条传输线路...");

    const hashPromise = sha256Blob(file, { signal, onProgress: callbacks.onHashProgress });

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
      (routeSignal) => prepareR2Route({ file, signal: routeSignal, encryption }),
    ).then((session) => {
      r2Session = session;
      return session;
    });

    const [hashResult, directResult, stunResult, turnResult, sfuResult, r2Result] = await Promise.all([
      settle(hashPromise), settle(directOfferPromise), settle(stunOfferPromise), settle(turnPromise),
      settle(sfuPromise), settle(r2Promise),
    ]);
    if (!hashResult.ok) throw hashResult.error;
    const sha256 = hashResult.value;
    throwIfAborted(signal);
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
      kind: encryption ? encryptedFileTransferProtocolKind : fileTransferProtocolKind,
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
      ...(encryption ? { encryption: encryption.metadata } : {}),
    };

    callbacks.onStatus?.(`线路准备完成，${routeOffers.length} 条线路可用，正在发布线路信息...`);
    const encodedOffer = await encodeTransferOffer(offer);
    await publishPickupOffer(pickup.code, encodedOffer, signal);
    callbacks.onStatus?.("文件和线路已就绪，等待接收方加入...");

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
        sendFileOnChannel({
          route, offer, file, signal: childControllers[index].signal,
          onProgress: callbacks.onProgress, encryptionKey: encryption?.key,
        })
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
          const confirmation = await sendFileOnChannel({
            route, offer, file, signal, onProgress: callbacks.onProgress, encryptionKey: encryption?.key,
          });
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

