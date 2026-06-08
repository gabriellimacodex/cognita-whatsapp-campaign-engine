import { Module } from "@nestjs/common";
import { AppConfigModule } from "../infrastructure/config/app-config.module.js";
import { PrismaModule } from "../infrastructure/prisma/prisma.module.js";
import { AudioInstructionService } from "../application/audio/audio-instruction.service.js";
import { AudioInstructionController } from "../web/audio.controller.js";

@Module({
  imports: [AppConfigModule, PrismaModule],
  controllers: [AudioInstructionController],
  providers: [AudioInstructionService]
})
export class AudioModule {}

