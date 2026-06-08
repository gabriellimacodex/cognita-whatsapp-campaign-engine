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

export type CampaignLifecycleAction =
  | "approve"
  | "submit_templates"
  | "templates_approved"
  | "schedule"
  | "run"
  | "pause"
  | "resume"
  | "complete"
  | "fail"
  | "restart";

export type ConsentTransitionAction =
  | "discover_group_member"
  | "request_opt_in"
  | "receive_opt_in_positive"
  | "receive_opt_in_negative"
  | "mark_expired"
  | "block_contact";

export type CampaignHealth = "on_track" | "at_risk" | "blocked";

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

export interface WorkflowValidationIssue {
  code:
    | "MISSING_VERSION"
    | "MISSING_TIMEZONE"
    | "MISSING_ENTRY"
    | "MISSING_NODES"
    | "MISSING_EDGES"
    | "INVALID_ENTRY"
    | "INVALID_NODE"
    | "DUPLICATE_NODE_ID"
    | "MISSING_NODE_REFERENCE"
    | "INVALID_NODE_FIELD"
    | "MISSING_START_NODE"
    | "MULTIPLE_START_NODES";
  message: string;
  path: string;
}

export interface WorkflowValidationResult {
  valid: boolean;
  issues: WorkflowValidationIssue[];
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

export interface CampaignPolicy {
  minimumApprovalForExecution: CampaignStatus[];
  scheduleWindowHours?: number;
  timezone: string;
}

export interface CampaignEntity {
  id: string;
  name: string;
  status: CampaignStatus;
  timezone: string;
  health: CampaignHealth;
  createdAt: Date;
  updatedAt: Date;
  policy?: CampaignPolicy;
}

export interface CampaignVersionEntity {
  id: string;
  campaignId: string;
  version: number;
  workflowJson: WorkflowDefinition;
  approvedAt?: Date;
  createdAt: Date;
}

export interface TemplateDraft {
  id: string;
  campaignId: string;
  key: string;
  channel: Channel;
  templateText: string;
  category: string;
  language: string;
  status: "draft" | "submitted" | "approved" | "rejected" | "archived";
  createdAt: Date;
  updatedAt: Date;
}

export interface ScheduledJob {
  id: string;
  campaignId: string;
  workflowStepId: string;
  channel: Channel;
  runAt: Date;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  payload: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
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
  campaignStatus?: CampaignStatus;
  campaignStartAt?: Date;
  killSwitchGlobal?: boolean;
  killSwitchChannel?: boolean;
  riskWindowMinutes?: number;
  dryRun?: boolean;
  payloadVersion?: string;
}

export interface ConsentTransition {
  from: ConsentStatus;
  to: ConsentStatus;
  action: ConsentTransitionAction;
}

export interface ConsentTransitionContext {
  action: ConsentTransitionAction;
  currentStatus: ConsentStatus;
  metadata?: Record<string, string>;
}

export interface ConsentTransitionResult {
  allowed: boolean;
  to: ConsentStatus;
  reasons: string[];
}

export interface RiskEvaluation {
  decision: RiskDecision;
  reasons: string[];
}
