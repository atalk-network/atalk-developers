import { createHash, randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { basename, extname, resolve } from "node:path";
import {
  attachmentPartDescriptors,
  createChunkedAttachmentDescriptor,
  decryptMandateTerms,
  decryptWorkroomPayload,
  encryptAttachment,
  encryptAttachmentChunk,
  encryptWorkroomPayload,
  evaluateMandateUse,
  hashCanonical,
  mandateCommitmentMatchesEncryptedTerms,
  mandateCommitmentMatchesTerms,
  splitEncryptedAttachment,
  signWorkroomReceipt,
  resolveWorkroomRouting,
  validateWorkroomContentRouting,
  verifyMandate,
  verifyMandateCommitment,
  verifyMandateRevocation,
  verifyWorkroomApprovalDecision,
  workroomApprovalRequestPayloadSchema,
  workroomContentPayloadSchema,
  workroomDescriptorSchema,
  type AppendWorkroomEvent,
  type AttachmentDescriptor,
  type MandateUseDecision,
  type MandateUseRequest,
  type PublicPeer,
  type SignedMandate,
  type SignedMandateCommitment,
  type SignedMandateRevocation,
  type SignedWorkroomApprovalDecision,
  type SignedWorkroomReceipt,
  type Workroom,
  type WorkroomContentPayload,
  type WorkroomDescriptor,
  type WorkroomEncryptedEnvelope,
  type WorkroomMember,
  type WorkroomRoutingMatch,
  type WorkroomThread,
} from "@atalk/protocol";
import type { AgentCredentials } from "./credential-store.js";
import type {
  AgentAttachmentFileInput,
  AgentAttachmentInput,
  AttachmentTransferOptions,
} from "./agent.js";
import type { AgentRuntimeState, WorkroomMandateUsage } from "./runtime-state-store.js";

const MAX_PROCESSED_WORKROOM_EVENTS = 10_000;

interface WorkroomMembership extends WorkroomMember {
  id: string;
  workroomId: string;
  addedByPeerId: string;
  idempotencyKey: string;
}

interface WorkroomRecord extends Workroom {
  currentKeyEpoch: number;
  descriptorHash: string;
  idempotencyKey: string;
}

interface WorkroomThreadRecord extends WorkroomThread {
  headerHash?: string;
  idempotencyKey: string;
}

interface WorkroomMandateRecord {
  mandateId: string;
  revision: number;
  workroomId?: string;
  principalPeerId: string;
  actorPeerId: string;
  issuedByPeerId: string;
  validFrom: string;
  validUntil: string;
  termsHash: string;
  encryptedTermsHash: string;
  encryptedTermsEnvelope: Parameters<typeof decryptMandateTerms>[0]["envelope"];
  signedCommitment: SignedMandateCommitment;
  issuerSigningPublicKey: string;
}

interface WorkroomMandateView {
  mandate: WorkroomMandateRecord;
  revocation?: {
    signedRevocation: SignedMandateRevocation;
    revokerSigningPublicKey: string;
  };
}

interface WorkroomApprovalDecisionRecord {
  signedDecision: SignedWorkroomApprovalDecision;
  signingPublicKey: string;
}

interface WorkroomApprovalView {
  requestId: string;
  workroomId: string;
  sourceEventId: string;
  requestedByPeerId: string;
  requiredApprovals: number;
  eligiblePeerIds: string[];
  requestCiphertextHash: string;
  requestEnvelope: WorkroomEncryptedEnvelope;
  expiresAt?: string;
  status: "pending" | "approved" | "rejected" | "expired";
  decisions: WorkroomApprovalDecisionRecord[];
}

export interface WorkroomDetail {
  workroom: WorkroomRecord;
  /** Locally verified and decrypted; never returned in plaintext by the relay. */
  descriptor: WorkroomDescriptor;
  membership: WorkroomMembership;
  members: Array<{ membership: WorkroomMembership; peer: PublicPeer | null }>;
  threads: WorkroomThreadRecord[];
  latestMandates: WorkroomMandateView[];
  approvals: WorkroomApprovalView[];
  latestReceiptHash: string | null;
  events?: WorkroomEventRecord[];
  nextAfterSequence?: number | null;
}

interface WorkroomEventRecord {
  sequence: number;
  event: AppendWorkroomEvent;
  projection?: WorkroomEventProjection;
}

export interface DecryptedWorkroomEvent extends WorkroomEventRecord {
  actor: PublicPeer;
  content: WorkroomContentPayload;
  /** Exact autonomous context derived after canonical routing validation. */
  routing: WorkroomRoutingMatch;
  /** Compatibility alias for routing.directedToMe. */
  directedToMe: boolean;
}

export type WorkroomEventProjection =
  | { kind: "plan"; id: string; version: number }
  | { kind: "artifact_version"; id: string; artifactId: string; artifactVersion: number; attachmentIds: string[] }
  | { kind: "deliverable"; id: string; artifactId: string; artifactVersionId: string }
  | { kind: "cost"; id: string }
  | { kind: "approval_request"; id: string; requiredApprovals: number; eligiblePeerIds: string[]; expiresAt?: string };

export interface WorkroomPublishOptions {
  eventId?: string;
  idempotencyKey?: string;
  projection?: WorkroomEventProjection;
  maxAttempts?: number;
}

export interface WorkroomPollOptions {
  limit?: number;
  signal?: AbortSignal;
  maxAttempts?: number;
}

export interface WorkroomEventPage {
  events: DecryptedWorkroomEvent[];
  nextAfterSequence: number | null;
}

export interface MandatedActionInput {
  workroomId: string;
  threadId: string;
  /** UUID used to make approval requests, effects and receipts retry-safe. */
  operationId: string;
  mandateId?: string;
  action: string;
  rationale?: string;
  summary?: string;
  target?: { type: string; label: string; reference?: string };
  effect?: string;
  financialImpact?: { currency: string; amountMinor: number; kind: "exact" | "maximum" };
  dataCategories?: string[];
  participantPeerIds?: string[];
  tool?: MandateUseRequest["tool"];
  dataAccesses?: MandateUseRequest["dataAccesses"];
  spend?: MandateUseRequest["spend"];
  spendUsedMinorByLimit?: MandateUseRequest["spendUsedMinorByLimit"];
  volumeUsed?: MandateUseRequest["volumeUsed"];
  volumeDelta?: MandateUseRequest["volumeDelta"];
  delegationDepth?: number;
  principalApprovedDelegation?: boolean;
  metEndConditionIds?: string[];
}

export interface MandatedPublicationInput extends Omit<MandatedActionInput, "action"> {
  payload: WorkroomContentPayload;
  publish?: WorkroomPublishOptions;
}

export interface MandatedFilePublicationInput extends Omit<MandatedActionInput, "action" | "volumeDelta"> {
  path: string;
  name?: string;
  mimeType?: string;
  title?: string;
  description?: string;
  artifactType?: string;
  artifactId?: string;
  artifactVersion?: number;
  mentions?: Extract<WorkroomContentPayload, { kind: "artifact_version" }>["mentions"];
  transfer?: AttachmentTransferOptions;
}

export type MandateGuardResult =
  | { status: "permitted"; mandate: SignedMandate }
  | { status: "requires_approval"; decision: Extract<MandateUseDecision, { status: "requires_approval" }>; requestIds: string[] }
  | { status: "denied"; decision: Extract<MandateUseDecision, { status: "denied" }> };

export interface MandatedEffectResult<T> {
  value: T;
  costs?: Array<Extract<WorkroomContentPayload, { kind: "cost" }>>;
}

export type MandatedExecutionResult<T> =
  | { status: "executed"; value: T; receipt: SignedWorkroomReceipt }
  | Exclude<MandateGuardResult, { status: "permitted" }>;

interface WorkroomClientDependencies {
  request<T>(path: string, init?: RequestInit): Promise<T>;
  credentials(): AgentCredentials;
  runtimeState(): AgentRuntimeState;
  mutateRuntimeState(mutator: (state: AgentRuntimeState) => void): Promise<void>;
  uploadPart(
    scope: { workroomId: string },
    id: string,
    bytes: Uint8Array,
    transfer?: AttachmentTransferOptions,
  ): Promise<void>;
  deletePart(id: string): Promise<void>;
  downloadAttachment(descriptor: AttachmentDescriptor): Promise<Uint8Array>;
  downloadAttachmentTo(
    descriptor: AttachmentDescriptor,
    path: string,
    transfer?: AttachmentTransferOptions,
  ): Promise<string>;
}

/** E2EE task client. The relay sees signed ciphertext and routing projections only. */
export class WorkroomClient {
  private executionTail: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: WorkroomClientDependencies) {}

  async list(cursor?: string, limit = 50): Promise<{ workrooms: WorkroomDetail[]; nextCursor: string | null }> {
    const query = new URLSearchParams({ limit: String(Math.max(1, Math.min(limit, 200))) });
    if (cursor) query.set("cursor", cursor);
    const page = await this.retry<{ workrooms: WorkroomDetail[]; nextCursor: string | null }>(
      () => this.dependencies.request(`/v1/workrooms?${query}`),
      3,
    );
    return { ...page, workrooms: page.workrooms.map((detail) => this.openDetail(detail)) };
  }

  async get(workroomId: string, afterSequence = 0, eventLimit = 100): Promise<WorkroomDetail> {
    const query = new URLSearchParams({
      afterSequence: String(Math.max(0, afterSequence)),
      eventLimit: String(Math.max(1, Math.min(eventLimit, 200))),
    });
    const detail = await this.retry<WorkroomDetail>(
      () => this.dependencies.request(`/v1/workrooms/${encodeURIComponent(workroomId)}?${query}`),
      3,
    );
    return this.openDetail(detail);
  }

  /**
   * Polls from the last durably acknowledged sequence and invokes the agent
   * handler only for events explicitly directed to this identity. Undirected
   * events are still authenticated and consumed so shared Task conversation
   * traffic cannot accidentally start a model turn. A handler failure does not
   * advance the cursor, so the same directed event is retried after restart.
   */
  async poll(
    workroomId: string,
    handler: (event: DecryptedWorkroomEvent) => void | Promise<void>,
    options: WorkroomPollOptions = {},
  ): Promise<number> {
    let cursor = this.dependencies.runtimeState().workroomCursors?.[workroomId] ?? 0;
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    do {
      throwIfAborted(options.signal);
      const page = await this.readEventPage(
        workroomId,
        cursor,
        limit,
        options.maxAttempts ?? 3,
        options.signal,
      );
      for (const decrypted of page.events) {
        throwIfAborted(options.signal);
        const record = decrypted;
        const alreadyHandled = this.dependencies.runtimeState().processedWorkroomEvents?.[record.event.eventId];
        if (!alreadyHandled && decrypted.directedToMe) await handler(autonomousEventView(decrypted));
        cursor = record.sequence;
        await this.dependencies.mutateRuntimeState((state) => {
          state.workroomCursors ??= {};
          state.processedWorkroomEvents ??= {};
          state.workroomCursors[workroomId] = cursor;
          state.processedWorkroomEvents[record.event.eventId] = true;
          const ids = Object.keys(state.processedWorkroomEvents);
          for (let index = 0; index < ids.length - MAX_PROCESSED_WORKROOM_EVENTS; index += 1) {
            delete state.processedWorkroomEvents[ids[index]!];
          }
        });
      }
      if (page.nextAfterSequence === null || page.events.length === 0) return cursor;
    } while (true);
  }

  /**
   * Reads every authenticated event without advancing the autonomous handler
   * cursor. This is the explicit operator/audit surface; never use it as a
   * model-trigger loop because it includes traffic addressed to other agents.
   */
  async readAuditEvents(
    workroomId: string,
    afterSequence = 0,
    limit = 100,
    signal?: AbortSignal,
  ): Promise<WorkroomEventPage> {
    return this.readEventPage(workroomId, afterSequence, limit, 3, signal);
  }

  /** Long-polls using the durable cursor until aborted. */
  async watch(
    workroomId: string,
    handler: (event: DecryptedWorkroomEvent) => void | Promise<void>,
    options: WorkroomPollOptions & { intervalMs?: number } = {},
  ): Promise<void> {
    while (!options.signal?.aborted) {
      await this.poll(workroomId, handler, options);
      await abortableDelay(Math.max(250, options.intervalMs ?? 2_000), options.signal);
    }
  }

  async publish(
    workroomId: string,
    threadId: string,
    candidate: WorkroomContentPayload,
    options: WorkroomPublishOptions = {},
  ): Promise<WorkroomEventRecord> {
    const prepared = prepareContentAndProjection(workroomContentPayloadSchema.parse(candidate), options.projection);
    const content = prepared.content;
    if ((content.kind === "message" || content.kind === "activity") && content.threadId !== threadId) {
      throw new Error("WORKROOM_THREAD_MISMATCH");
    }
    const credentials = this.dependencies.credentials();
    const detail = await this.get(workroomId, 0, 1);
    const activePeers = exactActiveMemberPeers(detail);
    validateWorkroomContentRouting(content, activePeers.map(routingPeer), credentials.peer.id);
    const recipients = activePeers.map(({ id, encryptionPublicKey }) => ({ peerId: id, encryptionPublicKey }));
    if (!recipients.some(({ peerId }) => peerId === credentials.peer.id)) throw new Error("WORKROOM_MEMBERSHIP_REQUIRED");
    if (detail.membership.role === "observer") throw new Error("WORKROOM_READ_ONLY");
    const now = new Date().toISOString();
    const eventId = options.eventId ?? randomUUID();
    const envelope = encryptWorkroomPayload({
      envelopeId: eventId,
      workroomId,
      senderPeerId: credentials.peer.id,
      keyEpoch: detail.workroom.currentKeyEpoch,
      payload: content,
      senderSigningSecretKey: credentials.keys.signingSecretKey,
      senderEncryptionSecretKey: credentials.keys.encryptionSecretKey,
      recipients,
      createdAt: now,
    });
    const event: AppendWorkroomEvent = {
      eventId,
      workroomId,
      threadId,
      actorPeerId: credentials.peer.id,
      kind: content.kind,
      envelope,
      idempotencyKey: options.idempotencyKey ?? `event-${eventId}`,
      createdAt: now,
    };
    const projection = prepared.projection;
    const body = { event, ...(projection ? { projection } : {}) };
    const result = await this.retry<{ record: WorkroomEventRecord }>(
      () => this.dependencies.request(`/v1/workrooms/${encodeURIComponent(workroomId)}/events`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
      options.maxAttempts ?? 3,
    );
    return result.record;
  }

  message(workroomId: string, threadId: string, body: string, mentions: Extract<WorkroomContentPayload, { kind: "message" }>["mentions"] = []) {
    return this.publish(workroomId, threadId, { version: 1, kind: "message", threadId, body, mentions });
  }

  activity(
    workroomId: string,
    threadId: string,
    activityType: string,
    summary: string,
    mentions: Extract<WorkroomContentPayload, { kind: "activity" }>["mentions"] = [],
  ) {
    return this.publish(workroomId, threadId, {
      version: 1,
      kind: "activity",
      threadId,
      activityType,
      summary,
      mentions,
      sourceEventIds: [],
      attributes: {},
    });
  }

  plan(
    workroomId: string,
    threadId: string,
    payload: Omit<Extract<WorkroomContentPayload, { kind: "plan" }>, "version" | "kind">,
    options?: WorkroomPublishOptions,
  ) {
    return this.publish(workroomId, threadId, { version: 1, kind: "plan", ...payload }, options);
  }

  artifactVersion(
    workroomId: string,
    threadId: string,
    payload: Omit<Extract<WorkroomContentPayload, { kind: "artifact_version" }>, "version" | "kind">,
    options?: WorkroomPublishOptions,
  ) {
    return this.publish(workroomId, threadId, { version: 1, kind: "artifact_version", ...payload }, options);
  }

  deliverable(
    workroomId: string,
    threadId: string,
    payload: Omit<Extract<WorkroomContentPayload, { kind: "deliverable" }>, "version" | "kind">,
    options?: WorkroomPublishOptions,
  ) {
    return this.publish(workroomId, threadId, { version: 1, kind: "deliverable", ...payload }, options);
  }

  /**
   * Preferred publication boundary for agent runtimes. It derives the same
   * action names as the app, checks the current signed mandate twice, and
   * records durable counters plus a signed receipt after publication.
   */
  async publishMandated(input: MandatedPublicationInput): Promise<MandatedExecutionResult<WorkroomEventRecord>> {
    const content = workroomContentPayloadSchema.parse(input.payload);
    if (content.kind === "cost") throw new Error("WORKROOM_COST_MUST_BE_DERIVED_FROM_AN_EXECUTED_ACTION");
    if (content.kind === "approval_request") {
      throw new Error("WORKROOM_APPROVAL_REQUESTS_ARE_CREATED_BY_THE_MANDATE_GUARD");
    }
    const detail = await this.get(input.workroomId, 0, 1);
    const participantPeerIds = activePeerIds(detail);
    const action = defaultWorkroomAction(content.kind);
    const volumeDelta = payloadVolume(content);
    const dataAccesses = input.dataAccesses ?? (content.kind === "artifact_version"
      ? [{
          resource: "workroom.attachments",
          permission: "write" as const,
          recipientPeerIds: participantPeerIds,
          classification: "workroom",
        }]
      : []);
    return this.executeMandatedAction({
      ...input,
      action,
      participantPeerIds: input.participantPeerIds ?? participantPeerIds,
      dataAccesses,
      volumeDelta: input.volumeDelta ?? volumeDelta,
      summary: input.summary?.trim() || publicationSummary(content),
      effect: input.effect?.trim() || publicationEffect(content),
    }, async () => ({
      value: await this.publish(input.workroomId, input.threadId, content, {
        ...input.publish,
        eventId: input.publish?.eventId ?? deterministicUuid(`${input.operationId}:event`),
        idempotencyKey: input.publish?.idempotencyKey ?? `operation-${input.operationId}`,
      }),
    }));
  }

  /** Permission-aware local decryption for files supplied to an external agent. */
  async downloadAttachmentToMandated(input: Omit<MandatedActionInput, "action"> & {
    descriptor: AttachmentDescriptor;
    path: string;
    transfer?: AttachmentTransferOptions;
  }): Promise<MandatedExecutionResult<string>> {
    const detail = await this.get(input.workroomId, 0, 1);
    const participantPeerIds = activePeerIds(detail);
    return this.executeMandatedAction({
      ...input,
      action: "file.read",
      participantPeerIds: input.participantPeerIds ?? participantPeerIds,
      dataAccesses: input.dataAccesses ?? [{
        resource: "workroom.attachments",
        permission: "read",
        recipientPeerIds: [],
        classification: "workroom",
      }],
      volumeDelta: input.volumeDelta ?? {
        messages: 0, files: 1, totalBytes: input.descriptor.size, actions: 1, custom: {},
      },
      summary: input.summary?.trim() || `Read ${input.descriptor.name}`,
      effect: input.effect?.trim() || "Decrypt one Task file inside the configured agent runtime",
    }, async () => ({
      value: await this.downloadAttachmentTo(input.descriptor, input.path, input.transfer),
    }));
  }

  /** Guard, upload and publish one encrypted Task file as a single runtime operation. */
  async submitFileMandated(
    input: MandatedFilePublicationInput,
  ): Promise<MandatedExecutionResult<{
    descriptor: AttachmentDescriptor;
    artifactId: string;
    artifactVersion: number;
    artifactVersionId: string;
    record: WorkroomEventRecord;
  }>> {
    const path = resolve(input.path);
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error("ATTACHMENT_NOT_A_FILE");
    const detail = await this.get(input.workroomId, 0, 1);
    const participantPeerIds = activePeerIds(detail);
    const name = input.name?.trim() || basename(path);
    return this.executeMandatedAction({
      ...input,
      action: "file.create",
      participantPeerIds: input.participantPeerIds ?? participantPeerIds,
      dataAccesses: input.dataAccesses ?? [{
        resource: "workroom.attachments",
        permission: "write",
        recipientPeerIds: participantPeerIds,
        classification: "workroom",
      }],
      volumeDelta: { messages: 0, files: 1, totalBytes: metadata.size, actions: 1, custom: {} },
      summary: input.summary?.trim() || `Add file: ${input.title?.trim() || name}`,
      effect: input.effect?.trim() || "Encrypt and share one file with every current Task participant",
    }, async () => {
      const descriptor = await this.uploadAttachmentFile({
        workroomId: input.workroomId,
        path,
        name,
        ...(input.mimeType ? { mimeType: input.mimeType } : {}),
        ...(input.transfer ? { transfer: input.transfer } : {}),
      });
      try {
        const artifactId = input.artifactId ?? deterministicUuid(`${input.operationId}:artifact`);
        const artifactVersion = input.artifactVersion ?? 1;
        const artifactVersionId = deterministicUuid(`${input.operationId}:artifact-version`);
        const record = await this.artifactVersion(input.workroomId, input.threadId, {
          artifactId,
          artifactVersion,
          artifactVersionId,
          artifactType: input.artifactType ?? "file",
          title: input.title?.trim() || name,
          ...(input.description?.trim() ? { description: input.description.trim() } : {}),
          mediaType: descriptor.mimeType,
          fileName: descriptor.name,
          attachmentIds: [descriptor.id],
          attachments: [descriptor],
          contentHash: await hashFile(path),
          mentions: input.mentions ?? [],
        }, {
          eventId: deterministicUuid(`${input.operationId}:artifact-event`),
          idempotencyKey: `artifact-${input.operationId}`,
        });
        return { value: { descriptor, artifactId, artifactVersion, artifactVersionId, record } };
      } catch (error) {
        await Promise.allSettled(attachmentPartDescriptors(descriptor).map(({ id }) => this.dependencies.deletePart(id)));
        throw error;
      }
    });
  }

  async uploadAttachment(input: AgentAttachmentInput & { workroomId: string }): Promise<AttachmentDescriptor> {
    const encrypted = splitEncryptedAttachment(encryptAttachment({
      id: randomUUID(),
      bytes: input.data,
      name: input.name,
      mimeType: input.mimeType ?? "application/octet-stream",
    }), randomUUID);
    try {
      for (const part of encrypted.parts) {
        await this.dependencies.uploadPart({ workroomId: input.workroomId }, part.id, part.ciphertext);
      }
      return encrypted.descriptor;
    } catch (error) {
      await Promise.allSettled(encrypted.parts.map(({ id }) => this.dependencies.deletePart(id)));
      throw error;
    }
  }

  async uploadAttachmentFile(input: AgentAttachmentFileInput & { workroomId: string }): Promise<AttachmentDescriptor> {
    const path = resolve(input.path);
    const metadata = await stat(path);
    if (!metadata.isFile()) throw new Error("ATTACHMENT_NOT_A_FILE");
    const descriptor = createChunkedAttachmentDescriptor({
      id: randomUUID(),
      size: metadata.size,
      name: input.name?.trim() || basename(path),
      mimeType: input.mimeType?.trim() || mimeTypeFromPath(path),
      nextId: randomUUID,
    });
    if (descriptor.version !== 2) throw new Error("ATTACHMENT_VERSION_UNSUPPORTED");
    const file = await open(path, "r");
    let transferred = 0;
    try {
      for (let index = 0; index < descriptor.chunks.length; index += 1) {
        throwIfAborted(input.transfer?.signal);
        const part = descriptor.chunks[index]!;
        const plaintext = new Uint8Array(part.plaintextSize);
        const { bytesRead } = await file.read(plaintext, 0, plaintext.byteLength, transferred);
        if (bytesRead !== plaintext.byteLength) throw new Error("ATTACHMENT_SIZE_MISMATCH");
        await this.dependencies.uploadPart(
          { workroomId: input.workroomId },
          part.id,
          encryptAttachmentChunk(plaintext, descriptor, index),
          input.transfer,
        );
        transferred += bytesRead;
        input.transfer?.onProgress?.({
          phase: "UPLOADING",
          bytesTransferred: transferred,
          totalBytes: descriptor.size,
          partIndex: index + 1,
          partCount: descriptor.chunks.length,
        });
      }
      return descriptor;
    } catch (error) {
      await Promise.allSettled(attachmentPartDescriptors(descriptor).map(({ id }) => this.dependencies.deletePart(id)));
      throw error;
    } finally {
      await file.close();
    }
  }

  downloadAttachment(descriptor: AttachmentDescriptor): Promise<Uint8Array> {
    return this.dependencies.downloadAttachment(descriptor);
  }

  downloadAttachmentTo(descriptor: AttachmentDescriptor, path: string, transfer?: AttachmentTransferOptions): Promise<string> {
    return this.dependencies.downloadAttachmentTo(descriptor, path, transfer);
  }

  async guardMandateUse(input: MandatedActionInput, createApproval = true): Promise<MandateGuardResult> {
    const credentials = this.dependencies.credentials();
    const detail = await this.get(input.workroomId, 0, 1);
    const workroomEnded = workroomStopReason(detail.workroom);
    if (workroomEnded) {
      return { status: "denied", decision: { status: "denied", code: "MANDATE_ENDED", detail: workroomEnded } };
    }
    const view = detail.latestMandates
      .filter(({ mandate }) => mandate.actorPeerId === credentials.peer.id && (!input.mandateId || mandate.mandateId === input.mandateId))
      .sort((left, right) => right.mandate.revision - left.mandate.revision)[0];
    if (!view) return { status: "denied", decision: { status: "denied", code: "MANDATE_MISMATCH" } };
    const signedMandate = this.openMandate(view, detail);
    if (view.revocation) {
      verifyRevocation(view.revocation, detail);
      return { status: "denied", decision: { status: "denied", code: "MANDATE_ENDED", detail: "revoked" } };
    }
    const verifiedApprovals = await this.verifiedApprovals(detail, signedMandate, input);
    const request = mandateUseRequest(
      this.withDurableUsage(input, signedMandate),
      signedMandate,
      credentials.peer.id,
      verifiedApprovals,
    );
    const decision = evaluateMandateUse(signedMandate.mandate, request);
    if (decision.status === "denied") return { status: "denied", decision };
    if (decision.status === "permitted") return { status: "permitted", mandate: signedMandate };
    const requestIds = createApproval
      ? await this.ensureApprovalRequests(detail, signedMandate, input, decision)
      : [];
    return { status: "requires_approval", decision, requestIds };
  }

  /**
   * Revalidates immediately before the callback. Callbacks must use operationId
   * as their external idempotency key so a crash cannot duplicate side effects.
   */
  async executeMandatedAction<T>(
    input: MandatedActionInput,
    effect: (context: { operationId: string; mandate: SignedMandate }) => Promise<MandatedEffectResult<T>>,
  ): Promise<MandatedExecutionResult<T>> {
    return this.serializedExecution(async () => {
      const initial = await this.guardMandateUse(input, true);
      if (initial.status !== "permitted") return initial;
      const immediatelyBeforeEffect = await this.guardMandateUse(input, false);
      if (immediatelyBeforeEffect.status !== "permitted") return immediatelyBeforeEffect;
      const effectResult = await effect({ operationId: input.operationId, mandate: immediatelyBeforeEffect.mandate });
      await this.recordDurableUsage(input, immediatelyBeforeEffect.mandate);
      for (let index = 0; index < (effectResult.costs?.length ?? 0); index += 1) {
        const cost = effectResult.costs![index]!;
        await this.publish(input.workroomId, input.threadId, cost, {
          eventId: deterministicUuid(`${input.operationId}:cost:${index}`),
          idempotencyKey: `cost-${input.operationId}-${index}`,
        });
      }
      const receipt = await this.appendExecutionReceipt(input, effectResult);
      return { status: "executed", value: effectResult.value, receipt };
    });
  }

  private openDetail(detail: WorkroomDetail): WorkroomDetail {
    const credentials = this.dependencies.credentials();
    const envelope = detail.workroom.descriptorEnvelope;
    if (detail.workroom.descriptorHash !== hashCanonical(envelope)) throw new Error("WORKROOM_DESCRIPTOR_HASH_MISMATCH");
    const sender = requiredPeer(detail, envelope.senderPeerId);
    const descriptor = workroomDescriptorSchema.parse(decryptWorkroomPayload({
      envelope,
      recipientPeerId: credentials.peer.id,
      recipientEncryptionSecretKey: credentials.keys.encryptionSecretKey,
      senderEncryptionPublicKey: sender.encryptionPublicKey,
      senderSigningPublicKey: sender.signingPublicKey,
    }));
    return { ...detail, descriptor };
  }

  private async decryptEvent(record: WorkroomEventRecord, detail: WorkroomDetail): Promise<DecryptedWorkroomEvent> {
    const credentials = this.dependencies.credentials();
    const actor = detail.members.find(({ membership }) => membership.peerId === record.event.actorPeerId)?.peer
      ?? await this.dependencies.request<PublicPeer>(`/v1/peers/${record.event.actorPeerId}/keys`);
    if (!actor) throw new Error("WORKROOM_EVENT_ACTOR_MISSING");
    const content = workroomContentPayloadSchema.parse(decryptWorkroomPayload({
      envelope: record.event.envelope,
      recipientPeerId: credentials.peer.id,
      recipientEncryptionSecretKey: credentials.keys.encryptionSecretKey,
      senderEncryptionPublicKey: actor.encryptionPublicKey,
      senderSigningPublicKey: actor.signingPublicKey,
    }));
    if (content.kind !== record.event.kind) throw new Error("WORKROOM_EVENT_KIND_MISMATCH");
    if ((content.kind === "message" || content.kind === "activity")
      && content.threadId !== record.event.threadId) {
      throw new Error("WORKROOM_THREAD_MISMATCH");
    }
    validateWorkroomContentRouting(content, exactActiveMemberPeers(detail).map(routingPeer), record.event.actorPeerId);
    validateProjectionBinding(record.projection, content);
    const routing = resolveWorkroomRouting(content, credentials.peer.id, record.event.actorPeerId);
    return {
      ...record,
      actor,
      content,
      routing,
      directedToMe: routing.directedToMe,
    };
  }

  private async readEventPage(
    workroomId: string,
    afterSequence: number,
    limit: number,
    maxAttempts: number,
    signal?: AbortSignal,
  ): Promise<WorkroomEventPage> {
    const cursor = Number.isSafeInteger(afterSequence) && afterSequence >= 0 ? afterSequence : 0;
    const pageSize = Math.max(1, Math.min(Number.isSafeInteger(limit) ? limit : 100, 500));
    const query = new URLSearchParams({ afterSequence: String(cursor), limit: String(pageSize) });
    const page = await this.retry<{ events: WorkroomEventRecord[]; nextAfterSequence: number | null }>(
      () => this.dependencies.request(`/v1/workrooms/${encodeURIComponent(workroomId)}/events?${query}`),
      maxAttempts,
      signal,
    );
    const detail = await this.get(workroomId, cursor, 1);
    const events: DecryptedWorkroomEvent[] = [];
    for (const record of page.events) {
      throwIfAborted(signal);
      events.push(await this.decryptEvent(record, detail));
    }
    return { events, nextAfterSequence: page.nextAfterSequence };
  }

  private openMandate(view: WorkroomMandateView, detail: WorkroomDetail): SignedMandate {
    const credentials = this.dependencies.credentials();
    const issuer = requiredPeer(detail, view.mandate.issuedByPeerId);
    if (issuer.signingPublicKey !== view.mandate.issuerSigningPublicKey) throw new Error("MANDATE_ISSUER_KEY_CHANGED");
    if (!verifyMandateCommitment(view.mandate.signedCommitment, issuer.signingPublicKey)
      || !mandateCommitmentMatchesEncryptedTerms(view.mandate.signedCommitment, view.mandate.encryptedTermsEnvelope)) {
      throw new Error("INVALID_MANDATE_COMMITMENT");
    }
    const signed = decryptMandateTerms({
      envelope: view.mandate.encryptedTermsEnvelope,
      recipientPeerId: credentials.peer.id,
      recipientEncryptionSecretKey: credentials.keys.encryptionSecretKey,
      senderEncryptionPublicKey: issuer.encryptionPublicKey,
      senderSigningPublicKey: issuer.signingPublicKey,
    });
    if (!verifyMandate(signed, issuer.signingPublicKey)
      || !mandateCommitmentMatchesTerms(view.mandate.signedCommitment, signed)
      || signed.mandate.workroomId !== detail.workroom.id) {
      throw new Error("INVALID_MANDATE_TERMS");
    }
    return signed;
  }

  private async verifiedApprovals(
    detail: WorkroomDetail,
    signed: SignedMandate,
    input: MandatedActionInput,
  ): Promise<MandateUseRequest["verifiedApprovals"]> {
    const credentials = this.dependencies.credentials();
    const evidence: MandateUseRequest["verifiedApprovals"] = [];
    for (const threshold of signed.mandate.approvalThresholds) {
      const decisionIds: string[] = [];
      const approverPeerIds = new Set<string>();
      for (const approval of detail.approvals) {
        const expectedRequestId = approvalRequestId(input, signed, threshold.id);
        if (approval.requestId !== expectedRequestId) continue;
        if (approval.status !== "approved" || approval.requestCiphertextHash !== approval.requestEnvelope.ciphertextHash) continue;
        if (approval.expiresAt && Date.now() >= Date.parse(approval.expiresAt)) continue;
        const requester = requiredPeer(detail, approval.requestedByPeerId);
        const payload = workroomApprovalRequestPayloadSchema.parse(decryptWorkroomPayload({
          envelope: approval.requestEnvelope,
          recipientPeerId: credentials.peer.id,
          recipientEncryptionSecretKey: credentials.keys.encryptionSecretKey,
          senderEncryptionPublicKey: requester.encryptionPublicKey,
          senderSigningPublicKey: requester.signingPublicKey,
        }));
        if (payload.requestId !== approval.requestId
          || payload.thresholdId !== threshold.id
          || approval.requestEnvelope.envelopeId !== approval.sourceEventId
          || approval.requestEnvelope.workroomId !== approval.workroomId
          || approval.requestEnvelope.senderPeerId !== approval.requestedByPeerId
          || approval.requestedByPeerId !== credentials.peer.id
          || payload.action !== input.action || payload.mandateId !== signed.mandate.mandateId
          || !approvalRequestPayloadMatchesInput(payload, input)
          || payload.requiredApprovals !== threshold.requiredApprovals
          || !sameSet(payload.requestedApproverPeerIds, threshold.approverPeerIds)
          || !sameSet(approval.eligiblePeerIds, threshold.approverPeerIds)
          || (payload.expiresAt ?? undefined) !== (approval.expiresAt ?? undefined)) continue;
        for (const record of approval.decisions) {
          const decision = record.signedDecision.decision;
          const signer = detail.members.find(({ membership }) => membership.peerId === decision.decidedByPeerId)?.peer;
          if (!signer || signer.signingPublicKey !== record.signingPublicKey
            || !approval.eligiblePeerIds.includes(signer.id)
            || decision.requestId !== approval.requestId
            || decision.workroomId !== detail.workroom.id
            || decision.requestCiphertextHash !== approval.requestCiphertextHash
            || decision.decision !== "approve"
            || (approval.expiresAt !== undefined && Date.parse(decision.decidedAt) >= Date.parse(approval.expiresAt))
            || !verifyWorkroomApprovalDecision(record.signedDecision, signer.signingPublicKey)) continue;
          decisionIds.push(decision.decisionId);
          approverPeerIds.add(signer.id);
        }
      }
      if (approverPeerIds.size >= threshold.requiredApprovals) {
        evidence.push({ thresholdId: threshold.id, decisionIds, approverPeerIds: [...approverPeerIds] });
      }
    }
    return evidence;
  }

  private async ensureApprovalRequests(
    detail: WorkroomDetail,
    signed: SignedMandate,
    input: MandatedActionInput,
    decision: Extract<MandateUseDecision, { status: "requires_approval" }>,
  ): Promise<string[]> {
    const thresholds = decision.reason === "DELEGATION"
      ? [{ id: "delegation", requiredApprovals: 1, approverPeerIds: [signed.mandate.principalPeerId] }]
      : signed.mandate.approvalThresholds.filter(({ id }) => decision.thresholdIds.includes(id));
    const requestIds: string[] = [];
    if (!input.summary?.trim() || !input.effect?.trim()) {
      throw new Error("APPROVAL_INFORMED_CONSENT_REQUIRED: summary and effect are required");
    }
    if (isPurchaseAction(input.action) && !input.financialImpact) {
      throw new Error("APPROVAL_FINANCIAL_IMPACT_REQUIRED");
    }
    for (const threshold of thresholds) {
      const requestId = approvalRequestId(input, signed, threshold.id);
      requestIds.push(requestId);
      if (detail.approvals.some((approval) => approval.requestId === requestId && approval.status === "pending")) continue;
      await this.publish(input.workroomId, input.threadId, {
        version: 1,
        kind: "approval_request",
        requestId,
        thresholdId: threshold.id,
        action: input.action,
        rationale: input.rationale?.trim() || `Approve ${input.action}`,
        summary: input.summary.trim(),
        ...(input.target ? { target: input.target } : {}),
        effect: input.effect.trim(),
        ...(input.financialImpact ? { financialImpact: input.financialImpact } : {}),
        dataCategories: input.dataCategories ?? [],
        mandateId: signed.mandate.mandateId,
        relatedEventIds: [],
        requestedApproverPeerIds: threshold.approverPeerIds,
        requiredApprovals: threshold.requiredApprovals,
      }, {
        eventId: deterministicUuid(`${requestId}:event`),
        idempotencyKey: `approval-${requestId}`,
        projection: {
          kind: "approval_request",
          id: requestId,
          requiredApprovals: threshold.requiredApprovals,
          eligiblePeerIds: threshold.approverPeerIds,
        },
      });
    }
    return requestIds;
  }

  private async appendExecutionReceipt<T>(input: MandatedActionInput, result: MandatedEffectResult<T>): Promise<SignedWorkroomReceipt> {
    const credentials = this.dependencies.credentials();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const detail = await this.get(input.workroomId, 0, 1);
      const receipt = signWorkroomReceipt({
        version: 1,
        receiptId: deterministicUuid(`${input.operationId}:receipt`),
        workroomId: input.workroomId,
        actorPeerId: credentials.peer.id,
        signingPublicKey: credentials.peer.signingPublicKey,
        event: result.costs?.length ? "cost_recorded" : "event_appended",
        idempotencyKey: `effect-${input.operationId}`,
        payloadHash: hashCanonical({ operationId: input.operationId, action: input.action, result: result.value, costs: result.costs ?? [] }),
        previousReceiptHash: detail.latestReceiptHash,
        outcome: "recorded",
        occurredAt: new Date().toISOString(),
      }, credentials.keys.signingSecretKey);
      try {
        await this.dependencies.request(`/v1/workrooms/${encodeURIComponent(input.workroomId)}/receipts`, {
          method: "POST",
          body: JSON.stringify({ signedReceipt: receipt }),
        });
        return receipt;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
    throw new Error("RECEIPT_WRITE_FAILED");
  }

  private withDurableUsage(input: MandatedActionInput, signed: SignedMandate): MandatedActionInput {
    const usage = this.dependencies.runtimeState().workroomMandateUsage?.[mandateUsageKey(signed)];
    if (!usage) return input;
    const alreadyCompleted = Boolean(usage.completedOperations?.[input.operationId]);
    const now = new Date();
    const storedSpend = Object.fromEntries(signed.mandate.spendLimits.map((limit) => {
      const key = `${limit.currency}:${limit.period}`;
      const stored = usage.spend[key];
      return [key, stored?.bucket === spendBucket(limit.period, now) ? stored.amountMinor : 0];
    }));
    return {
      ...input,
      volumeUsed: maximumVolume(input.volumeUsed, usage.volume),
      spendUsedMinorByLimit: maximumCounters(input.spendUsedMinorByLimit, storedSpend),
      ...(alreadyCompleted ? {
        volumeDelta: emptyVolume(),
        ...(input.spend ? { spend: { ...input.spend, amountMinor: 0 } } : {}),
      } : {}),
    };
  }

  private async recordDurableUsage(input: MandatedActionInput, signed: SignedMandate): Promise<void> {
    const now = new Date();
    await this.dependencies.mutateRuntimeState((state) => {
      state.workroomMandateUsage ??= {};
      const key = mandateUsageKey(signed);
      const usage = state.workroomMandateUsage[key] ?? emptyMandateUsage();
      usage.completedOperations ??= {};
      if (usage.completedOperations[input.operationId]) return;
      usage.volume = addVolume(maximumVolume(input.volumeUsed, usage.volume), input.volumeDelta);
      if (input.spend) {
        for (const limit of signed.mandate.spendLimits.filter(({ currency }) => currency === input.spend!.currency)) {
          const counterKey = `${limit.currency}:${limit.period}`;
          const bucket = spendBucket(limit.period, now);
          const current = usage.spend[counterKey];
          const supplied = input.spendUsedMinorByLimit?.[counterKey] ?? 0;
          usage.spend[counterKey] = {
            bucket,
            amountMinor: safeAdd(
              Math.max(current?.bucket === bucket ? current.amountMinor : 0, supplied),
              input.spend.amountMinor,
            ),
          };
        }
      }
      usage.completedOperations[input.operationId] = now.toISOString();
      const completedIds = Object.keys(usage.completedOperations);
      for (let index = 0; index < completedIds.length - MAX_PROCESSED_WORKROOM_EVENTS; index += 1) {
        delete usage.completedOperations[completedIds[index]!];
      }
      state.workroomMandateUsage[key] = usage;
    });
  }

  private async serializedExecution<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.executionTail;
    let release!: () => void;
    this.executionTail = new Promise<void>((resolveExecution) => { release = resolveExecution; });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  private async retry<T>(operation: () => Promise<T>, maxAttempts: number, signal?: AbortSignal): Promise<T> {
    const attempts = Math.max(1, Math.min(5, maxAttempts));
    let lastError: unknown;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      throwIfAborted(signal);
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (attempt + 1 < attempts) await abortableDelay(250 * (2 ** attempt), signal);
      }
    }
    throw lastError;
  }
}

