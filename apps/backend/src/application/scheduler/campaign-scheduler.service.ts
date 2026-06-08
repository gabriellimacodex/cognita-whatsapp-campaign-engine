import { randomUUID } from "node:crypto";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Queue } from "bullmq";
import {
  buildIdempotencyKey,
  type SendPolicyContext,
  type WorkflowDefinition,
  type WorkflowNode,
  evaluateSendRisk
} from "@cognita-campaign/domain";
import { AppConfigService } from "../../infrastructure/config/app-config.service.js";
import { PrismaService } from "../../infrastructure/prisma/prisma.service.js";
import { GroupSyncService } from "../group/group-sync.service.js";
import { CampaignService } from "../campaign/campaign.service.js";

type QueueJobPayload = {
  scheduledJobId: string;
};

interface ScheduleGroupCampaignInput {
  campaignId: string;
  accountId: string;
  startAt?: string;
  groupJid?: string;
}

interface ScheduleGroupCampaignResult {
  campaignId: string;
  campaignStatus: string;
  scheduleStartedAt: string;
  jobs: Array<{
    scheduledJobId: string;
    workflowStepId: string;
    runAt: string;
    status: string;
    idempotencyKey: string;
    groupTargetId: string;
  }>;
}

interface QueueResultRow {
  scheduledJobId: string;
  runAt: Date;
  status: string;
  idempotencyKey: string;
  workflowStepId: string;
  groupTargetId: string;
}

interface WorkflowNodeEdge {
  from: string;
  to: string;
}

interface ParsedWorkflow {
  nodesById: Record<string, WorkflowDefinition["nodes"][number]>;
  edges: WorkflowNodeEdge[];
}

interface ScheduleListItem {
  id: string;
  campaignId: string;
  workflowStepId: string;
  status: string;
  runAt: Date;
  idempotencyKey: string;
  attemptCount: number;
  maxAttempts: number;
  createdAt: Date;
}

interface GroupTargetState {
  id: string;
  remoteJid: string;
  allowlisted: boolean;
  ownerCanSendMessage: boolean;
  instanceConnected: boolean;
}

const ALLOWED_TEMPLATE_READY_STATES = ["templates_approved", "scheduled", "running", "paused", "completed"] as const;
const QUEUE_NAME = "campaign-jobs";

