import { createRequire } from "node:module";
import { Worker } from "bullmq";
import { loadEnv } from "@cognita-campaign/config";
import { evaluateSendRisk, type SendPolicyContext } from "@cognita-campaign/domain";

type QueueJobPayload = {
  scheduledJobId: string;
};

type PrismaClientLike = {
  [key: string]: any;
  scheduledJob: any;
  sendAttempt: any;
  campaign: any;
  $disconnect: () => Promise<void>;
};

type WebProviderHealth = {
  connected: boolean;
  loggedIn: boolean;
};

type RawScheduledJob = {
  id: string;
  campaignId: string;
  workflowStepId: string;
  channel: "uazapi_group";
  runAt: Date;
  status: string;
  idempotencyKey: string;
  payloadJson: Record<string, unknown> | null;
  attemptCount: number;
  maxAttempts: number;
  groupTargetId: string | null;
  channelAccountId: string | null;
  campaign?: {
    id: string;
    status: string;
  };
  groupTarget?: {
    id: string;
    remoteJid: string;
    allowlisted: boolean;
    ownerCanSendMessage: boolean;
    instanceConnected: boolean;
  };
};

const ALLOWED_STATES_FOR_RUN = ["queued", "retrying", "blocked"] as const;
const QUEUE_NAME = "campaign-jobs";

class UazapiSender {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string
  ) {}

  async send(input: {
    accountId: string;
    groupJid: string;
    text: string;
    trackId: string;
  }) {
    const payloads = [
      {
        accountId: input.accountId,
        number: input.groupJid,
        to: input.groupJid,
        groupJid: input.groupJid,
        text: input.text,
        body: input.text,
        trackId: input.trackId,
        trackSource: input.accountId
      },
      {
        accountId: input.accountId,
        recipient: input.groupJid,
        jid: input.groupJid,
        message: input.text,
        trackId: input.trackId,
        track_source: input.accountId,
        track: input.trackId
      },
      {
        accountId: input.accountId,
        target: input.groupJid,
        chatId: input.groupJid,
        content: input.text,
        text: input.text,
        trackId: input.trackId,
        trackSource: input.accountId
      }
    ];

    const paths = ["/send/text", "/messages/send", "/group/send/text", "/group/send/message"];
    const query = new URLSearchParams({ token: this.token });

    let lastError: unknown = new Error("uazapi send failed");
    for (const path of paths) {
      for (const payload of payloads) {
        try {
          const response = await fetch(new URL(path + `?${query.toString()}`, this.baseUrl), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Accept: "application/json",
              token: this.token
            },
            body: JSON.stringify(payload)
          });

          const raw = await response.text();
          let responsePayload: unknown = null;
          try {
            responsePayload = raw ? JSON.parse(raw) : null;
          } catch {
            responsePayload = raw;
          }

          if (!response.ok) {
            const message = this.readErrorFromPayload(responsePayload, `UAZAPI request failed ${response.status}`);
            throw new Error(message);
          }

          const normalized = this.extractStatus(responsePayload);
          const providerMessageId =
            normalized.messageId || normalized.msgId || normalized.providerMessageId || "unknown";
          const status = normalized.status.toLowerCase();

          if (status.includes("error") || status.includes("fail")) {
            throw new Error(this.readErrorFromPayload(responsePayload, "UAZAPI send failed"));
          }

          return {
            providerMessageId,
            status: status.includes("sent") || status.includes("delivered") ? "sent" : "accepted",
            raw: responsePayload
          };
        } catch (error) {
          lastError = error;
        }
      }
    }

    if (lastError instanceof Error) {
      throw lastError;
    }
    throw new Error(String(lastError));
  }

  private extractStatus(payload: unknown) {
    if (!payload || typeof payload !== "object") {
      return { status: "accepted", messageId: undefined, msgId: undefined, providerMessageId: undefined };
    }

    const candidate = payload as Record<string, unknown>;
    return {
      status: this.readString(candidate.status) || this.readString(candidate.result) || "accepted",
      messageId: this.readString(candidate.messageId) || this.readString(candidate.wamid),
      msgId: this.readString(candidate.msgId),
      providerMessageId: this.readString(candidate.providerMessageId)
    };
  }

  private readErrorFromPayload(payload: unknown, fallback: string) {
    if (!payload || typeof payload !== "object") {
      return fallback;
    }

    const candidate = payload as Record<string, unknown>;
    const candidateMessage = this.readString(candidate.message);
    if (candidateMessage) {
      return candidateMessage;
    }

    if (typeof candidate.error === "object" && candidate.error !== null) {
      return this.readString((candidate.error as Record<string, unknown>).message);
    }

    return fallback;
  }

  private readString(value: unknown) {
    return typeof value === "string" ? value : "";
  }
}

