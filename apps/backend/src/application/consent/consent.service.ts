import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import type { ConsentStatus, ConsentTransitionAction, ConsentTransitionContext } from "@cognita-campaign/domain";
import { resolveConsentTransition } from "@cognita-campaign/domain";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";

interface TransitionInput {
  action: ConsentTransitionAction;
  contactId?: string;
  phoneE164?: string;
}

interface ContactConsentRecord {
  id: string;
  contactId: string;
  phoneE164: string;
  status: ConsentStatus;
  source?: string | null;
}

export interface TransitionResult {
  contactConsentId: string;
  contactId: string;
  from: string;
  to: string;
  action: ConsentTransitionAction;
  requestedAt?: string | null;
  confirmedAt?: string | null;
  declinedAt?: string | null;
}

@Injectable()
export class ConsentService {
  constructor(private readonly prisma: PrismaService) {}

  async transition(input: TransitionInput): Promise<TransitionResult> {
    if (!input.contactId && !input.phoneE164) {
      throw new BadRequestException("contactId or phoneE164 is required");
    }

    const target = await this.findLatestConsent(input);
    if (!target) {
      throw new NotFoundException("No consent found for this contact");
    }

    const context: ConsentTransitionContext = {
      action: input.action,
      currentStatus: target.status as ConsentStatus,
      metadata: undefined
    };

    const transition = resolveConsentTransition(context);
    if (!transition.allowed) {
      throw new BadRequestException({
        message: "Invalid consent transition",
        reasons: transition.reasons,
        from: target.status,
        action: input.action
      });
    }

    const updated = (await (this.prisma.db as any).contactConsent.update({
      where: { id: target.id },
      data: this.mapStatusUpdate(transition.to, input.action),
      select: {
        id: true,
        contactId: true,
        status: true,
        requestedAt: true,
        confirmedAt: true,
        declinedAt: true
      }
    })) as {
      id: string;
      contactId: string;
      status: string;
      requestedAt: Date | null;
      confirmedAt: Date | null;
      declinedAt: Date | null;
    };

    return {
      contactConsentId: updated.id,
      contactId: updated.contactId,
      from: target.status,
      to: updated.status,
      action: input.action,
      requestedAt: updated.requestedAt?.toISOString() ?? null,
      confirmedAt: updated.confirmedAt?.toISOString() ?? null,
      declinedAt: updated.declinedAt?.toISOString() ?? null
    };
  }

  async getTransitionsSummary(): Promise<{ byStatus: Record<string, number> }> {
    const rows = await (this.prisma.db as any).contactConsent.groupBy({
      by: ["status"],
      _count: {
        _all: true
      }
    });

    const byStatus: Record<string, number> = {};
    for (const row of rows as { status: string; _count: { _all: number } }[]) {
      byStatus[row.status] = row._count._all;
    }
    return { byStatus };
  }

  async getDiscoveredContacts(limit = 200) {
    const records = (await (this.prisma.contactConsent as any).findMany({
      where: {
        status: "group_member_discovered"
      },
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
    })) as (ContactConsentRecord & { contact: { id: string; phoneE164: string; displayName: string | null } })[];

    return records.map((record) => ({
      contactId: record.contactId,
      status: record.status,
      phoneE164: record.contact?.phoneE164 ?? record.phoneE164,
      source: record.source ?? "manual_check"
    }));
  }

  private mapStatusUpdate(to: string, action: ConsentTransitionAction): Record<string, unknown> {
    const now = new Date();

    switch (action) {
      case "request_opt_in":
        return {
          status: to,
          requestedAt: now
        };
      case "receive_opt_in_positive":
        return {
          status: to,
          confirmedAt: now
        };
      case "receive_opt_in_negative":
        return {
          status: to,
          declinedAt: now
        };
      case "block_contact":
        return { status: to };
      case "mark_expired":
        return { status: to };
      case "discover_group_member":
      default:
        return { status: to };
    }
  }

  private async findLatestConsent(input: TransitionInput): Promise<ContactConsentRecord | null> {
    if (!input.contactId && !input.phoneE164) {
      return null;
    }

    const where = input.contactId ? { contactId: input.contactId } : { phoneE164: input.phoneE164 };
    const found = (await (this.prisma.db as any).contactConsent.findFirst({
      where,
      orderBy: { updatedAt: "desc" }
    })) as ContactConsentRecord | null;

    if (found) {
      return found;
    }

    if (!input.phoneE164 || input.action !== "discover_group_member") {
      return null;
    }

    const normalizedPhone = input.phoneE164.replace(/\D/g, "");
    const contact = await (this.prisma.contact as any).upsert({
      where: { phoneE164: normalizedPhone },
      update: {},
      create: {
        phoneE164: normalizedPhone
      }
    });

    const created = (await (this.prisma.db as any).contactConsent.create({
      data: {
        contactId: contact.id,
        phoneE164: normalizedPhone,
        status: "group_member_discovered",
        source: "group_member_discovered"
      }
    })) as ContactConsentRecord;

    return created;
  }
}