function exactActiveMemberPeers(detail: WorkroomDetail): PublicPeer[] {
  const peers = detail.members.filter(({ membership }) => !membership.leftAt).map(({ membership, peer }) => {
    if (!peer || peer.status !== "ACTIVE") throw new Error("WORKROOM_MEMBER_KEY_MISSING");
    if (peer.type === "ORGANIZATION"
      || peer.id !== membership.peerId
      || peer.type !== membership.peerType) {
      throw new Error("WORKROOM_ROUTING_MEMBER_INVALID");
    }
    return peer;
  });
  if (new Set(peers.map(({ id }) => id)).size !== peers.length) throw new Error("WORKROOM_MEMBER_DUPLICATE");
  return peers.sort((left, right) => left.id.localeCompare(right.id));
}

function routingPeer(peer: PublicPeer) {
  if (peer.status !== "ACTIVE" || peer.type === "ORGANIZATION") throw new Error("WORKROOM_MEMBER_TYPE_INVALID");
  return {
    id: peer.id,
    handle: peer.handle,
    type: peer.type,
    status: "ACTIVE" as const,
  };
}

function exactActiveRecipients(detail: WorkroomDetail): Array<{ peerId: string; encryptionPublicKey: string }> {
  return exactActiveMemberPeers(detail)
    .map(({ id, encryptionPublicKey }) => ({ peerId: id, encryptionPublicKey }));
}

