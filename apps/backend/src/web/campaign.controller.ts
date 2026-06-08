import { Body, Controller, Get, Param, Post, Query } from "@nestjs/common";
import { CampaignService } from "../application/campaign/campaign.service.js";
import { CampaignSchedulerService } from "../application/scheduler/campaign-scheduler.service.js";

interface ScheduleCampaignRequest {
  campaignId: string;
  accountId: string;
  startAt?: string;
  groupJid?: string;
}

interface RescheduleJobRequest {
  runAt: string;
}

@Controller("campaigns")
export class CampaignController {
  constructor(
    private readonly campaignService: CampaignService,
    private readonly schedulerService: CampaignSchedulerService
  ) {}

  @Post()
  create(@Body()
  body: {
    name?: string;
    timezone?: string;
    workflow: unknown;
  }) {
    return this.campaignService.createDraftCampaign({
      name: body.name ?? "Campanha sem nome",
      timezone: body.timezone,
      workflow: body.workflow
    });
  }

  @Get()
  list(@Query("limit") limit?: string) {
    const parsed = Number(limit ?? "25");
    return this.campaignService.listCampaigns(parsed);
  }

  @Post("schedule")
  schedule(@Body() body: ScheduleCampaignRequest) {
    return this.schedulerService.scheduleGroupCampaign(body);
  }

  @Get(":campaignId/schedule")
  listJobs(@Param("campaignId") campaignId: string) {
    return this.schedulerService.listJobs(campaignId);
  }

  @Post(":campaignId/pause")
  pause(@Param("campaignId") campaignId: string) {
    return this.schedulerService.pauseCampaign(campaignId);
  }

  @Post(":campaignId/resume")
  resume(@Param("campaignId") campaignId: string) {
    return this.schedulerService.resumeCampaign(campaignId);
  }

  @Post(":campaignId/cancel")
  cancel(@Param("campaignId") campaignId: string) {
    return this.schedulerService.cancelCampaign(campaignId);
  }

  @Post("jobs/:jobId/cancel")
  cancelJob(@Param("jobId") jobId: string) {
    return this.schedulerService.cancelJob(jobId);
  }

  @Post("jobs/:jobId/reschedule")
  reschedule(@Param("jobId") jobId: string, @Body() body: RescheduleJobRequest) {
    return this.schedulerService.rescheduleJob(jobId, body.runAt);
  }
}
