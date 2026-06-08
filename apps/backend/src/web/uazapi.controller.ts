import { Body, Controller, Get, Headers, Post, Query } from "@nestjs/common";
import {
  GroupSyncService,
  type GroupExtractionResult
} from "../application/group/group-sync.service.js";

interface UazapiWebhookResponse {
  dedupKey: string;
  duplicate: boolean;
  eventsProcessed: number;
  eventsUpserted: number;
}

@Controller("integration/uazapi")
export class UazapiController {
  constructor(private readonly groupSync: GroupSyncService) {}

  @Get("status")
  async status() {
    return this.groupSync.getStatus();
  }

  @Get("groups")
  async listGroups() {
    return this.groupSync.listGroups();
  }

  @Get("groups/allowlisted")
  async getAllowlistedGroup() {
    return this.groupSync.getAllowlistedGroup();
  }

  @Get("contacts/discovered")
  async listDiscovered(@Query("limit") limitQuery?: string) {
    const limit = Number(limitQuery);
    const sanitizedLimit = Number.isFinite(limit) ? limit : 200;
    return {
      limit: sanitizedLimit,
      items: await this.groupSync.listDiscoveredContacts(sanitizedLimit)
    };
  }

  @Post("groups/extract")
  async extractMembers(@Body() body: { groupJid?: string } = {}): Promise<GroupExtractionResult> {
    return this.groupSync.extractGroupMembers(body);
  }

  @Post("webhook")
  async webhook(
    @Body() body: unknown,
    @Query("requestId") requestId?: string,
    @Headers("x-uazapi-signature") signature?: string,
    @Headers("x-request-id") requestHeaderId?: string
  ): Promise<UazapiWebhookResponse> {
    return this.groupSync.ingestWebhook({
      payload: body,
      requestId: requestId ?? requestHeaderId,
      signature
    });
  }
}
