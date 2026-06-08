import { createHash, randomUUID } from "node:crypto";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  buildIdempotencyKey,
  type ConsentStatus,
  evaluateSendRisk,
  type SendPolicyContext
} from "@cognita-campaign/domain";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import { CapsuleAdapterService } from "../../infrastructure/capsule/capsule.adapter.js";

const CONSENT_POSITIVE_MARKERS = [
  "sim",
  "quero",
  "aceito",
  "aceito receber",
  "aceito receber mensagens",
  "aceito receber notificações",
  "ok",
  "yes",
  "aceito sim",
  "claro",
  "com certeza",
  "pode enviar"
];

const CONSENT_NEGATIVE_MARKERS = [
  "nao",
  "não",
  "cancelar",
  "quero parar",
  "pare",
  "descadastrar",
  "optout",
  "opt-out",
  "opt out",
  "sair",
  "bloquear",
  "stop"
];

type CandidateStatus = "queued" | "running" | "sent" | "delivered" | "read" | "failed";

interface SendOptInTemplateInput {
  contactId?: string;
  phoneE164?: string;
  accountId: string;
  templateName: string;
  language?: string;
  parameters?: Record<string, string>;
  campaignId?: string;
  workflowStepId?: string;
  messageVersionId?: string;
}

interface SendTemplateInput {
  contactId?: string;
  phoneE164?: string;
  accountId: string;
  templateName: string;
  language?: string;
  parameters?: Record<string, string>;
  campaignId?: string;
  workflowStepId?: string;
  messageVersionId?: string;
  isOptInTemplate?: boolean;
  isCommercialTemplate?: boolean;
}

interface SendTemplateResult {
  sendAttemptId: string;
  consentId: string;
  contactId: string;
  phoneE164: string;
  providerMessageId: string;
  requestTemplateId: string;
  requestedAt: string;
  status: string;
}

interface OfficialWebhookInput {
  payload: unknown;
  signature?: string | null;
  requestId?: string | null;
}

interface OfficialWebhookResult {
  dedupKey: string;
  duplicate: boolean;
  eventsProcessed: number;
  eventsDeduped: number;
  sendAttemptsUpdated: number;
  consentTransitions: Array<{
    contactId: string;
    from: string;
    to: string;
    action: "receive_opt_in_positive" | "receive_opt_in_negative";
  }>;
}

interface OfficialPayload {
  [key: string]: unknown;
}

interface ParsedWebhookEvent {
  eventType: string;
  providerMessageId?: string;
  direction: "inbound" | "outbound";
  happenedAt: Date;
  raw: unknown;
  phoneE164?: string;
  text?: string;
  replyToMessageId?: string;
  status?: string;
  errorCode?: string;
  errorMessage?: string;
}

type ContactWithLatestConsent = {
  id: string;
  phoneE164: string;
  displayName?: string | null;
  consents: ConsentRecord[];
};

type ConsentRecord = {
  id: string;
  contactId: string;
  phoneE164: string;
  status: ConsentStatus;
  source?: string | null;
};

type SendAttemptRecord = {
  id: string;
  status: string;
  contactId?: string | null;
  consentStatus?: string | null;
  providerMessageId?: string | null;
  requestPayloadJson?: unknown;
};

type SendAttemptListItem = {
  id: string;
  status: string;
  contactId: string;
  templateKey: string | null;
  providerMessageId: string | null;
  consentStatus: string | null;
  scheduledAt: string;
  createdAt: string;
  updatedAt: string;
  phoneE164: string | null;
  displayName: string | null;
};

