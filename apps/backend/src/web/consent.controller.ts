import { Body, Controller, Get, Post, Query } from "@nestjs/common";
import type { ConsentTransitionAction } from "@cognita-campaign/domain";
import type { ConsentStatus } from "@cognita-campaign/domain";
import { ConsentService } from "../application/consent/consent.service.js";

interface ConsentTransitionRequest {
  contactId?: string;
  phoneE164?: string;
  action: ConsentTransitionAction;
}

interface ConsentTransitionResponse {
  contactConsentId: string;
  contactId: string;
  from: ConsentStatus | string;
  to: string;
  action: ConsentTransitionAction;
  requestedAt: string | null;
  confirmedAt: string | null;
  declinedAt: string | null;
}

@Controller("consents")
export class ConsentController {
  constructor(private readonly consentService: ConsentService) {}

  @Post("transition")
  async transition(@Body() body: ConsentTransitionRequest): Promise<ConsentTransitionResponse> {
    const result = await this.consentService.transition(body);
    return {
      contactConsentId: result.contactConsentId,
      contactId: result.contactId,
      from: result.from,
      to: result.to,
      action: result.action,
      requestedAt: result.requestedAt ?? null,
      confirmedAt: result.confirmedAt ?? null,
      declinedAt: result.declinedAt ?? null
    };
  }

  @Get("discovered")
  async discovered(@Query("limit") limit?: string) {
    const parsed = Number(limit ?? "200");
    const sanitized = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 500) : 200;
    return {
      total: sanitized,
      items: await this.consentService.getDiscoveredContacts(sanitized)
    };
  }

  @Get("summary")
  summary() {
    return this.consentService.getTransitionsSummary();
  }
}
