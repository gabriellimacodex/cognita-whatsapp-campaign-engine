import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { AppConfigService } from "../../infrastructure/config/app-config.service.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import {
  UazapiAdapterService,
  type UazapiGroupInfo,
  type UazapiGroupParticipant
} from "../../infrastructure/uazapi/uazapi.adapter.js";

type NormalizedGroupMember = {
  jid: string;
  phoneE164: string;
  displayName: string | null;
  raw: unknown;
};

interface ExtractedContact {
  phoneE164: string;
  contactId: string;
  displayName?: string | null;
  status: "created" | "updated" | "kept";
  source: string;
}

interface UazapiWebhookInput {
  payload: unknown;
  requestId?: string;
  signature?: string;
}

interface UazapiWebhookResult {
  dedupKey: string;
  duplicate: boolean;
  eventsProcessed: number;
  eventsUpserted: number;
}

interface GroupExtractionPreviewContact {
  phoneE164: string;
  contactId: string | null;
  displayName: string | null;
  status: "would_create_consent" | "would_keep";
  source: string;
  existingConsentStatus: string | null;
}

export interface GroupExtractionPreviewResult {
  preview: true;
  groupJid: string;
  groupName: string;
  groupTargetId: string;
  extractedMembers: number;
  upsertedConsents: number;
  extractedContacts: GroupExtractionPreviewContact[];
}

type GroupTargetRecord = {
  id: string;
  name: string;
  remoteJid: string;
  allowlisted: boolean;
  ownerCanSendMessage: boolean;
  instanceConnected: boolean;
};

export interface GroupExtractionResult {
  groupJid: string;
  groupName: string;
  groupTargetId: string;
  extractedMembers: number;
  upsertedConsents: number;
  extractedContacts: ExtractedContact[];
}

export interface DiscoveredContactResult {
  contactId: string;
  phoneE164: string;
  displayName: string | null;
  sourceGroupJid: string | null;
  sourceGroupName: string | null;
  discoveredAt: string;
}

type UazapiGroupWebhookEvent = {
  type?: string;
  eventType?: string;
  status?: string;
  event?: string;
  messageId?: string;
  errorCode?: string;
  errorMessage?: string;
  phone?: string;
  groupId?: string;
  message?: {
    id?: string;
    messageId?: string;
    from?: string;
    fromMe?: boolean;
    error?: string;
    text?: string;
  };
  connection?: {
    connected?: boolean;
    loggedIn?: boolean;
  };
  connected?: boolean;
  loggedIn?: boolean;
  payload?: {
    id?: string;
    messageId?: string;
  };
  occurredAt?: string;
  timestamp?: string;
  createdAt?: string;
};

@Injectable()
export class GroupSyncService {
  constructor(
    private readonly config: AppConfigService,
    private readonly uazapi: UazapiAdapterService,
    private readonly prisma: PrismaService
  ) {}

  async getStatus() {
    return this.uazapi.getInstanceStatus();
  }

  async listGroups() {
    const groups = await this.uazapi.listGroups();
    return { total: groups.length, groups };
  }

  async getAllowlistedGroup() {
    const allowlistJid = this.config.env.UAZAPI_GROUP_ALLOWLIST_JID;
    const group = (await this.prisma.groupTarget.findUnique({
      where: { remoteJid: allowlistJid },
      include: {
        extractions: {
          orderBy: { extractedAt: "desc" },
          take: 1
        }
      }
    })) as { extractions: { [key: string]: unknown }[]; } | null;

    return {
      configuredAllowlist: allowlistJid,
      group: group
        ? {
            ...group,
            extractionCount: group.extractions.length
          }
        : null
    };
  }

  async ensureAllowlistedGroupTarget() {
    return this.syncTargetGroup(this.config.env.UAZAPI_GROUP_ALLOWLIST_JID);
  }

  async getTargetForGroupJid(groupJid?: string) {
    const targetJid = groupJid?.trim() || this.config.env.UAZAPI_GROUP_ALLOWLIST_JID;
    return this.syncTargetGroup(targetJid);
  }