function prepareContentAndProjection(
  candidate: WorkroomContentPayload,
  supplied?: WorkroomEventProjection,
): { content: WorkroomContentPayload; projection?: WorkroomEventProjection } {
  if (candidate.kind === "message" || candidate.kind === "activity") {
    if (supplied) throw new Error("WORKROOM_PROJECTION_UNEXPECTED");
    return { content: candidate };
  }
  if (supplied && supplied.kind !== candidate.kind) throw new Error("PROJECTION_KIND_MISMATCH");
  if (candidate.kind === "plan") {
    const id = supplied?.kind === "plan" ? supplied.id : candidate.planId ?? randomUUID();
    const content = { ...candidate, planId: id };
    return { content, projection: { kind: "plan", id, version: candidate.planVersion } };
  }
  if (candidate.kind === "artifact_version") {
    const id = supplied?.kind === "artifact_version" ? supplied.id : candidate.artifactVersionId ?? randomUUID();
    const content = { ...candidate, artifactVersionId: id };
    return { content, projection: {
      kind: "artifact_version", id, artifactId: candidate.artifactId,
      artifactVersion: candidate.artifactVersion, attachmentIds: candidate.attachmentIds,
    } };
  }
  if (candidate.kind === "deliverable") {
    const projection = supplied?.kind === "deliverable" ? supplied : undefined;
    const id = projection?.id ?? candidate.deliverableId ?? randomUUID();
    const artifactVersionId = projection?.artifactVersionId ?? candidate.artifactVersionId;
    if (!artifactVersionId) throw new Error("DELIVERABLE_ARTIFACT_VERSION_ID_REQUIRED");
    return { content: { ...candidate, deliverableId: id, artifactVersionId }, projection: {
      kind: "deliverable", id, artifactId: candidate.artifactId, artifactVersionId,
    } };
  }
  if (candidate.kind === "cost") {
    const id = supplied?.kind === "cost" ? supplied.id : candidate.costId ?? randomUUID();
    return { content: { ...candidate, costId: id }, projection: { kind: "cost", id } };
  }
  const id = supplied?.kind === "approval_request" ? supplied.id : candidate.requestId ?? randomUUID();
  return { content: { ...candidate, requestId: id }, projection: {
    kind: "approval_request",
    id,
    requiredApprovals: candidate.requiredApprovals,
    eligiblePeerIds: candidate.requestedApproverPeerIds,
    ...(candidate.expiresAt ? { expiresAt: candidate.expiresAt } : {}),
  } };
}

