import { Module } from "@nestjs/common";
import { HealthController } from "../web/health.controller.js";
import { RiskController } from "../web/risk.controller.js";

@Module({
  controllers: [HealthController, RiskController]
})
export class AppModule {}

