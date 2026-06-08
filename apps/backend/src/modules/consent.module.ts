import { Module } from "@nestjs/common";
import { AppConfigModule } from "../infrastructure/config/app-config.module.js";
import { PrismaModule } from "../infrastructure/prisma/prisma.module.js";
import { ConsentService } from "../application/consent/consent.service.js";
import { ConsentController } from "../web/consent.controller.js";

@Module({
  imports: [AppConfigModule, PrismaModule],
  controllers: [ConsentController],
  providers: [ConsentService]
})
export class ConsentModule {}
