import type { RiskEvaluation, SendPolicyContext } from "./types.js";

export function evaluateSendRisk(context: SendPolicyContext): RiskEvaluation {
  const reasons: string[] = [];

  const campaignAllowedStatuses = new Set([
    "templates_approved",
    "scheduled",
    "running",
    "paused",
    "completed"
  ]);

  if (!context.campaignApproved) reasons.push("campaign_not_approved");
  if (context.campaignStatus && !campaignAllowedStatuses.has(context.campaignStatus)) {
    reasons.push(`campaign_status_${context.campaignStatus}_not_ready`);
  }
  if (!context.channelEnabled) reasons.push("channel_disabled");
  if (context.providerHealth.status === "unhealthy") reasons.push("provider_unhealthy");
  if (!context.messageVersionLocked) reasons.push("message_version_not_locked");
  if (!context.recipientActive) reasons.push("recipient_inactive");
  if (context.hasOptOut) reasons.push("recipient_opted_out");
  if (!context.rateLimitAvailable) reasons.push("rate_limit_unavailable");
  if (context.killSwitchGlobal) reasons.push("global_kill_switch_active");
  if (context.killSwitchChannel) reasons.push("channel_kill_switch_active");
  if (context.idempotencyAlreadySucceeded) reasons.push("idempotency_already_succeeded");

  if (context.channel === "uazapi_group") {
    if (!context.groupTarget?.allowlisted) reasons.push("group_not_allowlisted");
    if (!context.groupTarget?.ownerCanSendMessage) reasons.push("group_send_not_allowed");
    if (!context.groupTarget?.instanceConnected) reasons.push("uazapi_instance_disconnected");
  }

  if (typeof context.riskWindowMinutes === "number" && context.riskWindowMinutes >= 0) {
    const ageMinutes = (Date.now() - context.scheduledAt.getTime()) / 60_000;
    if (ageMinutes > context.riskWindowMinutes) {
      reasons.push("scheduled_at_outside_window");
    }
  }

  if (context.isOfficialBusinessInitiated && !context.templateApproved) {
    reasons.push("official_template_not_approved");
  }

  if (context.hasOptOut || context.consentStatus === "opt_out") {
    reasons.push("consent_opt_out");
  }

  if (context.isCommercialTemplate && context.consentStatus !== "opted_in") {
    reasons.push("commercial_template_requires_opt_in");
  }

  if (
    (context.consentStatus === "group_member_discovered" ||
      context.consentStatus === "consent_request_candidate") &&
    context.isOfficialBusinessInitiated &&
    !context.isOptInRequestTemplate
  ) {
    reasons.push("discovered_contact_only_allows_opt_in_request");
  }

  if (context.dryRun) {
    return { decision: "needs_manual_review", reasons: [...reasons, "dry_run"] };
  }

  if (context.providerHealth.status === "degraded" && reasons.length === 0) {
    return { decision: "needs_manual_review", reasons: ["provider_degraded"] };
  }

  return reasons.length > 0 ? { decision: "block", reasons } : { decision: "allow", reasons };
}
