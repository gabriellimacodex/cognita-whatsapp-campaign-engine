import type {
  ConsentStatus,
  ConsentTransition,
  ConsentTransitionAction,
  ConsentTransitionContext,
  ConsentTransitionResult
} from "./types.js";

const allowedTransitions: Record<ConsentStatus, ReadonlySet<ConsentStatus>> = {
  unknown: new Set(["group_member_discovered", "blocked"]),
  group_member_discovered: new Set(["consent_request_candidate", "blocked"]),
  consent_request_candidate: new Set(["opt_in_requested", "blocked"]),
  opt_in_requested: new Set(["opted_in", "opt_out", "expired", "blocked"]),
  opted_in: new Set(["opt_out", "blocked"]),
  opt_out: new Set(["blocked"]),
  expired: new Set(["blocked"]),
  blocked: new Set([])
};

const actionToTarget: Record<ConsentTransitionAction, ConsentStatus> = {
  discover_group_member: "group_member_discovered",
  request_opt_in: "consent_request_candidate",
  receive_opt_in_positive: "opted_in",
  receive_opt_in_negative: "opt_out",
  mark_expired: "expired",
  block_contact: "blocked"
};

function buildReason(action: ConsentTransitionAction, from: ConsentStatus): string {
  return `CONSENT_TRANSITION_INVALID_${String(action).toUpperCase()}_FROM_${from.toUpperCase()}`;
}

export function allowedConsentStatuses(from: ConsentStatus): ConsentStatus[] {
  return [...allowedTransitions[from]];
}

export function resolveConsentTransition(context: ConsentTransitionContext): ConsentTransitionResult {
  const to = actionToTarget[context.action];
  const allowed = allowedTransitions[context.currentStatus]?.has(to) ?? false;
  if (!allowed) {
    return {
      allowed: false,
      to: context.currentStatus,
      reasons: [buildReason(context.action, context.currentStatus)]
    };
  }

  return {
    allowed: true,
    to,
    reasons: []
  };
}

export function transitionConsent(context: ConsentTransitionContext): ConsentTransition {
  const result = resolveConsentTransition(context);
  return {
    from: context.currentStatus,
    to: result.to,
    action: context.action
  };
}

