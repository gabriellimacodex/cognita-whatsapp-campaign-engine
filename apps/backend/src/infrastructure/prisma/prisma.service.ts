import { Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { createRequire } from "node:module";
import { AppConfigService } from "../config/app-config.service.js";

type PrismaClientLike = {
  $connect: () => Promise<void>;
  $disconnect: () => Promise<void>;
  $transaction: <T>(fn: (tx: PrismaClientLike) => Promise<T>) => Promise<T>;
  [key: string]: any;
  groupTarget: Record<string, unknown>;
  contact: Record<string, unknown>;
  contactConsent: Record<string, unknown>;
  groupContactExtraction: Record<string, unknown>;
  campaign: Record<string, unknown>;
  campaignVersion: Record<string, unknown>;
  channelAccount: Record<string, unknown>;
  scheduledJob: Record<string, unknown>;
  sendAttempt: Record<string, unknown>;
  messageEvent: Record<string, unknown>;
  webhookEvent: Record<string, unknown>;
};

const require = createRequire(import.meta.url);

@Injectable()
export class PrismaService implements OnModuleInit, OnModuleDestroy {
  private readonly client: PrismaClientLike;

  constructor(private readonly config: AppConfigService) {
    const PrismaClient = (require("@prisma/client") as { PrismaClient?: new (args: unknown) => PrismaClientLike })
      .PrismaClient;

    if (!PrismaClient) {
      throw new Error(
        "Prisma Client module is not generated yet. Run `pnpm prisma generate` before starting backend."
      );
    }

    this.client = new PrismaClient({
      datasources: {
        db: {
          url: config.env.DATABASE_URL
        }
      }
    });
  }

  get groupTarget(): any {
    return this.client.groupTarget as any;
  }

  get contact(): any {
    return this.client.contact as any;
  }

  get contactConsent(): any {
    return this.client.contactConsent as any;
  }

  get groupContactExtraction(): any {
    return this.client.groupContactExtraction as any;
  }

  get campaign(): any {
    return this.client.campaign as any;
  }

  get campaignVersion(): any {
    return this.client.campaignVersion as any;
  }

  get db(): PrismaClientLike {
    return this.client as PrismaClientLike;
  }

  get webhookEvent(): any {
    return this.client.webhookEvent as any;
  }

  get messageEvent(): any {
    return this.client.messageEvent as any;
  }

  get sendAttempt(): any {
    return this.client.sendAttempt as any;
  }

  get scheduledJob(): any {
    return this.client.scheduledJob as any;
  }

  get userAudioInstruction(): any {
    return this.client.userAudioInstruction as any;
  }

  get channelAccount(): any {
    return this.client.channelAccount as any;
  }

  $transaction<T>(fn: (tx: PrismaClientLike) => Promise<T>): Promise<T> {
    return this.client.$transaction(fn as (tx: PrismaClientLike) => Promise<T>);
  }

  async onModuleInit() {
    await this.client.$connect();
  }

  async onModuleDestroy() {
    await this.client.$disconnect();
  }
}