function validateProjectionBinding(projection: WorkroomEventProjection | undefined, content: WorkroomContentPayload): void {
  if (content.kind === "message" || content.kind === "activity") {
    if (projection) throw new Error("WORKROOM_PROJECTION_UNEXPECTED");
    return;
  }
  if (!projection || projection.kind !== content.kind) throw new Error("WORKROOM_PROJECTION_MISSING");
  if (content.kind === "plan" && (projection.kind !== "plan"
    || content.planId !== projection.id || content.planVersion !== projection.version)) {
    throw new Error("WORKROOM_PROJECTION_MISMATCH");
  }
  if (content.kind === "artifact_version" && (projection.kind !== "artifact_version" || (
    content.artifactVersionId !== projection.id
    || content.artifactId !== projection.artifactId
    || content.artifactVersion !== projection.artifactVersion
    || !sameOrdered(content.attachmentIds, projection.attachmentIds)
  ))) throw new Error("WORKROOM_PROJECTION_MISMATCH");
  if (content.kind === "deliverable" && (projection.kind !== "deliverable" || (
    content.deliverableId !== projection.id
    || content.artifactId !== projection.artifactId
    || content.artifactVersionId !== projection.artifactVersionId
  ))) throw new Error("WORKROOM_PROJECTION_MISMATCH");
  if (content.kind === "cost" && (projection.kind !== "cost" || content.costId !== projection.id)) {
    throw new Error("WORKROOM_PROJECTION_MISMATCH");
  }
  if (content.kind === "approval_request" && (projection.kind !== "approval_request" || (
    content.requestId !== projection.id
    || content.requiredApprovals !== projection.requiredApprovals
    || !sameSet(content.requestedApproverPeerIds, projection.eligiblePeerIds)
    || (content.expiresAt ?? undefined) !== (projection.expiresAt ?? undefined)
  ))) throw new Error("WORKROOM_PROJECTION_MISMATCH");
}

