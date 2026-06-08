import type {
  MessageRecord,
  MessagingProvider,
  SendMessageInput,
  SendResult,
  SendTemplateInput,
  TemplateProvider,
  SubmitTemplateInput,
  TemplateRecord,
  TemplateSubmissionResult
} from "@cognita-campaign/domain";
import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { AppConfigService } from "../config/app-config.service.js";

type RawTemplate = {
  id?: string;
  template_name?: string;
  name?: string;
  language?: string;
  status?: string;
  category?: string;
  template?: {
    name?: string;
    language?: string;
    status?: string;
    category?: string;
  };
};

type HealthStatus = {
  status?: string;
  healthy?: boolean;
  message?: string;
};

function normalizeTemplateStatus(rawStatus: string): TemplateRecord["status"] {
  const normalized = rawStatus.toLowerCase();
  if (
    normalized === "draft" ||
    normalized === "submitted" ||
    normalized === "approved" ||
    normalized === "rejected" ||
    normalized === "paused"
  ) {
    return normalized;
  }
  if (normalized === "pending") {
    return "submitted";
  }
  if (normalized === "active") {
    return "approved";
  }
  return "draft";
}

function coalesceTemplate(raw: unknown): TemplateRecord | null {
  const source = raw as RawTemplate | null;
  if (!source) {
    return null;
  }

  const id = (source.id ?? source.template_name ?? source.name ?? "").toString();
  if (!id) {
    return null;
  }

  const name = (source.name ?? source.template_name ?? "").toString();
  const status = normalizeTemplateStatus(
    (source.status ?? (source.template && source.template.status) ?? "draft").toString()
  );

  return {
    id,
    name,
    language: (source.language ?? "pt_BR").toString(),
    status,
    category: source.category ?? (source.template && source.template.category)
  };
}

