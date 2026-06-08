import { Module } from "@nestjs/common";
import { PrismaModule } from "../infrastructure/prisma/prisma.module.js";
import { CampaignService } from "../application/campaign/campaign.service.js";
import { CampaignController } from "../web/campaign.controller.js";
import { CampaignSchedulerService } from "../application/scheduler/campaign-scheduler.service.js";
import { GroupModule } from "./group.module.js";

@Module({
  imports: [PrismaModule, GroupModule],
  controllers: [CampaignController],
  providers: [CampaignService, CampaignSchedulerService]
})
export class CampaignModule {}