function mandateUseRequest(
  input: MandatedActionInput,
  signed: SignedMandate,
  actingPeerId: string,
  verifiedApprovals: MandateUseRequest["verifiedApprovals"],
): MandateUseRequest {
  return {
    mandateId: signed.mandate.mandateId,
    revision: signed.mandate.revision,
    actingPeerId,
    participantPeerIds: input.participantPeerIds ?? [],
    action: input.action,
    ...(input.tool ? { tool: input.tool } : {}),
    dataAccesses: input.dataAccesses ?? [],
    ...(input.spend ? { spend: input.spend } : {}),
    spendUsedMinorByLimit: input.spendUsedMinorByLimit ?? {},
    volumeUsed: input.volumeUsed ?? { messages: 0, files: 0, totalBytes: 0, actions: 0, custom: {} },
    volumeDelta: input.volumeDelta ?? { messages: 0, files: 0, totalBytes: 0, actions: 1, custom: {} },
    delegationDepth: input.delegationDepth ?? 0,
    principalApprovedDelegation: input.principalApprovedDelegation ?? false,
    verifiedApprovals,
    metEndConditionIds: input.metEndConditionIds ?? [],
    evaluatedAt: new Date().toISOString(),
  };
}

function verifyRevocation(revocation: NonNullable<WorkroomMandateView["revocation"]>, detail: WorkroomDetail): void {
  const peer = requiredPeer(detail, revocation.signedRevocation.revocation.revokedByPeerId);
  if (peer.signingPublicKey !== revocation.revokerSigningPublicKey
    || !verifyMandateRevocation(revocation.signedRevocation, peer.signingPublicKey)) {
    throw new Error("INVALID_MANDATE_REVOCATION");
  }
}

