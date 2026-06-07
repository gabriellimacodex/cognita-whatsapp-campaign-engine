import { describe, expect, it } from "vitest";
import { evaluateSendRisk } from "./risk-engine.js";
import type { SendPolicyContext } from "./types.js";

const baseContext: SendPolicyContext = {
  campaignApproved: true,
  channelEnabled: true,
  providerHealth: { status: "healthy", checkedAt: new Date("2026-06-07T00:00:00.000Z") },
  messageVersionLocked: true,
  scheduledAt: new Date("2026-06-08T12:00:00.000Z"),
  recipientActive: true,
  hasOptOut: false,
  rateLimitAvailable: true,
  channel: "kapso_official",
  isOfficialBusinessInitiated: true,
  templateApproved: true,
  consentStatus: "opted_in"
};

describe("evaluateSendRisk", () => {
  it("allows a compliant official send", () => {
    expect(evaluateSendRisk(baseContext)).toEqual({ decision: "allow", reasons: [] });
  });

  it("blocks commercial templates for discovered contacts without opt-in", () => {
    const result = evaluateSendRisk({
      ...baseContext,
      consentStatus: "group_member_discovered",
      isCommercialTemplate: true
    });

    expect(result.decision).toBe("block");
    expect(result.reasons).toContain("commercial_template_requires_opt_in");
  });

  it("allows only opt-in request templates for discovered official contacts", () => {
    const result = evaluateSendRisk({
      ...baseContext,
      consentStatus: "group_member_discovered",
      isCommercialTemplate: false,
      isOptInRequestTemplate: true
    });

    expect(result.decision).toBe("allow");
  });

  it("blocks non-allowlisted group sends", () => {
    const result = evaluateSendRisk({
      ...baseContext,
      channel: "uazapi_group",
      isOfficialBusinessInitiated: false,
      groupTarget: {
        id: "grp_1",
        name: "Test",
        provider: "uazapi",
        remoteJid: "120363000000000000@g.us",
        allowlisted: false,
        ownerCanSendMessage: true,
        instanceConnected: true
      }
    });

    expect(result.decision).toBe("block");
    expect(result.reasons).toContain("group_not_allowlisted");
  });
});

