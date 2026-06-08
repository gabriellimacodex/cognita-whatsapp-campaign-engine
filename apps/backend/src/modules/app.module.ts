import { Module } from "@nestjs/common";
import { HealthController } from "../web/health.controller.js";
import { RiskController } from "../web/risk.controller.js";
import { WorkflowController } from "../web/workflow.controller.js";
import { GroupModule } from "./group.module.js";
import { CampaignModule } from "./campaign.module.js";
import { ConsentModule } from "./consent.module.js";
import { OfficialModule } from "./official.module.js";

@Module({
  imports: [GroupModule, CampaignModule, ConsentModule, OfficialModule],
  controllers: [HealthController, RiskController, WorkflowController]
})
export class AppModule {}