function requiredPeer(detail: WorkroomDetail, peerId: string): PublicPeer {
  const peer = detail.members.find(({ membership }) => membership.peerId === peerId)?.peer;
  if (!peer) throw new Error("WORKROOM_MEMBER_KEY_MISSING");
  return peer;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  const leftSet = new Set(left);
  const rightSet = new Set(right);
  return leftSet.size === left.length
    && rightSet.size === right.length
    && leftSet.size === rightSet.size
    && [...leftSet].every((value) => rightSet.has(value));
}

function sameOrdered(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isPurchaseAction(action: string): boolean {
  return /(?:^|[._:/-])(purchase|payment|pay|spend)(?:$|[._:/-])/iu.test(action);
}

/** @internal Approval identity is bound to the complete proposed operation, not only its action name. */
export function approvalRequestId(
  input: MandatedActionInput,
  signed: SignedMandate,
  thresholdId: string,
): string {
  return deterministicUuid(`approval:${hashCanonical(approvalOperation(input, signed, thresholdId))}`);
}

function approvalOperation(input: MandatedActionInput, signed: SignedMandate, thresholdId: string) {
  const surface = approvalSurface(input);
  return {
    operationId: input.operationId,
    mandateId: signed.mandate.mandateId,
    revision: signed.mandate.revision,
    thresholdId,
    action: input.action,
    ...surface,
    participantPeerIds: [...(input.participantPeerIds ?? [])].sort((left, right) => left.localeCompare(right)),
    tool: input.tool ?? null,
    dataAccesses: input.dataAccesses ?? [],
    spend: input.spend ?? null,
    delegationDepth: input.delegationDepth ?? 0,
    principalApprovedDelegation: input.principalApprovedDelegation ?? false,
  };
}

function approvalSurface(input: MandatedActionInput) {
  return {
    rationale: input.rationale?.trim() || `Approve ${input.action}`,
    summary: input.summary?.trim() ?? "",
    target: input.target ? {
      type: input.target.type.trim(),
      label: input.target.label.trim(),
      ...(input.target.reference?.trim() ? { reference: input.target.reference.trim() } : {}),
    } : null,
    effect: input.effect?.trim() ?? "",
    financialImpact: input.financialImpact ?? null,
    dataCategories: (input.dataCategories ?? []).map((value) => value.trim()),
  };
}

function approvalRequestPayloadMatchesInput(
  payload: ReturnType<typeof workroomApprovalRequestPayloadSchema.parse>,
  input: MandatedActionInput,
): boolean {
  const expected = approvalSurface(input);
  return payload.rationale === expected.rationale
    && payload.summary === expected.summary
    && payload.effect === expected.effect
    && hashCanonical(payload.target ?? null) === hashCanonical(expected.target)
    && hashCanonical(payload.financialImpact ?? null) === hashCanonical(expected.financialImpact)
    && sameOrdered(payload.dataCategories, expected.dataCategories)
    && payload.relatedEventIds.length === 0;
}

/** Stable action identifiers emitted by the app's agent-permission editor. */
export function defaultWorkroomAction(kind: WorkroomContentPayload["kind"]): string {
  switch (kind) {
    case "message":
    case "activity":
      return "message.send";
    case "artifact_version":
      return "file.create";
    case "deliverable":
      return "deliverable.submit";
    case "plan":
      return "plan.update";
    case "cost":
      throw new Error("WORKROOM_COST_MUST_BE_DERIVED_FROM_AN_EXECUTED_ACTION");
    case "approval_request":
      throw new Error("WORKROOM_APPROVAL_REQUESTS_ARE_CREATED_BY_THE_MANDATE_GUARD");
  }
}

/** Returns why autonomous execution must stop, independent of encrypted mandate terms. */
export function workroomStopReason(
  workroom: Pick<Workroom, "status" | "deadline">,
  now = Date.now(),
): "completed" | "cancelled" | "expired" | "deadline" | undefined {
  if (workroom.status === "completed" || workroom.status === "cancelled" || workroom.status === "expired") {
    return workroom.status;
  }
  if (workroom.deadline && now >= Date.parse(workroom.deadline)) return "deadline";
  return undefined;
}

function activePeerIds(detail: WorkroomDetail): string[] {
  return detail.members
    .filter(({ membership }) => !membership.leftAt)
    .map(({ membership }) => membership.peerId)
    .sort((left, right) => left.localeCompare(right));
}

/** The automation surface cannot accidentally treat another peer's plan as its own work. */
function autonomousEventView(event: DecryptedWorkroomEvent): DecryptedWorkroomEvent {
  if (event.content.kind !== "plan") return event;
  return {
    ...event,
    content: { ...event.content, steps: event.routing.assignedSteps },
  };
}

function payloadVolume(content: WorkroomContentPayload): NonNullable<MandatedActionInput["volumeDelta"]> {
  const encodedBytes = Buffer.byteLength(JSON.stringify(content), "utf8");
  if (content.kind === "artifact_version") {
    return {
      messages: 0,
      files: content.attachmentIds.length,
      totalBytes: content.attachments?.reduce((total, descriptor) => total + descriptor.size, 0) ?? 0,
      actions: 1,
      custom: {},
    };
  }
  return {
    messages: content.kind === "message" || content.kind === "activity" ? 1 : 0,
    files: 0,
    totalBytes: encodedBytes,
    actions: 1,
    custom: {},
  };
}

function publicationSummary(content: WorkroomContentPayload): string {
  switch (content.kind) {
    case "message": return "Send a message in this Task";
    case "activity": return content.summary;
    case "plan": return content.summary;
    case "artifact_version": return `Add file: ${content.title}`;
    case "deliverable": return "Submit a deliverable for review";
    case "cost": return "Record Task usage";
    case "approval_request": return content.summary ?? content.rationale;
  }
}

function publicationEffect(content: WorkroomContentPayload): string {
  switch (content.kind) {
    case "message": return "Share the message with every current Task participant";
    case "activity": return "Share this progress update with every current Task participant";
    case "plan": return "Replace the visible Task plan with this signed version";
    case "artifact_version": return "Share the encrypted file version with every current Task participant";
    case "deliverable": return "Mark the selected artifact version as a deliverable awaiting review";
    case "cost": return "Append this usage record to the Task";
    case "approval_request": return content.effect ?? "Ask the selected people to approve this operation";
  }
}

function mandateUsageKey(signed: SignedMandate): string {
  return `${signed.mandate.mandateId}:${signed.mandate.revision}`;
}

function emptyVolume(): WorkroomMandateUsage["volume"] {
  return { messages: 0, files: 0, totalBytes: 0, actions: 0, custom: {} };
}

function emptyMandateUsage(): WorkroomMandateUsage {
  return { volume: emptyVolume(), spend: {}, completedOperations: {} };
}

function normalizeVolume(value: MandatedActionInput["volumeUsed"]): WorkroomMandateUsage["volume"] {
  return {
    messages: value?.messages ?? 0,
    files: value?.files ?? 0,
    totalBytes: value?.totalBytes ?? 0,
    actions: value?.actions ?? 0,
    custom: value?.custom ?? {},
  };
}

function maximumVolume(
  supplied: MandatedActionInput["volumeUsed"],
  stored: WorkroomMandateUsage["volume"],
): WorkroomMandateUsage["volume"] {
  const left = normalizeVolume(supplied);
  const customKeys = new Set([...Object.keys(left.custom), ...Object.keys(stored.custom ?? {})]);
  return {
    messages: Math.max(left.messages, stored.messages ?? 0),
    files: Math.max(left.files, stored.files ?? 0),
    totalBytes: Math.max(left.totalBytes, stored.totalBytes ?? 0),
    actions: Math.max(left.actions, stored.actions ?? 0),
    custom: Object.fromEntries([...customKeys].map((key) => [
      key,
      Math.max(left.custom[key] ?? 0, stored.custom?.[key] ?? 0),
    ])),
  };
}

function addVolume(
  stored: WorkroomMandateUsage["volume"],
  delta: MandatedActionInput["volumeDelta"],
): WorkroomMandateUsage["volume"] {
  const left = normalizeVolume(stored);
  const right = normalizeVolume(delta);
  const customKeys = new Set([...Object.keys(left.custom), ...Object.keys(right.custom)]);
  return {
    messages: safeAdd(left.messages, right.messages),
    files: safeAdd(left.files, right.files),
    totalBytes: safeAdd(left.totalBytes, right.totalBytes),
    actions: safeAdd(left.actions, right.actions),
    custom: Object.fromEntries([...customKeys].map((key) => [
      key,
      safeAdd(left.custom[key] ?? 0, right.custom[key] ?? 0),
    ])),
  };
}

function maximumCounters(
  supplied: MandatedActionInput["spendUsedMinorByLimit"],
  stored: Record<string, number>,
): Record<string, number> {
  const result = { ...stored };
  for (const [key, value] of Object.entries(supplied ?? {})) result[key] = Math.max(result[key] ?? 0, value);
  return result;
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) throw new Error("MANDATE_USAGE_OVERFLOW");
  return result;
}

