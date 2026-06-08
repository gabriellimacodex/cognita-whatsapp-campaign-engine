import type {
  WorkflowDefinition,
  WorkflowNode,
  WorkflowNodeType,
  WorkflowValidationResult,
  WorkflowValidationIssue
} from "./types.js";

type WorkflowValidationShape = Partial<WorkflowDefinition> & Record<string, unknown>;

function asIssue(code: WorkflowValidationIssue["code"], message: string, path: string): WorkflowValidationIssue {
  return { code, message, path };
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidTimezone(timezone: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

function isWorkflowNodeType(value: unknown): value is WorkflowNodeType {
  return (
    value === "start" ||
    value === "send_template" ||
    value === "send_text" ||
    value === "send_group_message" ||
    value === "wait_duration" ||
    value === "wait_until" ||
    value === "branch_on_reply" ||
    value === "manual_review" ||
    value === "stop"
  );
}

function validateNode(node: WorkflowNode, path: string): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];

  if (!hasText(node.id)) {
    issues.push(asIssue("INVALID_NODE", "Node id is required", `${path}.id`));
  }

  if (!isWorkflowNodeType(node.type)) {
    issues.push(asIssue("INVALID_NODE", "Node type is invalid", `${path}.type`));
    return issues;
  }

  if (node.type === "start" || node.type === "stop") {
    return issues;
  }

  if (
    (node.type === "send_template" ||
      node.type === "send_text" ||
      node.type === "send_group_message") &&
    !hasText(node.channel)
  ) {
    issues.push(asIssue("INVALID_NODE_FIELD", "Node requires channel", `${path}.channel`));
  }

  if (node.type === "send_template" && !hasText(node.templateKey)) {
    issues.push(asIssue("INVALID_NODE_FIELD", "Node requires templateKey", `${path}.templateKey`));
  }

  if (node.type === "send_text" && !hasText(node.messageKey)) {
    issues.push(asIssue("INVALID_NODE_FIELD", "Node requires messageKey", `${path}.messageKey`));
  }

  if (node.type === "send_group_message") {
    if (!hasText(node.groupKey)) {
      issues.push(asIssue("INVALID_NODE_FIELD", "Node requires groupKey", `${path}.groupKey`));
    }
    if (node.channel && node.channel !== "uazapi_group") {
      issues.push(asIssue("INVALID_NODE_FIELD", "send_group_message requires channel uazapi_group", `${path}.channel`));
    }
  }

  if (node.type === "wait_duration") {
    if (typeof node.durationMs !== "number" || !Number.isFinite(node.durationMs) || node.durationMs <= 0) {
      issues.push(asIssue("INVALID_NODE_FIELD", "Node durationMs must be a positive number", `${path}.durationMs`));
    }
  }

  if (node.type === "wait_until") {
    if (!hasText(node.at)) {
      issues.push(asIssue("INVALID_NODE_FIELD", "Node requires at", `${path}.at`));
    } else if (Number.isNaN(Date.parse(node.at))) {
      issues.push(asIssue("INVALID_NODE_FIELD", "Node at must be a valid ISO timestamp", `${path}.at`));
    }
  }

  if (node.type === "branch_on_reply" && isObject(node.parameters) === false) {
    issues.push(asIssue("INVALID_NODE_FIELD", "branch_on_reply requires parameters", `${path}.parameters`));
  }

  return issues;
}

function validateEdges(edges: unknown, nodeIds: Set<string>): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];

  if (!Array.isArray(edges) || edges.length === 0) {
    issues.push(asIssue("MISSING_EDGES", "Workflow must have at least one edge", "edges"));
    return issues;
  }

  edges.forEach((edge, idx) => {
    const path = `edges[${idx}]`;
    if (!isObject(edge)) {
      issues.push(asIssue("INVALID_NODE_FIELD", "Edge must have from and to", path));
      return;
    }

    if (!hasText(edge.from)) {
      issues.push(asIssue("INVALID_NODE_FIELD", "Edge must have from", `${path}.from`));
    } else if (!nodeIds.has(edge.from)) {
      issues.push(asIssue("MISSING_NODE_REFERENCE", `Edge references unknown from node '${edge.from}'`, `${path}.from`));
    }

    if (!hasText(edge.to)) {
      issues.push(asIssue("INVALID_NODE_FIELD", "Edge must have to", `${path}.to`));
    } else if (!nodeIds.has(edge.to)) {
      issues.push(asIssue("MISSING_NODE_REFERENCE", `Edge references unknown to node '${edge.to}'`, `${path}.to`));
    }
  });

  return issues;
}