  async ingestWebhook(input: UazapiWebhookInput): Promise<UazapiWebhookResult> {
    const normalizedPayload = this.normalizeWebhookPayload(input.payload);
    const dedupKey = this.resolveWebhookDedupKey(input, normalizedPayload);

    const existing = await this.prisma.webhookEvent.findFirst({
      where: { dedupKey }
    }) as { id: string } | null;

    if (existing) {
      return {
        dedupKey,
        duplicate: true,
        eventsProcessed: 0,
        eventsUpserted: 0
      };
    }

    const webhook = await this.prisma.webhookEvent.create({
      data: {
        provider: "uazapi",
        eventType: "webhook",
        rawPayloadJson: {
          requestId: input.requestId,
          signature: input.signature,
          events: normalizedPayload
        },
        receivedAt: new Date(),
        processed: false,
        signatureValid: true,
        requestId: input.requestId,
        signature: input.signature,
        dedupKey,
        processedAt: new Date()
      }
    }) as { id: string };

    let eventsProcessed = 0;
    let eventsUpserted = 0;

    for (const event of this.extractWebhookEvents(normalizedPayload)) {
      const normalizedEvent = this.normalizeWebhookEvent(event);
      const eventType = normalizedEvent.eventType;
      if (!eventType) {
        continue;
      }

      eventsProcessed += 1;
      const eventAt = normalizedEvent.occurredAt ?? new Date();
      const messageId = normalizedEvent.messageId;

      const created = await this.prisma.messageEvent.create({
        data: {
          provider: "uazapi",
          eventType,
          providerMessageId: messageId,
          rawPayloadJson: normalizedEvent.raw,
          occurredAt: eventAt,
          webhookEventId: webhook.id
        }
      });
      if (created) {
        eventsUpserted += 1;
      }

      if (messageId) {
        const mappedStatus = this.mapStatusFromWebhookEvent(normalizedEvent);
        await (this.prisma.sendAttempt as any).updateMany({
          where: {
            providerMessageId: messageId
          },
          data: {
            status: mappedStatus,
            ...(mappedStatus === "failed" || mappedStatus === "queued"
              ? { errorCode: normalizedEvent.errorCode, errorMessage: normalizedEvent.errorMessage }
              : {}),
            ...(mappedStatus === "sent" || mappedStatus === "delivered" || mappedStatus === "read"
              ? { completedAt: eventAt }
              : {})
          }
        });
      }

      if (eventType === "connection" || eventType === "connection_status") {
        await this.syncGroupConnectionFromWebhook(normalizedEvent);
      }
    }

    await this.prisma.webhookEvent.update({
      where: { id: webhook.id },
      data: {
        processed: true,
        processedAt: new Date()
      }
    });

    return {
      dedupKey,
      duplicate: false,
      eventsProcessed,
      eventsUpserted
    };
  }

  async listDiscoveredContacts(limit = 200): Promise<DiscoveredContactResult[]> {
    const records = (await this.prisma.contactConsent.findMany({
      where: { status: "group_member_discovered" },
      distinct: ["phoneE164"],
      orderBy: { updatedAt: "desc" },
      take: limit,
      include: {
        contact: {
          select: {
            id: true,
            phoneE164: true,
            displayName: true
          }
        }
      }
    })) as Array<{
      contactId: string;
      phoneE164: string;
      sourceGroupJid: string | null;
      sourceGroupName: string | null;
      createdAt: Date;
      contact: { displayName: string | null } | null;
    }>;

    return records.map((record) => ({
      contactId: record.contactId,
      phoneE164: record.phoneE164,
      displayName: record.contact?.displayName ?? null,
      sourceGroupJid: record.sourceGroupJid ?? null,
      sourceGroupName: record.sourceGroupName ?? null,
      discoveredAt: record.createdAt.toISOString()
    }));
  }

  async extractAllowlistedGroupMembers(): Promise<GroupExtractionResult> {
    return this.extractGroupMembers({
      groupJid: this.config.env.UAZAPI_GROUP_ALLOWLIST_JID
    });
  }

