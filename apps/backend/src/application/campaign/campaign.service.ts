import { BadRequestException, Injectable } from "@nestjs/common";
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

@Injectable()
export class CampaignService {
  constructor(private readonly prisma: PrismaService) {}

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
