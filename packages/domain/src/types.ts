export type CampaignStatus =
  | "draft"
  | "reviewed"
  | "templates_ready"
  | "templates_submitted"
  | "templates_approved"
  | "scheduled"
  | "running"
  | "paused"
  | "completed"
  | "failed";

export type Channel = "uazapi_group" | "kapso_official" | "capsule_official";

export type WorkflowNodeType =
  | "start"
  | "send_template"
  | "send_text"
  | "send_group_message"
  | "wait_duration"
  | "wait_until"
  | "branch_on_reply"
  | "manual_review"
  | "stop";

export type ConsentStatus =
  | "unknown"
  | "group_member_discovered"
  | "consent_request_candidate"
  | "opt_in_requested"
  | "opted_in"
  | "opt_out"
  | "expired"
  | "blocked";

export type SendAttemptStatus =
  | "queued"
  | "blocked"
  | "running"
  | "sent"
  | "delivered"
  | "read"
  | "failed"
  | "cancelled";

export type RiskDecision = "allow" | "block" | "needs_manual_review";

export interface ProviderHealth {
  status: "healthy" | "degraded" | "unhealthy" | "unknown";
  reason?: string;
  checkedAt: Date;
}

export interface WorkflowDefinition {
  version: "1.0";
  timezone: string;
  campaignId: string;
  entry: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowNode {
  id: string;
  type: WorkflowNodeType;
  channel?: Channel;
  templateKey?: string;
  messageKey?: string;
  groupKey?: string;
  at?: string;
  durationMs?: number;
  parameters?: Record<string, string>;
  source?: "text" | "image" | "audio" | "manual" | "webhook";
}

export interface WorkflowEdge {
  from: string;
  to: string;
  condition?: string;
}

export interface ContactConsent {
  contactId: string;
  phoneE164: string;
  status: ConsentStatus;
  source: "manual" | "group_member_discovered" | "crm" | "form" | "click_to_whatsapp";
  sourceGroupJid?: string;
  sourceGroupName?: string;
  requestedAt?: Date;
  confirmedAt?: Date;
  declinedAt?: Date;
  expiredAt?: Date;
}

export interface GroupTarget {
  id: string;
  name: string;
  provider: "uazapi";
  remoteJid: string;
  allowlisted: boolean;
  ownerCanSendMessage: boolean;
  instanceConnected: boolean;
}

export interface SendPolicyContext {
  campaignApproved: boolean;
  channelEnabled: boolean;
  providerHealth: ProviderHealth;
  messageVersionLocked: boolean;
  scheduledAt: Date;
  recipientActive: boolean;
  hasOptOut: boolean;
  rateLimitAvailable: boolean;
  channel: Channel;
  templateApproved?: boolean;
  isOfficialBusinessInitiated?: boolean;
  isCommercialTemplate?: boolean;
  isOptInRequestTemplate?: boolean;
  consentStatus?: ConsentStatus;
  groupTarget?: GroupTarget;
  idempotencyAlreadySucceeded?: boolean;
}

export interface RiskEvaluation {
  decision: RiskDecision;
  reasons: string[];
}

