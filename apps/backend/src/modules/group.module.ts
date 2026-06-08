import { Module } from "@nestjs/common";
import { AppConfigModule } from "../infrastructure/config/app-config.module.js";
import { PrismaModule } from "../infrastructure/prisma/prisma.module.js";
import { UazapiAdapterService } from "../infrastructure/uazapi/uazapi.adapter.js";
import { GroupSyncService } from "../application/group/group-sync.service.js";
import { UazapiController } from "../web/uazapi.controller.js";

@Module({
  imports: [AppConfigModule, PrismaModule],
  controllers: [UazapiController],
  providers: [UazapiAdapterService, GroupSyncService],
  exports: [UazapiAdapterService, GroupSyncService]
})
export class GroupModule {}