  async previewGroupMembers(input: { groupJid?: string }): Promise<GroupExtractionPreviewResult> {
    const { groupJid, target, groupInfo, normalizedParticipants } =
      await this.getExtractionContext(input);

    if (normalizedParticipants.length === 0) {
      return {
        preview: true,
        groupJid,
        groupName: groupInfo.name || target.name,
        groupTargetId: target.id,
        extractedMembers: 0,
        upsertedConsents: 0,
        extractedContacts: []
      };
    }

    const dedupedParticipants = this.deduplicateByPhoneE164(normalizedParticipants);

    const contacts = await this.prisma.contact.findMany({
      where: {
        phoneE164: {
          in: dedupedParticipants.map((member) => member.phoneE164)
        }
      },
      select: {
        id: true,
        phoneE164: true,
        consents: {
          orderBy: { updatedAt: "desc" },
          take: 1,
          select: {
            status: true
          }
        }
      }
    }) as Array<{
      id: string;
      phoneE164: string;
      consents: Array<{ status: string }>;
    }>;

    const contactsByPhone = new Map(contacts.map((contact) => [contact.phoneE164, contact]));

    let upsertedConsents = 0;
    const extractedContacts: GroupExtractionPreviewContact[] = dedupedParticipants.map((member) => {
      const contact = contactsByPhone.get(member.phoneE164);
      const latestConsent = contact?.consents?.[0] ?? null;
      const latestStatus = latestConsent?.status ?? null;
      const shouldCreateConsent = !latestConsent || latestStatus !== "group_member_discovered";
      if (shouldCreateConsent) {
        upsertedConsents += 1;
      }

      return {
        phoneE164: member.phoneE164,
        contactId: contact?.id ?? null,
        displayName: member.displayName,
        status: shouldCreateConsent ? "would_create_consent" : "would_keep",
        source: shouldCreateConsent ? "group_member_discovered" : latestStatus ?? "group_member_discovered",
        existingConsentStatus: latestStatus
      };
    });

    return {
      preview: true,
      groupJid,
      groupName: groupInfo.name || target.name,
      groupTargetId: target.id,
      extractedMembers: dedupedParticipants.length,
      upsertedConsents,
      extractedContacts
    };
  }

  async extractGroupMembers(input: { groupJid?: string }): Promise<GroupExtractionResult> {
    const { groupJid, target, groupInfo, normalizedParticipants: normalized } =
      await this.getExtractionContext(input);

    const deduped = this.deduplicateByPhoneE164(normalized);

    if (deduped.length === 0) {
      return {
        groupJid,
        groupName: groupInfo.name || target.name,
        groupTargetId: target.id,
        extractedMembers: 0,
        upsertedConsents: 0,
        extractedContacts: []
      };
    }

    let upsertedConsents = 0;
    const extractedContacts: ExtractedContact[] = [];
    const seen = new Set<string>();

    await this.prisma.$transaction(async (tx) => {
      for (const member of deduped) {
        if (seen.has(member.phoneE164)) {
          continue;
        }
        seen.add(member.phoneE164);

        const contact = await (tx.contact as any).upsert({
          where: { phoneE164: member.phoneE164 },
          update: {
            ...(member.displayName ? { displayName: member.displayName } : {})
          },
          create: {
            phoneE164: member.phoneE164,
            displayName: member.displayName
          }
        });

        await (tx.groupContactExtraction as any).upsert({
          where: {
            groupId_phoneE164: {
              groupId: target.id,
              phoneE164: member.phoneE164
            }
          },
          update: {
            contactId: contact.id,
            remoteJid: member.jid,
            rawPayload: member.raw
          },
          create: {
            groupId: target.id,
            contactId: contact.id,
            phoneE164: member.phoneE164,
            remoteJid: member.jid,
            rawPayload: member.raw
          }
        });

        const statusCandidate = await (tx.contactConsent as any).findFirst({
          where: {
            contactId: contact.id,
            status: {
              in: [
                "group_member_discovered",
                "consent_request_candidate",
                "opt_in_requested",
                "opted_in",
                "opt_out",
                "expired",
                "blocked",
                "unknown"
              ]
            }
          },
          orderBy: {
            updatedAt: "desc"
          }
        });

        if (!statusCandidate || statusCandidate.status !== "group_member_discovered") {
          await (tx.contactConsent as any).create({
            data: {
              contactId: contact.id,
              phoneE164: contact.phoneE164,
              status: "group_member_discovered",
              source: "group_member_discovered",
              sourceGroupJid: groupInfo.jid,
              sourceGroupName: groupInfo.name || target.name,
              requestedAt: null
            }
          });
          upsertedConsents++;
          extractedContacts.push({
            phoneE164: member.phoneE164,
            contactId: contact.id,
            displayName: member.displayName,
            status: "created",
            source: "group_member_discovered"
          });
        } else {
          extractedContacts.push({
            phoneE164: member.phoneE164,
            contactId: contact.id,
            displayName: member.displayName,
            status: "kept",
            source: statusCandidate.status
          });
        }
      }
    });

    return {
      groupJid,
      groupName: groupInfo.name || target.name,
      groupTargetId: target.id,
      extractedMembers: deduped.length,
      upsertedConsents,
      extractedContacts
    };
  }