function validateWorkflowConnectivity(
  nodes: WorkflowNode[],
  edges: WorkflowDefinition["edges"],
  entry: string
): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];

  const incomingCount = new Map<string, number>();
  const outgoingCount = new Map<string, number>();
  const outgoingTo = new Map<string, number>();
  nodes.forEach((node) => {
    incomingCount.set(node.id, 0);
    outgoingCount.set(node.id, 0);
  });

  for (const edge of edges) {
    const from = edge.from;
    const to = edge.to;
    if (typeof from === "string" && incomingCount.has(from)) {
      outgoingCount.set(from, (outgoingCount.get(from) ?? 0) + 1);
      outgoingTo.set(from, (outgoingTo.get(from) ?? 0) + 1);
    }
    if (typeof to === "string" && incomingCount.has(to)) {
      incomingCount.set(to, (incomingCount.get(to) ?? 0) + 1);
    }
  }

  const start = nodes.find((node) => node.id === entry);
  if (start) {
    if ((incomingCount.get(start.id) ?? 0) > 0) {
      issues.push(asIssue("INVALID_NODE", "Entry node must not have incoming edges", "entry"));
    }
  }

  for (const node of nodes) {
    const inCount = incomingCount.get(node.id) ?? 0;
    const outCount = outgoingCount.get(node.id) ?? 0;
    const index = nodes.findIndex((candidate) => candidate.id === node.id);

    if (node.id === entry) {
      continue;
    }

    if (node.type === "manual_review" || node.type === "stop") {
      continue;
    }

    if (node.type === "branch_on_reply" && (outgoingTo.get(node.id) ?? 0) < 2) {
      issues.push(asIssue("INVALID_NODE_FIELD", "branch_on_reply requires at least two outgoing edges", `nodes[${index}]`));
    }

    if (outCount === 0) {
      issues.push(asIssue("INVALID_NODE_FIELD", "Non-terminal node has no outgoing edges", `nodes[${index}]`));
    }

    if (inCount === 0) {
      issues.push(asIssue("INVALID_NODE_FIELD", "Node is unreachable (no incoming edges)", `nodes[${index}]`));
    }
  }

  return issues;
}

export function validateWorkflowDefinition(raw: unknown): WorkflowValidationResult {
  if (!isObject(raw)) {
    return {
      valid: false,
      issues: [asIssue("INVALID_NODE", "Workflow payload must be an object", "root")]
    };
  }

  const workflow = raw as WorkflowValidationShape;
  const issues: WorkflowValidationIssue[] = [];

  if (workflow.version !== "1.0") {
    issues.push(asIssue("MISSING_VERSION", "version must be '1.0'", "version"));
  }

  if (!hasText(workflow.timezone) || !isValidTimezone(workflow.timezone)) {
    issues.push(asIssue("MISSING_TIMEZONE", "timezone is missing or invalid", "timezone"));
  }

  if (!hasText(workflow.campaignId)) {
    issues.push(asIssue("INVALID_NODE", "campaignId is required", "campaignId"));
  }

  if (!hasText(workflow.entry)) {
    issues.push(asIssue("MISSING_ENTRY", "entry is required", "entry"));
  }

  if (!Array.isArray(workflow.nodes) || workflow.nodes.length === 0) {
    issues.push(asIssue("MISSING_NODES", "nodes array is required", "nodes"));
    return { valid: false, issues };
  }

  const nodes: WorkflowNode[] = [];
  const nodeIds = new Set<string>();
  const startIds = new Set<string>();

  workflow.nodes.forEach((node, index) => {
    if (!isObject(node)) {
      issues.push(asIssue("INVALID_NODE", "Node must be an object", `nodes[${index}]`));
      return;
    }
    const typedNode = node as WorkflowNode;
    nodes.push(typedNode);

    issues.push(...validateNode(typedNode, `nodes[${index}]`));

    if (typedNode.type === "start" && hasText(typedNode.id)) {
      startIds.add(typedNode.id);
    }

    if (hasText(typedNode.id)) {
      if (nodeIds.has(typedNode.id)) {
        issues.push(asIssue("DUPLICATE_NODE_ID", `Duplicate node id '${typedNode.id}'`, `nodes[${index}].id`));
      }
      nodeIds.add(typedNode.id);
    }
  });

  if (startIds.size === 0) {
    issues.push(asIssue("MISSING_START_NODE", "Workflow must contain a start node", "nodes"));
  }
  if (startIds.size > 1) {
    issues.push(asIssue("MULTIPLE_START_NODES", "Workflow must contain only one start node", "nodes"));
  }

  const startNodeId = workflow.entry;
  if (hasText(startNodeId) && !startIds.has(startNodeId)) {
    issues.push(asIssue("INVALID_ENTRY", "entry must reference a start node id", "entry"));
  }

  issues.push(...validateEdges(workflow.edges, nodeIds));

  if (Array.isArray(workflow.edges)) {
    issues.push(...validateWorkflowConnectivity(nodes, workflow.edges, hasText(startNodeId) ? startNodeId : ""));
  }

  return { valid: issues.length === 0, issues };
}
