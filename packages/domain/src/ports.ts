import type { ProviderHealth } from "./types.js";

export interface SendResult {
  providerMessageId: string;
  status: "accepted" | "sent" | "failed";
  raw?: unknown;
}

export interface SendMessageInput {
  accountId: string;
  recipient: string;
  text: string;
  trackId: string;
  metadata?: Record<string, string>;
}

export interface SendTemplateInput {
  accountId: string;
  recipient: string;
  templateName: string;
  language: string;
  parameters: Record<string, string>;
  trackId: string;
}

export interface SendGroupMessageInput {
  accountId: string;
  groupJid: string;
  text: string;
  trackId: string;
  delayMs?: number;
}

export interface MessageRecord {
  id: string;
  status: string;
  raw?: unknown;
}

export interface MessagingProvider {
  getHealth(accountId: string): Promise<ProviderHealth>;
  sendMessage(input: SendMessageInput): Promise<SendResult>;
  sendTemplate(input: SendTemplateInput): Promise<SendResult>;
  getMessage(messageId: string): Promise<MessageRecord | null>;
}

export interface TemplateRecord {
  id: string;
  name: string;
  language: string;
  status: "draft" | "submitted" | "approved" | "rejected" | "paused";
  category?: string;
}

export interface SubmitTemplateInput {
  accountId: string;
  name: string;
  language: string;
  category: string;
  body: string;
  example?: Record<string, string>;
}

export interface TemplateSubmissionResult {
  providerTemplateId: string;
  status: TemplateRecord["status"];
  raw?: unknown;
}

export interface TemplateProvider {
  listTemplates(accountId: string): Promise<TemplateRecord[]>;
  submitTemplate(input: SubmitTemplateInput): Promise<TemplateSubmissionResult>;
  getTemplateStatus(accountId: string, templateName: string): Promise<TemplateRecord | null>;
}

export interface GroupRemoteRecord {
  jid: string;
  name: string;
  ownerCanSendMessage: boolean;
  ownerIsAdmin?: boolean;
  suspended?: boolean;
}

export interface GroupInstanceStatus {
  connected: boolean;
  loggedIn: boolean;
  status: "connected" | "disconnected" | "connecting" | "unknown";
  reason?: string;
}

export interface GroupProvider {
  getInstanceStatus(accountId: string): Promise<GroupInstanceStatus>;
  listGroups(accountId: string): Promise<GroupRemoteRecord[]>;
  sendGroupMessage(input: SendGroupMessageInput): Promise<SendResult>;
}

export interface ScheduledJobInput {
  idempotencyKey: string;
  runAt: Date;
  type: "send_group_message" | "send_template" | "extract_group_contacts";
  payload: Record<string, unknown>;
}

export interface ScheduledJobRef {
  id: string;
}

export interface SchedulerPort {
  enqueue(job: ScheduledJobInput): Promise<ScheduledJobRef>;
  cancel(jobId: string): Promise<void>;
  reschedule(jobId: string, runAt: Date): Promise<void>;
}

