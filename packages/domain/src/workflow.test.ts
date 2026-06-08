import { describe, expect, it } from "vitest";
import { validateWorkflowDefinition } from "./workflow.js";

describe("workflow definition validation", () => {
  it("validates a valid workflow as valid", () => {
    const workflow = {
      version: "1.0",
      timezone: "America/Sao_Paulo",
      campaignId: "camp_123",
      entry: "start",
      nodes: [
        { id: "start", type: "start" },
        { id: "tpl1", type: "send_template", channel: "capsule_official", templateKey: "optin_1" },
        { id: "wait1", type: "wait_duration", durationMs: 60000, channel: undefined },
        { id: "end", type: "stop" }
      ],
      edges: [
        { from: "start", to: "tpl1" },
        { from: "tpl1", to: "wait1" },
        { from: "wait1", to: "end" }
      ]
    };

    const result = validateWorkflowDefinition(workflow);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("fails when start/entry is inconsistent", () => {
    const workflow = {
      version: "1.0",
      timezone: "America/Sao_Paulo",
      campaignId: "camp_123",
      entry: "not_start",
      nodes: [{ id: "start", type: "start" }, { id: "end", type: "stop" }],
      edges: [{ from: "start", to: "end" }]
    };

    const result = validateWorkflowDefinition(workflow);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === "INVALID_ENTRY")).toBe(true);
  });

  it("detects missing required fields in send_template", () => {
    const workflow = {
      version: "1.0",
      timezone: "America/Sao_Paulo",
      campaignId: "camp_123",
      entry: "start",
      nodes: [{ id: "start", type: "start" }, { id: "tpl1", type: "send_template", channel: "capsule_official" }],
      edges: [{ from: "start", to: "tpl1" }]
    };

    const result = validateWorkflowDefinition(workflow);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.code === "INVALID_NODE_FIELD")).toBe(true);
  });

  it("requires branch nodes to have at least two outgoing edges", () => {
    const workflow = {
      version: "1.0",
      timezone: "America/Sao_Paulo",
      campaignId: "camp_123",
      entry: "start",
      nodes: [
        { id: "start", type: "start" },
        { id: "branch", type: "branch_on_reply", channel: "kapso_official", parameters: { yesTemplate: "tpl_yes" } },
        { id: "yes", type: "stop" },
        { id: "no", type: "stop" }
      ],
      edges: [
        { from: "start", to: "branch" },
        { from: "branch", to: "yes", condition: "yes" }
      ]
    };

    const result = validateWorkflowDefinition(workflow);
    expect(result.valid).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes("branch_on_reply"))).toBe(true);
  });

  it("fails when edges reference unknown nodes", () => {
    const workflow = {
      version: "1.0",
      timezone: "America/Sao_Paulo",
      campaignId: "camp_123",
      entry: "start",
      nodes: [{ id: "start", type: "start" }, { id: "end", type: "stop" }],
      edges: [{ from: "start", to: "missing" }]
    };

    const result = validateWorkflowDefinition(workflow);
    expect(result.valid).toBe(false);
    expect(
      result.issues.some((issue) => issue.code === "MISSING_NODE_REFERENCE" && issue.path === "edges[0].to")
    ).toBe(true);
  });
});
