import { describe, expect, it } from "vitest";
import { allowedConsentStatuses, resolveConsentTransition, transitionConsent } from "./consent.js";

describe("consent transition rules", () => {
  it("permite descoberta de grupo para status desconhecido", () => {
    const result = resolveConsentTransition({
      currentStatus: "unknown",
      action: "discover_group_member"
    });

    expect(result.allowed).toBe(true);
    expect(result.to).toBe("group_member_discovered");
    expect(result.reasons).toEqual([]);
  });

  it("bloqueia transicao de descoberto direto para opted_in", () => {
    const result = resolveConsentTransition({
      currentStatus: "group_member_discovered",
      action: "receive_opt_in_positive"
    });

    expect(result.allowed).toBe(false);
    expect(result.to).toBe("group_member_discovered");
    expect(result.reasons[0]).toMatch(/CONSENT_TRANSITION_INVALID/);
  });

  it("segue fluxo de opt-in para opted_in", () => {
    const result = resolveConsentTransition({
      currentStatus: "opt_in_requested",
      action: "receive_opt_in_positive"
    });

    expect(result.allowed).toBe(true);
    expect(result.to).toBe("opted_in");
  });

  it("marca blocked quando contato precisa de bloqueio", () => {
    const result = resolveConsentTransition({
      currentStatus: "opted_in",
      action: "block_contact"
    });

    expect(result.allowed).toBe(true);
    expect(result.to).toBe("blocked");
  });

  it("mapeia transicao para trilha de auditoria", () => {
    const transition = transitionConsent({
      currentStatus: "opt_in_requested",
      action: "receive_opt_in_negative"
    });

    expect(transition).toEqual({
      from: "opt_in_requested",
      to: "opt_out",
      action: "receive_opt_in_negative"
    });
  });

  it("expõe estados permitidos", () => {
    expect(allowedConsentStatuses("opt_in_requested")).toEqual(
      expect.arrayContaining(["opted_in", "opt_out", "expired", "blocked"])
    );
  });
});