  private deduplicateByPhoneE164(participants: NormalizedGroupMember[]) {
    const seen = new Set<string>();
    const deduped: NormalizedGroupMember[] = [];

    for (const participant of participants) {
      if (seen.has(participant.phoneE164)) {
        continue;
      }
      seen.add(participant.phoneE164);
      deduped.push(participant);
    }

    return deduped;
  }

  private async getExtractionContext(input: { groupJid?: string }) {
    const allowlistJid = this.config.env.UAZAPI_GROUP_ALLOWLIST_JID;
    const requestedJid = input.groupJid?.trim();
    if (requestedJid && requestedJid !== allowlistJid) {
      throw new BadRequestException("Only allowlisted group can be extracted in MVP");
    }

    const groupJid = allowlistJid;
    const instanceStatus = await this.uazapi.getInstanceStatus();

    if (!instanceStatus.connected || !instanceStatus.loggedIn) {
      throw new BadRequestException("UAZAPI instance is not connected");
    }

    const target = await this.syncTargetGroup(groupJid);
    const groupInfo = await this.uazapi.getGroupInfo(groupJid);

    if (!groupInfo) {
      throw new NotFoundException("Group not found in instance");
    }

    const normalizedParticipants = this.normalizeParticipants(groupInfo, groupJid);
    return { groupJid, target, groupInfo, normalizedParticipants };
  }

  private async syncTargetGroup(groupJid: string) {
    const instanceStatus = await this.uazapi.getInstanceStatus();
    const groups = await this.uazapi.listGroups();
    const found = groups.find((group) => group.jid === groupJid);

    if (!found) {
      throw new NotFoundException("Allowlist group not found in this instance");
    }

    return (await this.prisma.groupTarget.upsert({
      where: { remoteJid: groupJid },
      update: {
        name: found.name,
        allowlisted: true,
        ownerCanSendMessage: found.ownerCanSendMessage,
        instanceConnected: instanceStatus.connected && instanceStatus.loggedIn
      },
      create: {
        remoteJid: groupJid,
        name: found.name,
        allowlisted: true,
        ownerCanSendMessage: found.ownerCanSendMessage,
        instanceConnected: instanceStatus.connected && instanceStatus.loggedIn
      }
    })) as GroupTargetRecord;
  }

  private normalizeParticipants(groupInfo: UazapiGroupInfo, groupJid: string) {
    const participants = this.parseParticipants(groupInfo.participants);
    return participants
      .map((member) => {
        const phoneE164 = this.toE164(member.jid);
        if (!phoneE164) return null;
        return {
          jid: this.ensureBareJid(member.jid),
          phoneE164,
          displayName: member.displayName ?? null,
          raw: member.raw
        };
      })
      .filter((entry): entry is NormalizedGroupMember => {
        return entry !== null;
      })
      .filter((entry) => entry.jid !== groupJid && entry.phoneE164.length >= 10);
  }

