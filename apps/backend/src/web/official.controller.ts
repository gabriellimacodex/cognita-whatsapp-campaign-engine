import { Body, Controller, Get, Headers, Param, Post, Query } from "@nestjs/common";
import type { TemplateRecord } from "@cognita-campaign/domain";
import { OfficialCampaignService } from "../application/official/official-campaign.service.js";

interface SendOptInTemplateRequest {
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

interface SendTemplateRequest {
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

interface SubmitTemplateRequest {
  accountId: string;
  name: string;
  language: string;
  category: string;
  body: string;
  example?: Record<string, string>;
}

interface TemplateSubmitResponse {
  providerTemplateId: string;
  status: TemplateRecord["status"];
  raw?: unknown;
}

interface OfficialWebhookResponse {
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

@Controller("integration/capsule")
export class OfficialController {
  constructor(private readonly officialCampaign: OfficialCampaignService) {}

  @Get("health")
  health(@Query("accountId") accountId: string) {
    return this.officialCampaign.getHealth(accountId);
  }

  @Get("templates")
  templates(@Query("accountId") accountId: string) {
    return this.officialCampaign.listTemplates(accountId);
  }

  @Get("templates/:templateName/status")
  async templateStatus(@Query("accountId") accountId: string, @Param("templateName") templateName: string) {
    return this.officialCampaign.getTemplateStatus(accountId, templateName);
  }

  @Post("templates")
  submitTemplate(@Body() body: SubmitTemplateRequest): Promise<TemplateSubmitResponse> {
    return this.officialCampaign.submitTemplate(body);
  }

  @Post("send/opt-in")
  sendOptInTemplate(@Body() body: SendOptInTemplateRequest) {
    return this.officialCampaign.sendOptInTemplate(body);
  }

  @Post("send/template")
  sendTemplate(@Body() body: SendTemplateRequest) {
    return this.officialCampaign.sendTemplate({
      ...body,
      isOptInTemplate: body.isOptInTemplate ?? false,
      isCommercialTemplate: body.isCommercialTemplate ?? true
    });
  }

  @Get("send-attempts")
  sendAttempts(@Query("limit") limitQuery?: string) {
    const parsedLimit = Number(limitQuery ?? "40");
    const limit = Number.isFinite(parsedLimit) ? parsedLimit : 40;
    return this.officialCampaign.getOfficialSendAttempts(limit);
  }

  @Post("webhook")
  async ingestWebhook(
    @Body() body: unknown,
    @Query("requestId") requestId?: string,
    @Headers("x-capsule-signature") signature?: string
  ): Promise<OfficialWebhookResponse> {
    return this.officialCampaign.processOfficialWebhook({
      payload: body,
      signature,
      requestId
    });
  }
}