@Injectable()
export class CampaignSchedulerService {
  private readonly queue: Queue<QueueJobPayload>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly groupSync: GroupSyncService,
    private readonly campaignService: CampaignService,
    private readonly config: AppConfigService
  ) {
    const redisUrl = new URL(this.config.env.REDIS_URL);
    const connection = {
      host: redisUrl.hostname || "127.0.0.1",
      port: Number(redisUrl.port || 6379),
      username: redisUrl.username || undefined,
      password: redisUrl.password || undefined
    };

    this.queue = new Queue(QUEUE_NAME, { connection });
  }

  async scheduleGroupCampaign(input: ScheduleGroupCampaignInput): Promise<ScheduleGroupCampaignResult> {
    const campaign = await this.findCampaignForScheduling(input.campaignId);
    if (!campaign) {
      throw new NotFoundException("Campaign not found");
    }

    const startApproved = await this.campaignService.assertCampaignStartApproved(campaign.id);
    if (!startApproved) {
      throw new BadRequestException("Campaign must be approved for start before scheduling");
    }

    const campaignStatus = campaign.status as string;
    if (!ALLOWED_TEMPLATE_READY_STATES.includes(campaign.status as (typeof ALLOWED_TEMPLATE_READY_STATES)[number])) {
      throw new BadRequestException("Campaign is not ready for scheduling");
    }

    const workflowDefinition = campaign.workflowDefinitions[0];
    if (!workflowDefinition) {
      throw new BadRequestException("Campaign has no workflow definition");
    }

    const workflow = this.extractWorkflowDefinition(workflowDefinition.nodes, workflowDefinition.edges);
    const runOffsets = this.computeRunOffsets(workflow);

    const groupTarget = await this.getOrCreateGroupTarget(input.groupJid);
    const risk = await this.evaluateGroupCampaignRisk({ campaign: { id: campaign.id, status: campaignStatus }, groupTarget });
    if (risk.decision === "block") {
      throw new BadRequestException({ message: "Campaign risk blocked", reasons: risk.reasons });
    }

    const scheduleStartedAt = this.parseStartAt(input.startAt);
    const channelAccountId = await this.resolveChannelAccountId(input.accountId);

    const jobs: QueueResultRow[] = [];

    const sortedSteps = [...workflowDefinition.steps].sort((a, b) => a.sortIndex - b.sortIndex);
    for (const step of sortedSteps) {
      if (step.stepType !== "send_group_message") {
        continue;
      }

      const node = workflow.nodesById[step.stepKey] ?? null;
      if (!node) {
        continue;
      }

      const messageText = this.resolveGroupMessageText(step, node);
      if (!messageText) {
        continue;
      }

      const offsetMs = runOffsets[step.stepKey] ?? 0;
      let scheduledAt = new Date(scheduleStartedAt.getTime() + Math.max(offsetMs, 0));

      const parsedNodeAt = step.at;
      if (parsedNodeAt && parsedNodeAt.getTime() > scheduledAt.getTime()) {
        scheduledAt = parsedNodeAt;
      }

      const messageVersionId = step.messageKey || step.sourceHint || step.groupKey || "group_message";
      const idempotencyKey = buildIdempotencyKey({
            campaignId: campaign.id,
        recipientScopeId: groupTarget.id,
        workflowStepId: step.id,
        scheduledAt,
        messageVersionId
      });

      const existingJob = await (this.prisma.scheduledJob as any).findUnique({
        where: { idempotencyKey }
      }) as { id: string } | null;
      if (existingJob) {
        const existing = await (this.prisma.scheduledJob as any).findUnique({
          where: { id: existingJob.id }
        }) as {
          id: string;
          runAt: Date;
          status: string;
          idempotencyKey: string;
          workflowStepId: string;
          groupTargetId: string | null;
          attemptCount?: number;
        } | null;

        if (existing) {
          jobs.push({
            scheduledJobId: existing.id,
            runAt: existing.runAt,
            status: existing.status,
            idempotencyKey: existing.idempotencyKey,
            workflowStepId: existing.workflowStepId,
            groupTargetId: existing.groupTargetId ?? groupTarget.id
          });
        }
        continue;
      }

      const payloadJson = {
        accountId: input.accountId,
        groupJid: groupTarget.remoteJid,
        message: messageText,
        trackId: randomUUID(),
        messageVersionId,
        workflowStepId: step.id,
        campaignId: campaign.id,
        workflowNodeKey: step.stepKey
      } as Record<string, unknown>;

      const created = await (this.prisma.scheduledJob as any).create({
        data: {
          campaignId: campaign.id,
          workflowStepId: step.id,
          channel: "uazapi_group",
          runAt: scheduledAt,
          status: "queued",
          idempotencyKey,
          payloadJson,
          maxAttempts: 4,
          groupTargetId: groupTarget.id,
          channelAccountId,
          attemptCount: 0
        }
      }) as {
        id: string;
        idempotencyKey: string;
        status: string;
        runAt: Date;
        workflowStepId: string;
      };

      await this.enqueueScheduledJob(created.id, scheduledAt);

      jobs.push({
        scheduledJobId: created.id,
        runAt: created.runAt,
        status: created.status,
        idempotencyKey: created.idempotencyKey,
        workflowStepId: created.workflowStepId,
        groupTargetId: groupTarget.id
      });
    }

    await this.prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: "scheduled" }
    });

    return {
      campaignId: campaign.id,
      campaignStatus: "scheduled",
      scheduleStartedAt: scheduleStartedAt.toISOString(),
      jobs: jobs.map((job) => ({
        scheduledJobId: job.scheduledJobId,
        workflowStepId: job.workflowStepId,
        runAt: job.runAt.toISOString(),
        status: job.status,
        idempotencyKey: job.idempotencyKey,
        groupTargetId: job.groupTargetId
      }))
    };
  }

  async listJobs(campaignId: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, name: true }
    }) as { id: string; name: string } | null;

    if (!campaign) {
      throw new NotFoundException("Campaign not found");
    }

    const rows = (await (this.prisma.scheduledJob as any).findMany({
      where: { campaignId },
      orderBy: { runAt: "asc" }
    }) as Array<ScheduleListItem>)
      .map((row) => ({
        id: row.id,
        campaignId: row.campaignId,
        workflowStepId: row.workflowStepId,
        status: row.status,
        runAt: row.runAt,
        idempotencyKey: row.idempotencyKey,
        attemptCount: row.attemptCount,
        maxAttempts: row.maxAttempts,
        createdAt: row.createdAt
      }));

    return {
      campaignId: campaign.id,
      campaignName: campaign.name,
      jobs: rows.map((row) => ({
        ...row,
        runAt: row.runAt.toISOString(),
        createdAt: row.createdAt.toISOString()
      }))
    };
  }

  async pauseCampaign(campaignId: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, status: true }
    }) as { id: string; status: string } | null;

    if (!campaign) {
      throw new NotFoundException("Campaign not found");
    }

    const pendingJobs = (await (this.prisma.scheduledJob as any).findMany({
      where: {
        campaignId,
        status: { in: ["queued", "retrying", "running"] }
      },
      select: { id: true }
    }) as Array<{ id: string }>);

    for (const job of pendingJobs) {
      const queueJob = await this.queue.getJob(job.id);
      if (queueJob) {
        await queueJob.remove();
      }
    }

    await (this.prisma.scheduledJob as any).updateMany({
      where: {
        campaignId,
        status: { in: ["queued", "retrying", "running"] }
      },
      data: { status: "blocked" }
    });

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { status: "paused" }
    });

    return {
      campaignId,
      campaignStatus: campaign.status,
      status: "paused",
      jobsUpdated: pendingJobs.length
    };
  }

  async resumeCampaign(campaignId: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true, status: true }
    }) as { id: string; status: string } | null;

    if (!campaign) {
      throw new NotFoundException("Campaign not found");
    }

    const jobs = (await (this.prisma.scheduledJob as any).findMany({
      where: {
        campaignId,
        status: "blocked"
      },
      orderBy: { runAt: "asc" }
    }) as Array<{ id: string; runAt: Date }>);

    for (const job of jobs) {
      await this.enqueueScheduledJob(job.id, job.runAt);
    }

    await (this.prisma.scheduledJob as any).updateMany({
      where: {
        campaignId,
        status: "blocked"
      },
      data: { status: "queued" }
    });

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { status: campaign.status === "paused" ? "scheduled" : campaign.status }
    });

    return {
      campaignId,
      status: "resumed",
      jobsEnqueued: jobs.length
    };
  }

  async cancelCampaign(campaignId: string) {
    const campaign = await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      select: { id: true }
    }) as { id: string } | null;

    if (!campaign) {
      throw new NotFoundException("Campaign not found");
    }

    const jobs = (await (this.prisma.scheduledJob as any).findMany({
      where: {
        campaignId,
        status: { in: ["queued", "blocked", "retrying", "running"] }
      },
      select: { id: true }
    })) as Array<{ id: string }>;

    for (const job of jobs) {
      const queueJob = await this.queue.getJob(job.id);
      if (queueJob) {
        await queueJob.remove();
      }
    }

    await (this.prisma.scheduledJob as any).updateMany({
      where: {
        campaignId,
        status: { in: ["queued", "blocked", "retrying", "running"] }
      },
      data: { status: "cancelled" }
    });

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: { status: "paused" }
    });

    return {
      campaignId,
      status: "cancelled",
      jobsCancelled: jobs.length
    };
  }

  async cancelJob(jobId: string) {
    const job = await (this.prisma.scheduledJob as any).findUnique({
      where: { id: jobId },
      select: { campaignId: true, status: true, id: true }
    }) as { id: string; campaignId: string; status: string } | null;

    if (!job) {
      throw new NotFoundException("Scheduled job not found");
    }

    if (job.status !== "cancelled") {
      const queueJob = await this.queue.getJob(jobId);
      if (queueJob) {
        await queueJob.remove();
      }

      await (this.prisma.scheduledJob as any).update({
        where: { id: jobId },
        data: { status: "cancelled" }
      });
    }

    return {
      scheduledJobId: jobId,
      campaignId: job.campaignId,
      status: "cancelled"
    };
  }

  async rescheduleJob(jobId: string, runAt: string) {
    const parsedRunAt = new Date(runAt);
    if (Number.isNaN(parsedRunAt.getTime())) {
      throw new BadRequestException("runAt is invalid");
    }

    const job = await (this.prisma.scheduledJob as any).findUnique({
      where: { id: jobId },
      select: { id: true, status: true, campaignId: true }
    }) as { id: string; status: string; campaignId: string } | null;

    if (!job) {
      throw new NotFoundException("Scheduled job not found");
    }

    const bullJob = await this.queue.getJob(jobId);
    if (bullJob) {
      await bullJob.remove();
    }

    await (this.prisma.scheduledJob as any).update({
      where: { id: jobId },
      data: {
        runAt: parsedRunAt,
        status: "queued"
      }
    });

    await this.enqueueScheduledJob(jobId, parsedRunAt);

    return {
      scheduledJobId: jobId,
      campaignId: job.campaignId,
      status: "queued",
      runAt: parsedRunAt.toISOString()
    };
  }

  private async findCampaignForScheduling(campaignId: string) {
    return (await this.prisma.campaign.findUnique({
      where: { id: campaignId },
      include: {
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
    })) as {
      id: string;
      status: string;
      workflowDefinitions: Array<{
        id: string;
        nodes: unknown;
        edges: unknown;
        steps: Array<{
          id: string;
          stepKey: string;
          stepType: string;
          at: Date | null;
          durationMs: number | null;
          parameters: Record<string, unknown> | null;
          messageKey: string | null;
          sourceHint: string | null;
          groupKey: string | null;
          sortIndex: number;
        }>;
      }>;
    } | null;
  }

  private async getOrCreateGroupTarget(groupJid?: string): Promise<GroupTargetState> {
    const target = await this.groupSync.getTargetForGroupJid(groupJid);

    if (!target) {
      throw new BadRequestException("Unable to resolve target group");
    }

    return {
      id: target.id,
      remoteJid: target.remoteJid,
      allowlisted: target.allowlisted,
      ownerCanSendMessage: target.ownerCanSendMessage,
      instanceConnected: target.instanceConnected
    };
  }

  private parseStartAt(input?: string) {
    const scheduleStartedAt = input ? new Date(input) : new Date();
    if (Number.isNaN(scheduleStartedAt.getTime())) {
      throw new BadRequestException("startAt is invalid");
    }
    return scheduleStartedAt;
  }

  private extractWorkflowDefinition(rawNodes: unknown, rawEdges: unknown): ParsedWorkflow {
    const nodesById: Record<string, WorkflowNode> = {};

    if (Array.isArray(rawNodes)) {
      for (const node of rawNodes as Array<WorkflowNode>) {
        if (!node || typeof node.id !== "string" || !node.id.trim()) {
          continue;
        }
        nodesById[node.id] = node;
      }
    }

    const edges = Array.isArray(rawEdges)
      ? rawEdges
          .map((edge) => {
            if (!edge || typeof edge !== "object") {
              return null;
            }
            const candidate = edge as { from?: unknown; to?: unknown };
            const from = candidate.from;
            const to = candidate.to;
            if (typeof from !== "string" || typeof to !== "string") {
              return null;
            }
            return { from, to };
          })
          .filter((edge): edge is WorkflowNodeEdge => edge !== null && Boolean(nodesById[edge.from]) && Boolean(nodesById[edge.to]))
      : [];

    return { nodesById, edges };
  }

  private computeRunOffsets(workflow: ParsedWorkflow): Record<string, number> {
    const runOffsetByNodeId = new Map<string, number>();
    const completionByNodeId = new Map<string, number>();
    const incomingCount = new Map<string, number>();
    const outgoing = new Map<string, string[]>();

    const nodeIds = Object.keys(workflow.nodesById);
    for (const nodeId of nodeIds) {
      incomingCount.set(nodeId, 0);
      outgoing.set(nodeId, []);
    }

    for (const edge of workflow.edges) {
      const next = outgoing.get(edge.from);
      if (next) {
        next.push(edge.to);
      }
      incomingCount.set(edge.to, (incomingCount.get(edge.to) ?? 0) + 1);
    }

    const queue = nodeIds.filter((nodeId) => (incomingCount.get(nodeId) ?? 0) === 0);

    while (queue.length > 0) {
      const nodeId = queue.shift();
      if (!nodeId) {
        break;
      }

      const predecessors = this.findPredecessors(workflow.edges, nodeId);
      const predecessorCompleted = predecessors.length === 0
        ? 0
        : Math.max(...predecessors.map((id) => completionByNodeId.get(id) ?? 0));

      const node = workflow.nodesById[nodeId];
      if (!node) {
        continue;
      }

      let startOffset = predecessorCompleted;
      if (node.type === "wait_duration" && typeof node.durationMs === "number" && node.durationMs > 0) {
        startOffset = Math.max(startOffset, predecessorCompleted);
      }

      if (node.type === "wait_until" && typeof node.at === "string") {
        const absoluteOffset = Date.parse(node.at) - Date.now();
        if (!Number.isNaN(absoluteOffset)) {
          startOffset = Math.max(startOffset, absoluteOffset);
        }
      }

      const completionOffset = node.type === "wait_duration" && typeof node.durationMs === "number"
        ? startOffset + node.durationMs
        : Math.max(startOffset, 0);

      runOffsetByNodeId.set(nodeId, Math.max(startOffset, 0));
      completionByNodeId.set(nodeId, Math.max(completionOffset, 0));

      for (const to of outgoing.get(nodeId) ?? []) {
        const next = incomingCount.get(to);
        if (typeof next === "number") {
          const decreased = Math.max(next - 1, 0);
          incomingCount.set(to, decreased);
          if (decreased === 0) {
            queue.push(to);
          }
        }
      }
    }

    return Object.fromEntries(runOffsetByNodeId.entries());
  }

  private findPredecessors(edges: WorkflowNodeEdge[], targetNodeId: string): string[] {
    return edges
      .filter((edge) => edge.to === targetNodeId)
      .map((edge) => edge.from);
  }

  private resolveGroupMessageText(
    step: {
      messageKey: string | null;
      parameters: Record<string, unknown> | null;
      sourceHint: string | null;
    },
    node: WorkflowNode
  ): string {
    if (step.messageKey && step.messageKey.trim()) {
      return step.messageKey.trim();
    }

    if (step.parameters) {
      const direct = ["message", "text"].map((field) => step.parameters?.[field]).find((value) => typeof value === "string" && value.trim().length > 0);
      if (typeof direct === "string") {
        return direct.trim();
      }
    }

    if (step.sourceHint && step.sourceHint.trim()) {
      return step.sourceHint.trim();
    }

    if (typeof node.messageKey === "string" && node.messageKey.trim()) {
      return node.messageKey.trim();
    }

    if (typeof node.parameters === "object" && node.parameters !== null) {
      const direct = ["message", "text"].map((field) => (node.parameters as Record<string, unknown>)[field]).find((value) => {
        return typeof value === "string" && value.trim().length > 0;
      });
      if (typeof direct === "string") {
        return direct.trim();
      }
    }

    return "";
  }

  private async evaluateGroupCampaignRisk(input: {
    campaign: { id: string; status: string };
    groupTarget: GroupTargetState;
  }) {
    const providerHealth = await this.groupSync.getStatus();

    const context: SendPolicyContext = {
      campaignApproved: ALLOWED_TEMPLATE_READY_STATES.includes(input.campaign.status as (typeof ALLOWED_TEMPLATE_READY_STATES)[number]),
      campaignStatus: input.campaign.status as SendPolicyContext["campaignStatus"],
      channelEnabled: true,
      providerHealth: {
        status: providerHealth.connected ? "healthy" : "unhealthy",
        reason: providerHealth.reason,
        checkedAt: new Date()
      },
      messageVersionLocked: true,
      scheduledAt: new Date(),
      recipientActive: true,
      hasOptOut: false,
      rateLimitAvailable: true,
      channel: "uazapi_group",
      consentStatus: undefined,
      isOfficialBusinessInitiated: false,
      groupTarget: {
        id: input.groupTarget.id,
        name: input.groupTarget.remoteJid,
        provider: "uazapi",
        remoteJid: input.groupTarget.remoteJid,
        allowlisted: input.groupTarget.allowlisted,
        ownerCanSendMessage: input.groupTarget.ownerCanSendMessage,
        instanceConnected: input.groupTarget.instanceConnected
      },
      killSwitchGlobal: false,
      killSwitchChannel: false
    };

    return evaluateSendRisk(context);
  }

  private async resolveChannelAccountId(providerAccountId: string) {
    return (await this.prisma.channelAccount.findFirst({
      where: {
        provider: "uazapi",
        providerAccountId
      },
      select: { id: true }
    }) as { id: string } | null)?.id;
  }

  private async enqueueScheduledJob(scheduledJobId: string, runAt: Date) {
    const existingJob = await this.queue.getJob(scheduledJobId);
    if (existingJob) {
      await existingJob.remove();
    }

    const delayMs = Math.max(runAt.getTime() - Date.now(), 0);
    await this.queue.add("campaign.group_message", { scheduledJobId }, {
      jobId: scheduledJobId,
      delay: delayMs,
      attempts: 4,
      backoff: { type: "exponential", delay: 8000 },
      removeOnComplete: { age: 60 * 60, count: 1000 },
      removeOnFail: { age: 24 * 60 * 60 }
    });
  }
}
