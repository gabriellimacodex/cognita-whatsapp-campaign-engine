import { Module } from "@nestjs/common";
import { AppConfigModule } from "../infrastructure/config/app-config.module.js";
import { PrismaModule } from "../infrastructure/prisma/prisma.module.js";
import { CapsuleAdapterService } from "../infrastructure/capsule/capsule.adapter.js";
import { OfficialCampaignService } from "../application/official/official-campaign.service.js";
import { OfficialController } from "../web/official.controller.js";

@Module({
  imports: [AppConfigModule, PrismaModule],
  controllers: [OfficialController],
  providers: [CapsuleAdapterService, OfficialCampaignService]
})
export class OfficialModule {}