@Injectable()
export class CapsuleAdapterService implements MessagingProvider, TemplateProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly enabled: boolean;
  private readonly logger = new Logger(CapsuleAdapterService.name);

  constructor(private readonly config: AppConfigService) {
    this.baseUrl = (config.env.CAPSULE_BASE_URL ?? "").replace(/\/+$/, "");
    this.apiKey = config.env.CAPSULE_API_KEY ?? "";
    this.enabled = Boolean(this.baseUrl && this.apiKey);

    if (!this.enabled) {
      this.logger.warn(
        "CAPSULE integration disabled. Configure CAPSULE_BASE_URL and CAPSULE_API_KEY to enable official provider operations."
      );
    }
  }

  private ensureConfigured(action: string): void {
    if (!this.enabled) {
      throw new Error(`CAPSULE integration is disabled. Cannot ${action} until CAPSULE_BASE_URL and CAPSULE_API_KEY are set.`);
    }
  }

  private async request<T>(path: string, options: { method?: "GET" | "POST"; body?: Record<string, unknown>; query?: Record<string, string> } = {}): Promise<T> {
    this.ensureConfigured("call Capsule API");
    const url = new URL(path.startsWith("/") ? path : `/${path}`, this.baseUrl);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        url.searchParams.set(key, value);
      }
    }

    const response = await fetch(url, {
      method: options.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${this.apiKey}`
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    const raw = await response.text();
    const payload = raw ? JSON.parse(raw) : null;

    if (!response.ok) {
      const message = payload && typeof payload === "object" && "message" in payload ? String(payload.message) : "Capsule request failed";
      throw new Error(String(message));
    }

    return payload as T;
  }

  private normalizeTemplateInput(rawTemplates: unknown): TemplateRecord[] {
    if (!Array.isArray(rawTemplates)) {
      return [];
    }

    return rawTemplates
      .map(coalesceTemplate)
      .filter((template): template is TemplateRecord => template !== null);
  }

  async getHealth(accountId: string): Promise<{ status: "healthy" | "unhealthy" | "degraded" | "unknown"; checkedAt: Date; reason?: string }> {
    this.ensureConfigured("check CAPSULE health");
    try {
      const payload = await this.request<HealthStatus>("/health");
      const normalized = payload.status?.toLowerCase();
      return {
        status: normalized === "ok" || normalized === "healthy" ? "healthy" : normalized === "degraded" ? "degraded" : "unhealthy",
        checkedAt: new Date(),
        reason: payload.message
      };
    } catch (error) {
      if (error instanceof Error && error.message === "CAPSULE_NOT_FOUND") {
        throw new NotFoundException(`Capsule account not found: ${accountId}`);
      }
      return {
        status: "unhealthy",
        checkedAt: new Date(),
        reason: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async sendMessage(input: SendMessageInput): Promise<SendResult> {
    this.ensureConfigured("send a message");
    const response = await this.request<{ messageId?: string; message_id?: string; status?: string }>(
      "/messages/text",
      {
        method: "POST",
        body: {
          accountId: input.accountId,
          recipient: input.recipient,
          message: input.text,
          trackId: input.trackId,
          metadata: input.metadata ?? {}
        }
      }
    );

    const providerMessageId = [response.messageId, response.message_id].find(Boolean) as string | undefined;
    return {
      providerMessageId: providerMessageId ?? "unknown",
      status: (response.status ?? "accepted") as SendResult["status"],
      raw: response
    };
  }

  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    this.ensureConfigured("send a template");
    const response = await this.request<{ messageId?: string; message_id?: string; status?: string }>(
      "/messages/template",
      {
        method: "POST",
        body: {
          accountId: input.accountId,
          recipient: input.recipient,
          templateName: input.templateName,
          language: input.language,
          parameters: input.parameters,
          trackId: input.trackId,
          metadata: {}
        }
      }
    );

    const providerMessageId = [response.messageId, response.message_id].find(Boolean) as string | undefined;
    return {
      providerMessageId: providerMessageId ?? "unknown",
      status: (response.status ?? "accepted") as SendResult["status"],
      raw: response
    };
  }

  async getMessage(messageId: string): Promise<MessageRecord | null> {
    this.ensureConfigured("get a message");
    const response = await this.request<{ id?: string; status?: string; raw?: unknown }>(`/messages/${messageId}`, {
      method: "GET"
    });
    if (!response || !response.id) {
      return null;
    }
    return {
      id: String(response.id),
      status: String(response.status ?? "unknown"),
      raw: response.raw ?? response
    };
  }

  async listTemplates(accountId: string): Promise<TemplateRecord[]> {
    this.ensureConfigured("list templates");
    const payload = await this.request<unknown>("/templates", {
      method: "GET",
      query: { accountId }
    });

    if (!payload || typeof payload !== "object" || !("templates" in payload)) {
      return this.normalizeTemplateInput(payload as unknown[]);
    }

    const list = (payload as { templates: unknown }).templates;
    return this.normalizeTemplateInput(list);
  }

  async submitTemplate(input: SubmitTemplateInput): Promise<TemplateSubmissionResult> {
    this.ensureConfigured("submit a template");
    const payload = await this.request<{
      id?: string;
      templateName?: string;
      status?: string;
      name?: string;
      language?: string;
    }>("/templates", {
      method: "POST",
      body: {
        accountId: input.accountId,
        name: input.name,
        language: input.language,
        category: input.category,
        body: input.body,
        example: input.example
      }
    });

    return {
      providerTemplateId: (payload.id ?? payload.templateName ?? payload.name ?? "unknown").toString(),
      status: normalizeTemplateStatus((payload.status ?? "draft").toString()),
      raw: payload
    };
  }

  async getTemplateStatus(accountId: string, templateName: string): Promise<TemplateRecord | null> {
    this.ensureConfigured("check template status");
    try {
      const payload = await this.request<RawTemplate>(`/templates/${encodeURIComponent(templateName)}`, {
        method: "GET",
        query: { accountId }
      });
      return coalesceTemplate(payload);
    } catch {
      return null;
    }
  }
}