@Injectable()
export class OfficialCampaignService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capsule: CapsuleAdapterService
  ) {}

  async sendOptInTemplate(input: SendOptInTemplateInput): Promise<SendTemplateResult> {
    return this.sendTemplate({
      ...input,
      isOptInTemplate: true,
      isCommercialTemplate: false
    });
  }

  async sendTemplate(input: SendTemplateInput): Promise<SendTemplateResult> {
    const normalizedPhone = input.phoneE164 ? this.normalizePhone(input.phoneE164) : "";
    const resolvedContact = await this.resolveTargetContact({
      contactId: input.contactId,
      phoneE164: normalizedPhone
    });

    if (!resolvedContact) {
      throw new NotFoundException("No contact found for this target");
    }

    const latestConsent = resolvedContact.consents[0];
    if (!latestConsent) {
      throw new BadRequestException("No consent record found for this contact");
    }

    const isOptInTemplate = input.isOptInTemplate ?? false;
    const isCommercialTemplate = input.isCommercialTemplate ?? !isOptInTemplate;
    const language = input.language ?? "pt_BR";
    const messageVersionId = input.messageVersionId ?? input.templateName;

    const risk = await this.assessOfficialSendRisk({
      input,
      contactConsentStatus: latestConsent.status,
      isCommercialTemplate,
      isOptInTemplate
    });

    if (risk.decision === "block" || risk.decision === "needs_manual_review") {
      throw new BadRequestException({
        message: "Commercial or template send blocked by policy",
        reasons: risk.reasons,
        decision: risk.decision,
        consentStatus: latestConsent.status
      });
    }

    if (isOptInTemplate && latestConsent.status === "opted_in") {
      throw new BadRequestException("Contact already opted-in");
    }

    if (isOptInTemplate && ["opt_out", "blocked", "expired"].includes(latestConsent.status)) {
      throw new BadRequestException(`Contact cannot receive opt-in request in state ${latestConsent.status}`);
    }

    if (isOptInTemplate && !["group_member_discovered", "consent_request_candidate", "opt_in_requested"].includes(latestConsent.status)) {
      throw new BadRequestException(`Invalid consent state for opt-in send: ${latestConsent.status}`);
    }

    const now = new Date();
    const campaignId = input.campaignId ?? "direct-official";
    const workflowStepId = input.workflowStepId ?? "opt_in";
    const idempotencyKey = buildIdempotencyKey({
      campaignId,
      recipientScopeId: resolvedContact.id,
      workflowStepId,
      scheduledAt: now,
      messageVersionId
    });

    const channelAccountId = await this.resolveChannelAccountId(input.accountId);
    const normalizedPhoneForSend = resolvedContact.phoneE164;
    const sendTrackId = randomUUID();

    const payloadForProvider = {
      accountId: input.accountId,
      recipient: normalizedPhoneForSend,
      templateName: input.templateName,
      language,
      parameters: input.parameters ?? {},
      trackId: sendTrackId
    };

    const existingAttempt = await (this.prisma.db.sendAttempt as any).findFirst({
      where: { idempotencyKey }
    }) as { id: string; status: string; providerMessageId: string | null; createdAt?: Date } | null;

    if (existingAttempt) {
      return {
        sendAttemptId: existingAttempt.id,
        consentId: latestConsent.id,
        contactId: latestConsent.contactId,
        phoneE164: normalizedPhoneForSend,
        providerMessageId: existingAttempt.providerMessageId ?? "unknown",
        requestTemplateId: input.templateName,
        requestedAt: existingAttempt.createdAt?.toISOString() ?? now.toISOString(),
        status: existingAttempt.status
      };
    }

    await this.prepareOptInConsentTransition({
      currentConsent: latestConsent,
      isOptInTemplate,
      now
    });

    const attempt = await (this.prisma.db.sendAttempt as any).create({
      data: {
        idempotencyKey,
        campaignId,
        workflowStepId,
        channel: "capsule_official",
        provider: "capsule",
        recipientType: "contact",
        recipientId: resolvedContact.id,
        contactId: resolvedContact.id,
        channelAccountId,
        scheduledAt: now,
        consentStatus: latestConsent.status,
        templateKey: input.templateName,
        renderedText: `template:${input.templateName} (${language})`,
        requestPayloadJson: payloadForProvider,
        status: "queued"
      }
    }) as { id: string };

    try {
      await (this.prisma.db.sendAttempt as any).update({
        where: { id: attempt.id },
        data: {
          status: "running",
          startedAt: new Date(),
          requestPayloadJson: payloadForProvider
        }
      });

      const sendResult = await this.capsule.sendTemplate(payloadForProvider);
      const providerStatus = this.mapProviderSendStatus(sendResult.status);

      await (this.prisma.db.sendAttempt as any).update({
        where: { id: attempt.id },
        data: {
          status: providerStatus,
          completedAt: ["sent", "delivered", "read"].includes(providerStatus) ? new Date() : undefined,
          providerMessageId: sendResult.providerMessageId,
          responsePayloadJson: sendResult.raw
        }
      });

      const consentId = await this.persistConsentAfterSend({
        input: isOptInTemplate
          ? {
              type: "opt_in",
              consentId: latestConsent.id,
              templateName: input.templateName,
              sendAttemptId: attempt.id,
              messageVersionId,
              sendResult,
              requestedAt: now
            }
          : {
              type: "generic",
              consentId: latestConsent.id
            }
      });

      return {
        sendAttemptId: attempt.id,
        consentId,
        contactId: latestConsent.contactId,
        phoneE164: normalizedPhoneForSend,
        providerMessageId: sendResult.providerMessageId,
        requestTemplateId: input.templateName,
        requestedAt: now.toISOString(),
        status: providerStatus
      };
    } catch (error) {
      await (this.prisma.db.sendAttempt as any).update({
        where: { id: attempt.id },
        data: {
          status: "failed",
          completedAt: new Date(),
          errorCode: "provider_error",
          errorMessage: error instanceof Error ? error.message : String(error)
        }
      });
      throw error;
    }
  }

  async getOfficialSendAttempts(limit = 40): Promise<SendAttemptListItem[]> {
    const sanitizedLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 40;
    const attempts = (await (this.prisma.db.sendAttempt as any).findMany({
      where: { channel: "capsule_official" },
      include: {
        contact: {
          select: { id: true, phoneE164: true, displayName: true }
        }
      },
      orderBy: { createdAt: "desc" },
      take: sanitizedLimit
    })) as Array<{
      id: string;
      status: string;
      templateKey: string | null;
      providerMessageId: string | null;
      consentStatus: string | null;
      scheduledAt: Date;
      createdAt: Date;
      updatedAt: Date;
      contact?: { id: string; phoneE164: string; displayName: string | null };
      contactId?: string | null;
      recipientId: string | null;
    }>;

    return attempts.map((attempt) => ({
      id: attempt.id,
      status: attempt.status,
      contactId: attempt.contact?.id ?? attempt.contactId ?? attempt.recipientId ?? "",
      templateKey: attempt.templateKey,
      providerMessageId: attempt.providerMessageId,
      consentStatus: attempt.consentStatus,
      scheduledAt: attempt.scheduledAt.toISOString(),
      createdAt: attempt.createdAt.toISOString(),
      updatedAt: attempt.updatedAt.toISOString(),
      phoneE164: attempt.contact?.phoneE164 ?? null,
      displayName: attempt.contact?.displayName ?? null
    }));
  }

  private async assessOfficialSendRisk(input: {
    input: SendTemplateInput;
    contactConsentStatus: ConsentStatus;
    isCommercialTemplate: boolean;
    isOptInTemplate: boolean;
  }) {
    const campaignContext = await this.loadCampaignRiskContext(input.input.campaignId);
    const campaignApproved =
      input.isOptInTemplate || !input.input.campaignId
        ? true
        : this.isCampaignStatusReadyForOfficial(campaignContext?.status);

    const templateApproval = await this.capsule.getTemplateStatus(input.input.accountId, input.input.templateName)
      .then((template) => template?.status === "approved")
      .catch(() => false);

    const providerHealth = await this.capsule.getHealth(input.input.accountId);

    const riskContext: SendPolicyContext = {
      campaignApproved,
      channelEnabled: true,
      providerHealth,
      messageVersionLocked: true,
      scheduledAt: new Date(),
      recipientActive: true,
      hasOptOut: input.contactConsentStatus === "opt_out" || input.contactConsentStatus === "blocked",
      rateLimitAvailable: true,
      channel: "kapso_official",
      isOfficialBusinessInitiated: true,
      templateApproved: templateApproval,
      isOptInRequestTemplate: input.isOptInTemplate,
      consentStatus: input.contactConsentStatus,
      campaignStatus: campaignContext?.status as SendPolicyContext["campaignStatus"],
      isCommercialTemplate: input.isCommercialTemplate,
      killSwitchGlobal: false,
      killSwitchChannel: false
    };

    if (!input.input.campaignId && !input.isOptInTemplate) {
      riskContext.campaignApproved = false;
    }

    return evaluateSendRisk(riskContext);
  }

  private isCampaignStatusReadyForOfficial(status?: string): boolean {
    if (!status) return false;
    const readyStatuses = new Set(["templates_approved", "scheduled", "running", "paused", "completed"]);
    return readyStatuses.has(status);
  }

  private async loadCampaignRiskContext(campaignId?: string): Promise<{ status?: string } | null> {
    if (!campaignId) return null;

    const campaign = await (this.prisma.db.campaign as any).findUnique({
      where: { id: campaignId },
      select: { id: true, status: true }
    }) as { id: string; status: string } | null;

    if (!campaign) {
      return null;
    }

    return { status: campaign.status };
  }

  private async prepareOptInConsentTransition(input: {
    currentConsent: ConsentRecord;
    isOptInTemplate: boolean;
    now: Date;
  }) {
    if (!input.isOptInTemplate) {
      return;
    }

    if (input.currentConsent.status === "group_member_discovered") {
      await (this.prisma.db.contactConsent as any).update({
        where: { id: input.currentConsent.id },
        data: {
          status: "consent_request_candidate",
          requestedAt: input.now
        }
      });
    }
  }

  private async persistConsentAfterSend(input: {
    input:
      | {
          type: "opt_in";
          consentId: string;
          templateName: string;
          sendAttemptId: string;
          messageVersionId: string;
          sendResult: { providerMessageId: string; raw?: unknown };
          requestedAt: Date;
        }
      | { type: "generic"; consentId: string };
  }): Promise<string> {
    if (input.input.type === "generic") {
      return input.input.consentId;
    }

    const updated = await (this.prisma.db.contactConsent as any).update({
      where: { id: input.input.consentId },
      data: {
        status: "opt_in_requested",
        requestTemplateId: input.input.templateName,
        requestProviderMessageId: input.input.sendResult.providerMessageId,
        requestedAt: input.input.requestedAt,
        proofPayloadJson: {
          provider: "capsule",
          messageVersionId: input.input.messageVersionId,
          sendAttemptId: input.input.sendAttemptId,
          sendResultRaw: input.input.sendResult.raw
        }
      }
    }) as { id: string };

    return updated.id;
  }

  async getHealth(accountId: string) {
    return this.capsule.getHealth(accountId);
  }

  async listTemplates(accountId: string) {
    return this.capsule.listTemplates(accountId);
  }

  async submitTemplate(input: {
    accountId: string;
    name: string;
    language: string;
    category: string;
    body: string;
    example?: Record<string, string>;
  }) {
    return this.capsule.submitTemplate({
      accountId: input.accountId,
      name: input.name,
      language: input.language,
      category: input.category,
      body: input.body,
      example: input.example
    });
  }

  async getTemplateStatus(accountId: string, templateName: string) {
    const template = await this.capsule.getTemplateStatus(accountId, templateName);
    if (!template) {
      throw new NotFoundException("Template not found");
    }
    return template;
  }

  async processOfficialWebhook(input: OfficialWebhookInput): Promise<OfficialWebhookResult> {
    const payload = this.coerceObject(input.payload);
    const events = this.extractEventsFromPayload(payload);
    const dedupKey = this.buildWebhookDedupKey(payload, events, input.requestId);

    const existingEvent = await (this.prisma.db.webhookEvent as any).findFirst({
      where: { provider: "capsule", dedupKey }
    }) as { id: string } | null;

    if (existingEvent) {
      return {
        dedupKey,
        duplicate: true,
        eventsProcessed: 0,
        eventsDeduped: events.length,
        sendAttemptsUpdated: 0,
        consentTransitions: []
      };
    }

    const topEvent = events[0];
    const webhookEvent = await (this.prisma.db.webhookEvent as any).create({
      data: {
        provider: "capsule",
        eventType: topEvent?.eventType ?? "webhook",
        signatureValid: false,
        rawPayloadJson: payload,
        providerMessageId: topEvent?.providerMessageId,
        signature: input.signature ?? null,
        requestId: input.requestId ?? null,
        dedupKey,
        receivedAt: new Date(),
        processed: false,
        createdAt: new Date()
      }
    }) as { id: string };

    let eventsProcessed = 0;
    let eventsDeduped = 0;
    let sendAttemptsUpdated = 0;
    const consentTransitions: Array<{
      contactId: string;
      from: string;
      to: string;
      action: "receive_opt_in_positive" | "receive_opt_in_negative";
    }> = [];

    for (const event of events) {
      const upsertResult = await this.upsertMessageEvent({
        webhookEventId: webhookEvent.id,
        candidate: event
      });

      if (!upsertResult.upserted) {
        eventsDeduped += 1;
        continue;
      }

      eventsProcessed += 1;

      const sendAttempt = await this.findSendAttemptForWebhookCandidate(event);
      if (sendAttempt) {
        const attemptUpdate = await this.applySendAttemptEvent({
          sendAttempt,
          candidate: event
        });
        if (attemptUpdate.updated) {
          sendAttemptsUpdated += 1;
        }
      }

      if (event.direction === "inbound") {
        const intent = this.detectConsentIntent(event.text);
        if (!intent || !event.phoneE164) {
          continue;
        }

        const transition = await this.applyConsentFromInbound({
          phoneE164: event.phoneE164,
          intent,
          replyToMessageId: event.replyToMessageId,
          webhookEventId: webhookEvent.id,
          rawPayload: payload
        });
        if (transition) {
          consentTransitions.push(transition);
        }
      }
    }

    await (this.prisma.db.webhookEvent as any).update({
      where: { id: webhookEvent.id },
      data: {
        processed: true,
        processedAt: new Date(),
        rawPayloadJson: payload
      }
    });

    return {
      dedupKey,
      duplicate: false,
      eventsProcessed,
      eventsDeduped,
      sendAttemptsUpdated,
      consentTransitions
    };
  }

  private async resolveTargetContact(input: { contactId?: string; phoneE164?: string }): Promise<ContactWithLatestConsent | null> {
    if (!input.contactId && !input.phoneE164) {
      return null;
    }

    const where: { id?: string; phoneE164?: string } = input.contactId
      ? { id: input.contactId }
      : { phoneE164: input.phoneE164 };

    const contact = await (this.prisma.contact as any).findUnique({
      where,
      include: {
        consents: {
          orderBy: { updatedAt: "desc" },
          take: 1
        }
      }
    }) as ContactWithLatestConsent | null;

    return contact;
  }

  private async resolveChannelAccountId(providerAccountId: string): Promise<string | undefined> {
    const normalizedProvider = providerAccountId.trim();
    if (!normalizedProvider) {
      return undefined;
    }

    const channelAccount = (await (this.prisma.db.channelAccount as any).findUnique({
      where: {
        provider_providerAccountId: {
          provider: "capsule_official",
          providerAccountId: normalizedProvider
        }
      }
    })) as { id: string } | null;

    return channelAccount?.id;
  }

  private mapProviderSendStatus(status: string): CandidateStatus {
    const normalized = status.toLowerCase();
    if (normalized.includes("failed") || normalized.includes("reject") || normalized.includes("reject")) {
      return "failed";
    }
    return "sent";
  }

  private async upsertMessageEvent(input: {
    webhookEventId: string;
    candidate: ParsedWebhookEvent;
  }): Promise<{ upserted: boolean; messageEventId?: string }> {
    const eventCandidateId = input.candidate.providerMessageId ?? this.makeEventFingerprint(input.candidate);
    const existing = await (this.prisma.db.messageEvent as any).findFirst({
      where: {
        providerMessageId: eventCandidateId,
        eventType: input.candidate.eventType
      }
    }) as { id: string } | null;

    if (existing) {
      return { upserted: false, messageEventId: existing.id };
    }

    const sendAttempt = await this.findSendAttemptForWebhookCandidate(input.candidate).catch(() => null);

    const created = await (this.prisma.db.messageEvent as any).create({
      data: {
        sendAttemptId: sendAttempt?.id,
        provider: "capsule",
        eventType: input.candidate.eventType,
        providerMessageId: eventCandidateId,
        rawPayloadJson: input.candidate.raw,
        occurredAt: input.candidate.happenedAt,
        webhookEventId: input.webhookEventId
      }
    }) as { id: string };

    return { upserted: true, messageEventId: created.id };
  }

  private async findSendAttemptForWebhookCandidate(candidate: ParsedWebhookEvent): Promise<SendAttemptRecord | null> {
    if (candidate.providerMessageId) {
      const directMatch = await (this.prisma.db.sendAttempt as any).findFirst({
        where: {
          providerMessageId: candidate.providerMessageId,
          channel: "capsule_official"
        },
        orderBy: { createdAt: "desc" }
      }) as SendAttemptRecord | null;

      if (directMatch) {
        return directMatch;
      }
    }

    if (!candidate.phoneE164) {
      return null;
    }

    return (await (this.prisma.db.sendAttempt as any).findFirst({
      where: {
        channel: "capsule_official",
        contact: {
          phoneE164: candidate.phoneE164
        },
        status: {
          in: ["queued", "running", "sent", "delivered", "read"]
        }
      },
      orderBy: { createdAt: "desc" }
    })) as SendAttemptRecord | null;
  }

  private async applySendAttemptEvent(input: {
    sendAttempt: SendAttemptRecord;
    candidate: ParsedWebhookEvent;
  }): Promise<{ updated: boolean }> {
    const mappedStatus = this.mapEventToAttemptStatus(input.candidate.status ?? input.candidate.eventType);
    if (!mappedStatus) {
      return { updated: false };
    }

    if (!this.shouldAdvanceSendAttemptStatus(input.sendAttempt.status, mappedStatus)) {
      return { updated: false };
    }

    const update: Record<string, unknown> = {
      status: mappedStatus,
      updatedAt: new Date()
    };

    if (mappedStatus === "failed") {
      update.completedAt = new Date();
      update.errorCode = input.candidate.errorCode ?? "status_failed";
      update.errorMessage = input.candidate.errorMessage;
    } else if (mappedStatus === "read") {
      update.completedAt = new Date();
    }

    await (this.prisma.db.sendAttempt as any).update({
      where: { id: input.sendAttempt.id },
      data: update
    });

    return { updated: true };
  }

  private async applyConsentFromInbound(input: {
    phoneE164: string;
    intent: "positive" | "negative";
    replyToMessageId?: string;
    webhookEventId: string;
    rawPayload: unknown;
  }): Promise<{ contactId: string; from: string; to: string; action: "receive_opt_in_positive" | "receive_opt_in_negative" } | null> {
    const normalizedPhone = this.normalizePhone(input.phoneE164);
    if (!normalizedPhone) {
      return null;
    }

    const consent = await (this.prisma.db.contactConsent as any).findFirst({
      where: {
        phoneE164: normalizedPhone,
        status: {
          in: ["consent_request_candidate", "opt_in_requested"]
        }
      },
      orderBy: { createdAt: "desc" }
    }) as ConsentRecord | null;

    if (!consent) {
      return null;
    }

    if (input.intent === "positive") {
      const updated = await (this.prisma.db.contactConsent as any).update({
        where: { id: consent.id },
        data: {
          status: "opted_in",
          confirmedAt: new Date(),
          proofPayloadJson: {
            provider: "capsule",
            action: "receive_opt_in_positive",
            replyToMessageId: input.replyToMessageId,
            webhookEventId: input.webhookEventId,
            receivedAt: new Date().toISOString(),
            payload: input.rawPayload
          }
        }
      }) as { status: string; id: string; contactId: string };

      return {
        contactId: consent.contactId,
        from: consent.status,
        to: updated.status,
        action: "receive_opt_in_positive"
      };
    }

    const updated = await (this.prisma.db.contactConsent as any).update({
      where: { id: consent.id },
      data: {
        status: "opt_out",
        declinedAt: new Date(),
        proofPayloadJson: {
          provider: "capsule",
          action: "receive_opt_in_negative",
          replyToMessageId: input.replyToMessageId,
          webhookEventId: input.webhookEventId,
          receivedAt: new Date().toISOString(),
          payload: input.rawPayload
        }
      }
    }) as { status: string; id: string; contactId: string };

    return {
      contactId: consent.contactId,
      from: consent.status,
      to: updated.status,
      action: "receive_opt_in_negative"
    };
  }

  private mapEventToAttemptStatus(candidateStatus: string): CandidateStatus | null {
    const normalized = candidateStatus.toLowerCase();
    if (normalized.includes("delivered")) {
      return "delivered";
    }
    if (normalized.includes("read")) {
      return "read";
    }
    if (normalized.includes("failed") || normalized.includes("undelivered") || normalized.includes("rejected")) {
      return "failed";
    }
    if (normalized.includes("sent") || normalized.includes("accepted")) {
      return "sent";
    }
    return null;
  }

  private shouldAdvanceSendAttemptStatus(current: string, next: CandidateStatus): boolean {
    const order: Record<string, number> = {
      queued: 1,
      running: 2,
      sent: 3,
      delivered: 4,
      read: 5,
      failed: 6,
      cancelled: 7,
      blocked: 8
    };

    const currentOrder = order[current] ?? 0;
    const nextOrder = order[next] ?? 0;

    if (next === "failed") {
      return current !== "failed";
    }

    return nextOrder > currentOrder;
  }

  private extractEventsFromPayload(payload: OfficialPayload): ParsedWebhookEvent[] {
    const events: ParsedWebhookEvent[] = [];
    const entryCandidates = this.toArray(payload.entry);

    if (entryCandidates.length > 0) {
      for (const entryCandidate of entryCandidates) {
        const entryObject = this.coerceObject(entryCandidate);
        const changes = this.toArray(entryObject.changes);

        for (const change of changes) {
          const changeObject = this.toObject(change);
          const value = this.coerceObject(changeObject.value);

          const statusCandidates = this.toArray(value.statuses);
          for (const statusCandidateRaw of statusCandidates) {
            const statusCandidate = this.toObject(statusCandidateRaw);
            const providerMessageId = this.pickString(statusCandidate, "id") ??
              this.pickString(statusCandidate, "messageId") ??
              this.pickString(statusCandidate, "message_id");
            const rawStatus = this.pickString(statusCandidate, "status") ?? "update";
            const recipient = this.pickString(statusCandidate, "recipient_id")
              ?? this.pickString(statusCandidate, "to")
              ?? this.pickString(statusCandidate, "from");
            const statusErrors = [
              ...this.pickArray(statusCandidate, "errors"),
              ...this.pickArray(statusCandidate, "errors_details")
            ];
            const firstError = this.toObject(statusErrors[0]);

            events.push({
              eventType: `status.${rawStatus.toLowerCase()}`,
              providerMessageId,
              direction: "outbound",
              happenedAt: this.toDate(statusCandidate.timestamp) ?? new Date(),
              raw: statusCandidateRaw,
              status: rawStatus,
              phoneE164: this.normalizePhone(recipient),
              errorCode: this.pickString(firstError, "code"),
              errorMessage: this.pickString(firstError, "title") ?? this.pickString(firstError, "message")
            });
          }

          const messageCandidates = this.toArray(value.messages);
          for (const messageCandidateRaw of messageCandidates) {
            const messageCandidate = this.toObject(messageCandidateRaw);
            const providerMessageId = this.pickString(messageCandidate, "id") ?? this.pickString(messageCandidate, "messageId");
            const messageText = this.toObject(messageCandidate, "text");
            const text = this.extractText(
              this.pickString(messageText, "body"),
              this.pickString(messageCandidate, "body"),
              this.pickString(messageCandidate, "text")
            );
            const phone = this.normalizePhone(
              this.pickString(messageCandidate, "from") ??
              this.pickString(messageCandidate, "to") ??
              this.toStringValue(payload?.from)
            );
            const replyToMessageId = this.pickString(this.toObject(messageCandidate, "context"), "id");

            events.push({
              eventType: "message.inbound",
              providerMessageId,
              direction: "inbound",
              happenedAt: this.toDate(this.pickString(messageCandidate, "timestamp") ?? messageCandidate.timestamp) ?? new Date(),
              raw: messageCandidateRaw,
              phoneE164: phone,
              text,
              replyToMessageId
            });
          }
        }
      }
    }

    if (events.length > 0) {
      return events;
    }

    const payloadStatus = this.toStringValue(payload.status);
    const payloadMessages = this.toArray(payload.messages);
    const payloadMessage = this.toObject(payload.message);

    if (payloadMessages.length > 0) {
      for (const messageCandidateRaw of payloadMessages) {
        const messageCandidate = this.toObject(messageCandidateRaw);
        const providerMessageId = this.pickString(messageCandidate, "id") ?? this.pickString(messageCandidate, "messageId");
        const payloadMessageText = this.toObject(messageCandidate, "text");
        const text = this.extractText(
          this.pickString(payloadMessageText, "body"),
          this.pickString(messageCandidate, "body"),
          this.pickString(messageCandidate, "text")
        );
        const phone = this.normalizePhone(
          this.pickString(messageCandidate, "from") ?? this.pickString(messageCandidate, "to")
        );
        events.push({
          eventType: this.toStringValue(payload.eventType) === "status" ? "status.update" : "message.inbound",
          providerMessageId,
          direction: this.toStringValue(payload.eventType) === "status" ? "outbound" : "inbound",
          happenedAt: this.toDate(this.pickString(messageCandidate, "timestamp") ?? messageCandidate.timestamp) ?? this.toDate(payload.timestamp) ?? new Date(),
          raw: messageCandidateRaw,
          phoneE164: phone,
          text,
          status: this.toStringValue(payload.status)
        });
      }
      return events;
    }

    if (payloadMessage?.id || payloadMessage?.text || payloadStatus || payloadEventName(payload) || payload.from || payload.to) {
      events.push({
        eventType: this.toStringValue(payloadStatus)
          ? `status.${this.toStringValue(payloadStatus)!.toLowerCase()}`
          : payloadEventName(payload) ?? "webhook",
        providerMessageId: this.toStringValue(payloadMessage.id) ?? this.toStringValue(payload.messageId),
        direction: "outbound",
        happenedAt: this.toDate(payload.timestamp) ?? new Date(),
        raw: payload,
        phoneE164: this.normalizePhone(this.toStringValue(payloadMessage.from) ?? this.toStringValue(payload.from)),
        status: this.toStringValue(payloadStatus)
      });
      return events;
    }

    return [];
  }

  private detectConsentIntent(text?: string): "positive" | "negative" | null {
    const normalized = this.normalizeText(text);
    if (!normalized) {
      return null;
    }

    if (CONSENT_NEGATIVE_MARKERS.some((word) => normalized.includes(word))) {
      return "negative";
    }

    if (CONSENT_POSITIVE_MARKERS.some((word) => normalized.includes(word))) {
      return "positive";
    }

    return null;
  }

  private buildWebhookDedupKey(payload: OfficialPayload, events: ParsedWebhookEvent[], requestId?: string | null): string {
    const payloadReference = this.toStringValue(
      (payload as { id?: string }).id ??
      (payload as { event_id?: string }).event_id ??
      (payload as { messageId?: string }).messageId ??
      this.toStringValue(payload.object)
    );

    const eventsFingerprint = events
      .map((event) => `${event.eventType}:${event.providerMessageId ?? ""}:${event.phoneE164 ?? ""}:${event.status ?? ""}:${event.happenedAt.toISOString()}`)
      .join("|");

    const seed = `${requestId ?? ""}|${payloadReference ?? ""}|${eventsFingerprint}`;

    if (seed.trim()) {
      return `capsule:${createHash("sha256").update(seed).digest("hex")}`;
    }

    return `capsule:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
  }

  private normalizePhone(input?: string): string {
    const digits = (input ?? "").replace(/\D/g, "");
    if (!digits) return "";

    if (digits.length >= 12 && digits.length <= 13 && digits.startsWith("55")) {
      return digits;
    }
    if (digits.length === 10 || digits.length === 11) {
      return `55${digits}`;
    }
    if (digits.length > 13) {
      return digits.slice(-13);
    }
    return digits;
  }

  private normalizeText(text?: string): string {
    return (text ?? "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9\s]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  private extractText(...values: (string | undefined)[]): string {
    for (const value of values) {
      if (value && value.trim()) return value;
    }
    return "";
  }

  private coerceObject(value: unknown): OfficialPayload {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new BadRequestException("Invalid webhook payload");
    }
    return value as OfficialPayload;
  }

  private toStringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private toObject(value: unknown): Record<string, unknown>;
  private toObject(value: unknown, key: string): unknown;
  private toObject(value: unknown, key?: string): Record<string, unknown> | unknown {
    const base: Record<string, unknown> =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};

    if (typeof key !== "string") {
      return base;
    }

    const candidate = base[key];
    return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate) ? candidate : {};
  }

  private toArray(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  private pickString(value: Record<string, unknown> | unknown, key: string): string | undefined {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }

    const safeValue = value as Record<string, unknown>;
    const candidate = safeValue[key];
    return typeof candidate === "string" && candidate.trim() ? candidate.trim() : undefined;
  }

  private pickArray(value: Record<string, unknown> | unknown, key: string): unknown[] {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return [];
    }
    const safeValue = value as Record<string, unknown>;
    const candidate = safeValue[key];
    return Array.isArray(candidate) ? candidate : [];
  }

  private toDate(value: unknown): Date | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    if (value instanceof Date) {
      return value;
    }

    if (typeof value === "number") {
      const date = new Date(value > 1_000_000_000_000 ? value : value * 1000);
      return Number.isNaN(date.getTime()) ? undefined : date;
    }

    if (typeof value === "string") {
      const date = new Date(value);
      return Number.isNaN(date.getTime()) ? undefined : date;
    }

    return undefined;
  }

  private makeEventFingerprint(event: ParsedWebhookEvent): string {
    const seed = `${event.eventType}|${event.direction}|${event.phoneE164 ?? ""}|${event.status ?? ""}|${event.happenedAt.toISOString()}|${event.text ?? ""}`;
    return createHash("sha256").update(seed).digest("hex");
  }
}

function payloadEventName(payload: OfficialPayload): string | undefined {
  return (
    payloadEventValue(payload, "eventType") ??
    payloadEventValue(payload, "event") ??
    payloadEventValue(payload, "type")
  );
}

function payloadEventValue(payload: OfficialPayload, key: string): string | undefined {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
