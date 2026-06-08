import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";

type AudioInstructionStatus =
  | "uploaded"
  | "transcribing"
  | "transcribed"
  | "needs_review"
  | "approved_for_workflow"
  | "rejected";

interface CreateAudioInstructionInput {
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

interface UpdateAudioInstructionInput {
  status?: AudioInstructionStatus;
  reviewedTranscript?: string;
  contentClass?: string;
  confidence?: number;
}

interface ListAudioInstructionsParams {
  campaignId?: string;
  status?: AudioInstructionStatus;
  limit: number;
}

interface AudioInstructionRecord {
  id: string;
  campaignId: string | null;
  originalFileUrl: string;
  durationMs: number | null;
  detectedLanguage: string | null;
  rawTranscript: string | null;
  reviewedTranscript: string | null;
  confidence: number | null;
  contentClass: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

interface AudioInstructionResult {
  id: string;
  campaignId: string | null;
  originalFileUrl: string;
  durationMs: number | null;
  detectedLanguage: string | null;
  rawTranscript: string | null;
  reviewedTranscript: string | null;
  confidence: number | null;
  contentClass: string | null;
  status: string;
  createdAt: string;
  updatedAt: string;
}

const LOW_CONFIDENCE_THRESHOLD = 0.78;

function sanitizeConfidence(value?: number) {
  if (typeof value !== "number" || Number.isNaN(value)) {
    return null;
  }
  const normalized = Number(value);
  if (normalized < 0 || normalized > 1) {
    return null;
  }
  return normalized;
}

function normalizeStatus(status: AudioInstructionStatus | undefined, rawTranscript: string | undefined, confidence: number | null) {
  if (status && ["uploaded", "transcribing", "transcribed", "needs_review", "approved_for_workflow", "rejected"].includes(status)) {
    return status;
  }

  if (!rawTranscript || !rawTranscript.trim()) {
    return "transcribing";
  }

  if (confidence !== null && confidence > 0 && confidence < LOW_CONFIDENCE_THRESHOLD) {
    return "needs_review";
  }

  return "transcribed";
}

function normalizeContentClass(value?: string) {
  return value?.trim() || inferContentClassFromTranscript(undefined);
}

function inferContentClassFromTranscript(input: string | undefined): string {
  const text = input?.toLowerCase().trim() ?? "";

  if (!text) {
    return "general";
  }

  if (text.includes("template") || text.includes("modelo") || text.includes("texto")) {
    return "template";
  }

  if (text.includes("horário") || text.includes("hora") || text.includes("agendar") || text.includes("envio") || text.includes("cron") ) {
    return "timing";
  }

  if (text.includes("whatsapp") || text.includes("lead") || text.includes("contato") || text.includes("grupo")) {
    return "routing";
  }

  if (text.includes("se") || text.includes("if") || text.includes("condição")) {
    return "condition";
  }

  return "general";
}

@Injectable()
export class AudioInstructionService {
  constructor(private readonly prisma: PrismaService) {}

  async create(input: CreateAudioInstructionInput): Promise<AudioInstructionResult> {
    if (!input.originalFileUrl?.trim()) {
      throw new BadRequestException("originalFileUrl is required");
    }

    const durationMs = typeof input.durationMs === "number" && Number.isFinite(input.durationMs) && input.durationMs > 0
      ? Math.floor(input.durationMs)
      : null;

    const confidence = sanitizeConfidence(input.confidence);
    const rawTranscript = input.rawTranscript?.trim() || "";
    const status = normalizeStatus(input.status, rawTranscript, confidence);
    const contentClass = normalizeContentClass(input.contentClass || inferContentClassFromTranscript(rawTranscript));

    const created = await (this.prisma.db.userAudioInstruction as any).create({
      data: {
        campaignId: input.campaignId ?? null,
        originalFileUrl: input.originalFileUrl,
        durationMs,
        detectedLanguage: input.detectedLanguage?.trim() || null,
        rawTranscript: rawTranscript || null,
        reviewedTranscript: input.reviewedTranscript?.trim() || null,
        confidence,
        contentClass,
        status,
      },
      select: {
        id: true,
        campaignId: true,
        originalFileUrl: true,
        durationMs: true,
        detectedLanguage: true,
        rawTranscript: true,
        reviewedTranscript: true,
        confidence: true,
        contentClass: true,
        status: true,
        createdAt: true,
        updatedAt: true
      }
    }) as AudioInstructionRecord;

    return this.toResult(created);
  }

  async list(params: ListAudioInstructionsParams): Promise<AudioInstructionResult[]> {
    const records = await (this.prisma.db.userAudioInstruction as any).findMany({
      where: {
        ...(params.campaignId ? { campaignId: params.campaignId } : {}),
        ...(params.status ? { status: params.status } : {})
      },
      orderBy: { createdAt: "desc" },
      take: params.limit,
      select: {
        id: true,
        campaignId: true,
        originalFileUrl: true,
        durationMs: true,
        detectedLanguage: true,
        rawTranscript: true,
        reviewedTranscript: true,
        confidence: true,
        contentClass: true,
        status: true,
        createdAt: true,
        updatedAt: true
      }
    }) as AudioInstructionRecord[];

    return records.map((record) => this.toResult(record));
  }

  async update(id: string, input: UpdateAudioInstructionInput): Promise<AudioInstructionResult> {
    const exists = await (this.prisma.db.userAudioInstruction as any).findUnique({
      where: { id }
    }) as AudioInstructionRecord | null;

    if (!exists) {
      throw new NotFoundException("Audio instruction not found");
    }

    const confidence = sanitizeConfidence(input.confidence);
    const nextStatus = normalizeStatus(input.status, exists.rawTranscript ?? undefined, confidence ?? exists.confidence);

    const updated = await (this.prisma.db.userAudioInstruction as any).update({
      where: { id },
      data: {
        ...(input.status ? { status: nextStatus } : {}),
        ...(input.reviewedTranscript !== undefined ? { reviewedTranscript: input.reviewedTranscript?.trim() ?? null } : {}),
        ...(input.contentClass ? { contentClass: input.contentClass.trim() } : {}),
        ...(confidence !== null ? { confidence } : {})
      },
      select: {
        id: true,
        campaignId: true,
        originalFileUrl: true,
        durationMs: true,
        detectedLanguage: true,
        rawTranscript: true,
        reviewedTranscript: true,
        confidence: true,
        contentClass: true,
        status: true,
        createdAt: true,
        updatedAt: true
      }
    }) as AudioInstructionRecord;

    return this.toResult(updated);
  }

  private toResult(record: AudioInstructionRecord): AudioInstructionResult {
    return {
      id: record.id,
      campaignId: record.campaignId,
      originalFileUrl: record.originalFileUrl,
      durationMs: record.durationMs,
      detectedLanguage: record.detectedLanguage,
      rawTranscript: record.rawTranscript,
      reviewedTranscript: record.reviewedTranscript,
      confidence: record.confidence,
      contentClass: record.contentClass,
      status: inferStatus(record),
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString()
    };
  }
}

function inferStatus(record: AudioInstructionRecord): string {
  if (!record.rawTranscript || !record.rawTranscript.trim()) {
    return "transcribing";
  }

  return record.status;
}