async function run() {
  const env = loadEnv(process.env);
  const require = createRequire(import.meta.url);
  const PrismaClient = (require("@prisma/client") as { PrismaClient?: new (args: unknown) => unknown }).PrismaClient;

  if (!PrismaClient) {
    throw new Error("Prisma Client module is not generated yet. Run `pnpm prisma generate` before starting worker.");
  }

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: env.DATABASE_URL
      }
    }
  }) as PrismaClientLike;

  const redisUrl = new URL(env.REDIS_URL);
  const connection = {
    host: redisUrl.hostname || "127.0.0.1",
    port: Number(redisUrl.port || 6379),
    username: redisUrl.username || undefined,
    password: redisUrl.password || undefined
  };

  const sender = new UazapiSender(env.UAZAPI_BASE_URL, env.UAZAPI_GABRIEL_INSTANCE_TOKEN || "");

  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const payload = job.data as QueueJobPayload;

      const scheduledJob = (await prisma.scheduledJob.findUnique({
        where: { id: payload.scheduledJobId },
        include: {
          campaign: {
            select: {
              id: true,
              status: true
            }
          },
          groupTarget: {
            select: {
              id: true,
              remoteJid: true,
              allowlisted: true,
              ownerCanSendMessage: true,
              instanceConnected: true
            }
          }
        }
      })) as RawScheduledJob | null;

      if (!scheduledJob) {
        return;
      }

      if (!ALLOWED_STATES_FOR_RUN.includes(scheduledJob.status as (typeof ALLOWED_STATES_FOR_RUN)[number])) {
        return;
      }

      const senderPayload = scheduledJob.payloadJson ?? {};
      const campaignId = thisReadString(senderPayload.campaignId) || scheduledJob.campaignId;
      const groupJid = thisReadString(senderPayload.groupJid);
      const message = thisReadString(senderPayload.message);
      const trackId = thisReadString(senderPayload.trackId);
      const accountId = thisReadString(senderPayload.accountId);
      const messageVersionId = thisReadString(senderPayload.messageVersionId) || "group_message";

      if (!groupJid || !message || !accountId) {
        await markScheduledJobFailed({
          prisma,
          scheduledJob,
          campaign: scheduledJob.campaign,
          error: "Missing required send payload fields",
          permanent: true
        });
        return;
      }

      const risk = await evaluateSendRisk(
        buildGroupRiskContext({
          campaignStatus: scheduledJob.campaign?.status,
          groupTarget: scheduledJob.groupTarget,
          runAt: scheduledJob.runAt
        })
      );

      if (risk.decision === "block") {
        await markScheduledJobBlocked({
          prisma,
          scheduledJob,
          campaign: scheduledJob.campaign,
          reasons: risk.reasons
        });
        return;
      }

      const sendAttempt = await upsertSendAttempt({
        prisma,
        scheduledJobId: scheduledJob.id,
        campaignId,
        workflowStepId: scheduledJob.workflowStepId,
        groupTargetId: scheduledJob.groupTargetId,
        idempotencyKey: scheduledJob.idempotencyKey,
        accountId,
        message,
        messageVersionId
      });

      await prisma.scheduledJob.update({
        where: { id: scheduledJob.id },
        data: {
          status: "running",
          updatedAt: new Date(),
          attemptCount: {
            increment: 1
          }
        }
      });

      await prisma.sendAttempt.update({
        where: { id: sendAttempt.id },
        data: {
          status: "running",
          startedAt: new Date(),
          requestPayloadJson: senderPayload
        }
      });

      try {
        const result = await sender.send({
          accountId,
          groupJid,
          text: message,
          trackId
        });

        await prisma.sendAttempt.update({
          where: { id: sendAttempt.id },
          data: {
            status: result.status,
            providerMessageId: result.providerMessageId,
            completedAt: ["sent", "delivered", "read"].includes(result.status) ? new Date() : undefined,
            responsePayloadJson: result.raw
          }
        });

        await prisma.scheduledJob.update({
          where: { id: scheduledJob.id },
          data: {
            status: "done",
            updatedAt: new Date()
          }
        });

        await prisma.campaign.update({
          where: { id: campaignId },
          data: { status: "running" }
        });

        return;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        const isTransient = isTransientSendError(errorMessage);
        const attemptsLeft = scheduledJob.maxAttempts - scheduledJob.attemptCount;

        if (isTransient && attemptsLeft > 1) {
          await prisma.sendAttempt.update({
            where: { id: sendAttempt.id },
            data: {
              status: "failed",
              errorCode: "transient_failure",
              errorMessage,
              completedAt: undefined
            }
          });

          await prisma.scheduledJob.update({
            where: { id: scheduledJob.id },
            data: {
              status: "retrying",
              errorCode: "transient_failure",
              errorMessage
            }
          });

          throw new Error(errorMessage);
        }

        await markScheduledJobFailed({
          prisma,
          scheduledJob,
          campaign: scheduledJob.campaign,
          error: errorMessage,
          permanent: true
        });
        return;
      }
    },
    { connection, concurrency: 2 }
  );

  worker.on("completed", (job) => {
    console.log(JSON.stringify({ event: "job.completed", jobId: job.id }));
  });

  worker.on("failed", (job, error) => {
    console.error(JSON.stringify({
      event: "job.failed",
      jobId: job?.id,
      error: error instanceof Error ? error.message : String(error)
    }));
  });

  const shutdown = async () => {
    await worker.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function isTransientSendError(message: string) {
  const normalized = message.toLowerCase();
  return (
    normalized.includes("timeout") ||
    normalized.includes("timed out") ||
    normalized.includes("temporarily") ||
    normalized.includes("429") ||
    normalized.includes("500") ||
    normalized.includes("502") ||
    normalized.includes("503") ||
    normalized.includes("econn") ||
    normalized.includes("socket") ||
    normalized.includes("network") ||
    normalized.includes("connection")
  );
}

  async function markScheduledJobFailed(params: {
  prisma: PrismaClientLike;
  scheduledJob: RawScheduledJob;
  campaign?: RawScheduledJob["campaign"];
  error: string;
  permanent: boolean;
}) {
  await params.prisma.scheduledJob.update({
    where: { id: params.scheduledJob.id },
    data: {
      status: params.permanent ? "failed" : "retrying",
      errorCode: "send_error",
      errorMessage: params.error,
      updatedAt: new Date()
    }
  });

  await params.prisma.sendAttempt.updateMany({
    where: { idempotencyKey: params.scheduledJob.idempotencyKey },
    data: {
      status: "failed",
      errorCode: "send_error",
      errorMessage: params.error,
      completedAt: new Date()
    }
  });
}

  async function markScheduledJobBlocked(params: {
  prisma: PrismaClientLike;
  scheduledJob: RawScheduledJob;
  campaign?: RawScheduledJob["campaign"];
  reasons: string[];
}) {
  await params.prisma.scheduledJob.update({
    where: { id: params.scheduledJob.id },
    data: {
      status: "blocked",
      errorCode: "risk_blocked",
      errorMessage: params.reasons.join(", "),
      updatedAt: new Date()
    }
  });

  await params.prisma.sendAttempt.updateMany({
    where: { idempotencyKey: params.scheduledJob.idempotencyKey },
    data: {
      status: "blocked",
      errorCode: "risk_blocked",
      errorMessage: params.reasons.join(", ")
    }
  });
}

  async function upsertSendAttempt(params: {
  prisma: PrismaClientLike;
  scheduledJobId: string;
  campaignId: string;
  workflowStepId: string;
  groupTargetId: string | null;
  idempotencyKey: string;
  accountId: string;
  message: string;
  messageVersionId: string;
}) {
  const existing = await params.prisma.sendAttempt.findFirst({
    where: { idempotencyKey: params.idempotencyKey }
  }) as { id: string } | null;

  if (existing) {
    return existing;
  }

  return params.prisma.sendAttempt.create({
    data: {
      idempotencyKey: params.idempotencyKey,
      campaignId: params.campaignId,
      workflowStepId: params.workflowStepId,
      channel: "uazapi_group",
      provider: "uazapi",
      recipientType: "group",
      recipientId: params.groupTargetId ?? "group",
      groupId: params.groupTargetId,
      channelAccountId: null,
      scheduledJobId: params.scheduledJobId,
      scheduledAt: new Date(),
      status: "queued",
      templateKey: params.messageVersionId,
      renderedText: params.message,
      requestPayloadJson: {
        accountId: params.accountId,
        message: params.message
      }
    }
  }) as Promise<{ id: string }>;
}

function buildGroupRiskContext(params: {
  campaignStatus: string | undefined;
  groupTarget: RawScheduledJob["groupTarget"] | undefined;
  runAt: Date;
}) {
  const campaignApproved = params.campaignStatus === "templates_approved" || params.campaignStatus === "scheduled" || params.campaignStatus === "running" || params.campaignStatus === "paused" || params.campaignStatus === "completed";

  const context: SendPolicyContext = {
    campaignApproved,
    channelEnabled: true,
    providerHealth: {
      status: params.groupTarget?.instanceConnected ? "healthy" : "unhealthy",
      checkedAt: new Date()
    },
    messageVersionLocked: true,
    scheduledAt: params.runAt,
    recipientActive: true,
    hasOptOut: false,
    rateLimitAvailable: true,
    channel: "uazapi_group",
    campaignStatus: params.campaignStatus as SendPolicyContext["campaignStatus"],
    groupTarget: params.groupTarget
      ? {
          id: params.groupTarget.id,
          name: params.groupTarget.remoteJid,
          provider: "uazapi",
          remoteJid: params.groupTarget.remoteJid,
          allowlisted: params.groupTarget.allowlisted,
          ownerCanSendMessage: params.groupTarget.ownerCanSendMessage,
          instanceConnected: params.groupTarget.instanceConnected
        }
      : undefined,
    killSwitchGlobal: false,
    killSwitchChannel: false
  };

  return context;
}

function thisReadString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

void run();
