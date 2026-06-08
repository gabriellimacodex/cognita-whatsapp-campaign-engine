import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import {
  validateWorkflowDefinition,
  type WorkflowDefinition,
  type WorkflowNode,
  type WorkflowValidationResult
} from "@cognita-campaign/domain";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";

interface CampaignCreateInput {
  name: string;
  timezone?: string;
  workflow: WorkflowDefinition | unknown;
}

interface CampaignCreateResult {
  campaignId: string;
  campaignVersionId: string;
  workflowDefinitionId: string | null;
  workflowStepsCount: number;
  status: string;
  workflowValidation: WorkflowValidationResult;
}

interface CampaignApprovalRecord {
  id: string;
  status: string;
  action: string;
  metadata: unknown;
  notes: string | null;
  reviewedBy: string | null;
  requestedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CampaignApprovalResult {
  action: CampaignApprovalAction;
  approvalId: string;
  campaignId: string;
  campaignStatus: string;
  status: string;
}

type ApprovalAction = "submit_campaign" | "review_workflow" | "approve_workflow" | "submit_template" | "approve_template" | "start_campaign" | "pause_campaign" | "resume_campaign" | "cancel_campaign";

type CampaignApprovalAction = Extract<
  ApprovalAction,
  "approve_workflow" | "approve_template" | "start_campaign"
>;

@Injectable()
export class CampaignService {
  constructor(private readonly prisma: PrismaService) {}

  private readonly allowedStartStatuses = new Set([
    "templates_approved",
    "scheduled",
    "running",
    "paused",
    "completed"
  ]);

  private normalizeTimezone(timezone?: string) {
    return timezone?.trim() || "America/Sao_Paulo";
  }

  async createDraftCampaign(input: CampaignCreateInput): Promise<CampaignCreateResult> {
    const workflowValidation = validateWorkflowDefinition(input.workflow);
    if (!workflowValidation.valid) {
      throw new BadRequestException({
        message: "Workflow invalid",
        issues: workflowValidation.issues
      });
    }

    const campaignName = input.name?.trim() || "Campanha sem nome";
    const timezone = this.normalizeTimezone(input.timezone);
    const workflow = input.workflow as WorkflowDefinition;

    const createdCampaign = await (this.prisma.db as any).campaign.create({
      data: {
        name: campaignName,
        timezone,
        status: "draft",
        versions: {
          create: {
            version: 1,
            workflowJson: workflow
          }
        },
        workflowDefinitions: {
          create: {
            workflowKey: workflow.campaignId || campaignName,
            version: 1,
            name: `${campaignName} v1`,
            timezone,
            entry: workflow.entry,
            nodes: workflow.nodes as unknown as unknown,
            edges: workflow.edges as unknown as unknown,
            source: "workflow_draft",
            steps: {
              create: this.makeWorkflowSteps(workflow)
            }
          }
        }
      },
      include: {
        versions: {
          orderBy: { version: "desc" },
          take: 1
        },
        workflowDefinitions: {
          orderBy: { version: "desc" },
          take: 1,
          include: {
            steps: {
              orderBy: { sortIndex: "asc" }
            }
          }
        }
      }
    }) as {
      id: string;
      status: string;
      versions: Array<{ id: string }>;
      workflowDefinitions: Array<{ id: string; steps: Array<{ id: string }> }>;
    };

    return {
      campaignId: createdCampaign.id,
      campaignVersionId: createdCampaign.versions[0]?.id ?? "",
      workflowDefinitionId: createdCampaign.workflowDefinitions[0]?.id ?? null,
      workflowStepsCount: createdCampaign.workflowDefinitions[0]?.steps.length ?? 0,
      status: createdCampaign.status,
      workflowValidation
    };
  }

  async listCampaigns(limit = 25) {
    const sanitizedLimit = Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 25;

    return (this.prisma.db as any).campaign.findMany({
      orderBy: { createdAt: "desc" },
      take: sanitizedLimit,
      include: {
        versions: {
          orderBy: { version: "desc" },
          take: 1
        },
        workflowDefinitions: {
          orderBy: { version: "desc" },
          take: 1,
          include: {
            steps: {
              orderBy: { sortIndex: "asc" },
              take: 40
            }
          }
        }
      }
    });
  }