  private parseParticipants(participants: UazapiGroupParticipant[]): UazapiGroupParticipant[] {
    return participants.filter((participant) => typeof participant.jid === "string");
  }

  private toE164(rawJid: string): string | null {
    const bare = this.ensureBareJid(rawJid);
    const digits = bare.replace(/\D/g, "");

    if (digits.length < 10) {
      return null;
    }
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

  private ensureBareJid(rawJid: string): string {
    const atIndex = rawJid.indexOf("@");
    return atIndex > -1 ? rawJid.substring(0, atIndex) : rawJid;
  }

  private normalizeWebhookPayload(payload: unknown): unknown[] {
    if (!payload || typeof payload !== "object") {
      return [];
    }

    if (Array.isArray(payload)) {
      return payload.filter((event) => event !== null && typeof event === "object");
    }

    const candidate = payload as { events?: unknown[]; event?: unknown };
    if (Array.isArray(candidate.events)) {
      return candidate.events.filter((event) => event !== null && typeof event === "object");
    }

    return [candidate];
  }

  private resolveWebhookDedupKey(input: UazapiWebhookInput, payload: unknown[]): string {
    if (input.requestId && input.requestId.trim()) {
      return `req:${input.requestId.trim()}`;
    }

    if (input.signature && input.signature.trim()) {
      return `sig:${input.signature.trim()}`;
    }

    const raw = JSON.stringify(payload);
    return createHash("sha256").update(raw).digest("hex");
  }

  private extractWebhookEvents(payload: unknown[]): UazapiGroupWebhookEvent[] {
    return payload.filter((item): item is UazapiGroupWebhookEvent => {
      return item !== null && typeof item === "object";
    });
  }

  private normalizeWebhookEvent(event: UazapiGroupWebhookEvent) {
    const eventType = this.readString(event.type) || this.readString(event.eventType) || this.readString(event.event);
    const providerMessageId = this.readString(event.messageId)
      || this.readString(event.message?.id)
      || this.readString(event.message?.messageId);

    const timestamp = this.readString(event.occurredAt) || this.readString(event.timestamp) || this.readString(event.createdAt);
    const occurredAt = timestamp ? new Date(timestamp) : new Date();

    return {
      eventType: eventType || "message_update",
      messageId: providerMessageId,
      raw: event,
      status: this.readString(event.status),
      errorCode: this.readString(event.errorCode),
      errorMessage: this.readString(event.errorMessage) || this.readString(event.message?.error),
      occurredAt,
      connected:
        event.connected ?? event.connection?.connected ?? false,
      loggedIn:
        event.loggedIn ?? event.connection?.loggedIn ?? false,
      groupId: this.readString(event.groupId) || this.readString(event.message?.from)
    };
  }

  private mapStatusFromWebhookEvent(event: ReturnType<GroupSyncService["normalizeWebhookEvent"]>): string {
    const normalized = event.status?.trim().toLowerCase();
    if (event.eventType === "connection") {
      return event.connected && event.loggedIn ? "sent" : "failed";
    }
    if (!normalized) {
      return "running";
    }
    if (normalized.includes("error") || normalized.includes("failed") || normalized.includes("fail")) {
      return "failed";
    }
    if (normalized.includes("delivered")) {
      return "delivered";
    }
    if (normalized.includes("read")) {
      return "read";
    }
    if (normalized.includes("sent")) {
      return "sent";
    }
    return "queued";
  }

  private async syncGroupConnectionFromWebhook(event: ReturnType<GroupSyncService["normalizeWebhookEvent"]>) {
    const allowlistJid = this.config.env.UAZAPI_GROUP_ALLOWLIST_JID;
    const existingGroup = await this.prisma.groupTarget.findUnique({
      where: { remoteJid: allowlistJid }
    }) as { id: string } | null;

    if (!existingGroup) {
      return;
    }

    await this.prisma.groupTarget.update({
      where: { id: existingGroup.id },
      data: {
        instanceConnected: event.connected && event.loggedIn
      }
    });
  }

  private readString(value: unknown): string {
    return typeof value === "string" ? value.trim() : "";
  }
}
