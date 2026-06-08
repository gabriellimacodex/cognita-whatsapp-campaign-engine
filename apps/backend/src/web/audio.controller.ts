import { Body, Controller, Get, Param, Patch, Post, Query } from "@nestjs/common";
import { AudioInstructionService } from "../application/audio/audio-instruction.service.js";

interface CreateAudioInstructionRequest {
  campaignId?: string;
  originalFileUrl: string;
  durationMs?: number;
  detectedLanguage?: string;
  rawTranscript?: string;
  reviewedTranscript?: string;
  confidence?: number;
  contentClass?: string;
  status?: AudioInstructionStatus;
}

interface UpdateAudioInstructionRequest {
  status?: AudioInstructionStatus;
  reviewedTranscript?: string;
  contentClass?: string;
  confidence?: number;
}

@Controller("audio-instructions")
export class AudioInstructionController {
  constructor(private readonly service: AudioInstructionService) {}

  @Post()
  create(@Body() body: CreateAudioInstructionRequest) {
    return this.service.create({
      campaignId: body.campaignId,
      originalFileUrl: body.originalFileUrl,
      durationMs: body.durationMs,
      detectedLanguage: body.detectedLanguage,
      rawTranscript: body.rawTranscript,
      reviewedTranscript: body.reviewedTranscript,
      confidence: body.confidence,
      contentClass: body.contentClass,
      status: body.status
    });
  }

  @Get()
  async list(
    @Query("campaignId") campaignId?: string,
    @Query("status") status?: string,
    @Query("limit") limitQuery?: string
  ) {
    const parsed = Number(limitQuery ?? "20");
    const limit = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 200) : 20;

    const validStatus = isValidStatus(status)
      ? status
      : undefined;

    const items = await this.service.list({
        campaignId,
        status: validStatus,
        limit
      });

    return {
      total: items.length,
      items
    };
  }

  @Patch(":id")
  update(
    @Param("id") id: string,
    @Body() body: UpdateAudioInstructionRequest
  ) {
    return this.service.update(id, {
      status: body.status,
      reviewedTranscript: body.reviewedTranscript,
      contentClass: body.contentClass,
      confidence: body.confidence
    });
  }
}

type AudioInstructionStatus =
  | "uploaded"
  | "transcribing"
  | "transcribed"
  | "needs_review"
  | "approved_for_workflow"
  | "rejected";

function isValidStatus(value?: string): value is AudioInstructionStatus {
  const allowed = new Set([
    "uploaded",
    "transcribing",
    "transcribed",
    "needs_review",
    "approved_for_workflow",
    "rejected"
  ]);
  return value ? allowed.has(value) : false;
}