function spendBucket(period: SignedMandate["mandate"]["spendLimits"][number]["period"], now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  if (period === "mandate") return "mandate";
  if (period === "month") return `${year}-${month}`;
  if (period === "day") return `${year}-${month}-${day}`;
  const monday = new Date(Date.UTC(year, now.getUTCMonth(), now.getUTCDate()));
  const weekday = monday.getUTCDay() || 7;
  monday.setUTCDate(monday.getUTCDate() - weekday + 1);
  return monday.toISOString().slice(0, 10);
}

function deterministicUuid(value: string): string {
  const bytes = createHash("sha256").update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  const file = await open(path, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let position = 0;
    while (true) {
      const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await file.close();
  }
  return hash.digest("base64url");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error("Workroom polling was cancelled");
  error.name = "AbortError";
  throw error;
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolveDelay, rejectDelay) => {
    const timer = setTimeout(resolveDelay, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      const error = new Error("Workroom polling was cancelled");
      error.name = "AbortError";
      rejectDelay(error);
    }, { once: true });
  });
}

function mimeTypeFromPath(path: string): string {
  const types: Record<string, string> = {
    ".aac": "audio/aac", ".csv": "text/csv", ".gif": "image/gif", ".heic": "image/heic",
    ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".json": "application/json", ".m4a": "audio/mp4",
    ".mov": "video/quicktime", ".mp3": "audio/mpeg", ".mp4": "video/mp4", ".ogg": "audio/ogg",
    ".pdf": "application/pdf", ".png": "image/png", ".txt": "text/plain", ".wav": "audio/wav",
    ".webm": "video/webm", ".webp": "image/webp", ".zip": "application/zip",
  };
  return types[extname(path).toLowerCase()] ?? "application/octet-stream";
}
