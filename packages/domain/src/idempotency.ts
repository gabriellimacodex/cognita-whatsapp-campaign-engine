export interface IdempotencyInput {
  campaignId: string;
  recipientScopeId: string;
  workflowStepId: string;
  scheduledAt: Date;
  messageVersionId: string;
}

export function buildIdempotencyKey(input: IdempotencyInput): string {
  return [
    input.campaignId,
    input.recipientScopeId,
    input.workflowStepId,
    input.scheduledAt.toISOString(),
    input.messageVersionId
  ].join(":");
}