  async getCampaignById(campaignId: string) {
    const campaign = await (this.prisma.db as any).campaign.findUnique({
      where: { id: campaignId }
    }) as { id: string; status: string } | null;

    if (!campaign) {
      throw new NotFoundException("Campaign not found");
    }

    return campaign;
  }

  async listCampaignApprovals(campaignId: string): Promise<CampaignApprovalRecord[]> {
    const records = (await (this.prisma.db as any).approval.findMany({
      where: {
        entityType: "campaign",
        entityId: campaignId
      },
      orderBy: { createdAt: "desc" }
    })) as Array<{
      id: string;
      status: string;
      action: string;
      metadata: unknown;
      notes: string | null;
      reviewedBy: string | null;
      requestedBy: string | null;
      decidedAt: Date | null;
      createdAt: Date;
      updatedAt: Date;
    }>;

    return records.map((approval) => ({
      id: approval.id,
      status: approval.status,
      action: approval.action,
      metadata: approval.metadata,
      notes: approval.notes,
      reviewedBy: approval.reviewedBy,
      requestedBy: approval.requestedBy,
      decidedAt: approval.decidedAt?.toISOString() ?? null,
      createdAt: approval.createdAt.toISOString(),
      updatedAt: approval.updatedAt.toISOString()
    }));
  }

  async approveCampaignWorkflow(campaignId: string, action: CampaignApprovalAction, reviewer: string = "system"): Promise<CampaignApprovalResult> {
    const campaign = await this.getCampaignById(campaignId);

    let campaignStatus = campaign.status;
    if (action === "approve_workflow") {
      if (campaignStatus !== "reviewed" && campaignStatus !== "templates_approved" && campaignStatus !== "scheduled" && campaignStatus !== "running") {
        campaignStatus = "reviewed";
      }
    } else if (action === "approve_template") {
      campaignStatus = "templates_approved";
    } else if (action === "start_campaign" && !this.allowedStartStatuses.has(campaignStatus)) {
      throw new BadRequestException("Campaign must be in templates_approved or later to approve start");
    }

    if (campaignStatus !== campaign.status) {
      await (this.prisma.db as any).campaign.update({
        where: { id: campaignId },
        data: { status: campaignStatus }
      });
    }

    const approval = await (this.prisma.db as any).approval.create({
      data: {
        entityType: "campaign",
        entityId: campaignId,
        action,
        status: "approved",
        reviewedBy: reviewer,
        decidedAt: new Date(),
        metadata: { source: "ui", action },
        notes: `${action} approved for campaign ${campaignId}`,
        campaignId
      },
      select: {
        id: true,
        status: true
      }
    }) as { id: string; status: string };

    return {
      action,
      approvalId: approval.id,
      campaignId,
      campaignStatus,
      status: approval.status
    };
  }

  async assertCampaignStartApproved(campaignId: string): Promise<boolean> {
    const exists = await (this.prisma.db as any).approval.findFirst({
      where: {
        entityType: "campaign",
        entityId: campaignId,
        action: "start_campaign",
        status: "approved"
      }
    }) as { id: string } | null;

    return Boolean(exists);
  }

  private makeWorkflowSteps(workflow: WorkflowDefinition) {
    return workflow.nodes
      .filter((node: WorkflowNode) => typeof node.id === "string" && node.id.trim().length > 0)
      .map((node: WorkflowNode, index: number) => ({
        stepKey: node.id,
        stepType: node.type,
        channel: node.channel ?? null,
        templateKey: node.templateKey ?? null,
        messageKey: node.messageKey ?? null,
        groupKey: node.groupKey ?? null,
        at: this.parseAt(node.at),
        durationMs: this.parseDurationMs(node.durationMs),
        parameters: (node.parameters as Record<string, unknown>) ?? null,
        sourceHint: node.source ?? null,
        displayName: `Nó ${node.id}`,
        isTerminal: node.type === "stop",
        sortIndex: index
      }));
  }

  private parseAt(value?: string): Date | null {
    if (!value) return null;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  private parseDurationMs(value?: number): number | null {
    if (typeof value !== "number") return null;
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
  }
}
