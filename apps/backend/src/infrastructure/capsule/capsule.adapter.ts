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
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException
} from "@nestjs/common";
import { AppConfigService } from "../config/app-config.service.js";

const KAPSO_TEMPLATE_STATUS_MAP: Record<string, TemplateRecord["status"]> = {
  draft: "draft",
  submitted: "submitted",
  approved: "approved",
  rejected: "rejected",
  paused: "paused",
  active: "approved",
  pending: "submitted",
  disabled: "paused",
  rejected_review: "rejected",
  in_review: "submitted",
  blocked: "rejected"
};

const KAPSO_META_VERSION = "v24.0";

const META_TEMPLATE_PATHS = [
  `/platform/v1/meta/whatsapp/${KAPSO_META_VERSION}/{{businessAccountId}}/message_templates`,
  `/meta/whatsapp/${KAPSO_META_VERSION}/{{businessAccountId}}/message_templates`
];

const META_SEND_PATHS = [
  `/platform/v1/meta/whatsapp/${KAPSO_META_VERSION}/{{phoneNumberId}}/messages`,
  `/meta/whatsapp/${KAPSO_META_VERSION}/{{phoneNumberId}}/messages`
];

const WHATSAPP_PHONE_NUMBERS_PATHS = [
  "/platform/v1/whatsapp/phone_numbers",
  "/whatsapp/phone_numbers"
];

type RawTemplate = {
  id?: string;
  template_name?: string;
  name?: string;
  language?: string;
  status?: string;
  category?: string;
  component?: {
    type?: string;
  };
  code?: string;
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

type PhoneNumberInfo = {
  id?: string;
  phone_number_id?: string;
  phoneNumberId?: string;
  business_account_id?: string;
};

type MetaTemplateParameter = {
  type: "text";
  text: string;
  parameter_name?: string;
};

function asString(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return String(value);
}

function normalizeTemplateLanguage(language: unknown): string {
  const normalized = asString(language).trim();
  if (!normalized) {
    return "en_US";
  }
  return normalized;
}

function normalizeTemplateStatus(rawStatus: unknown): TemplateRecord["status"] {
  const normalized = asString(rawStatus).toLowerCase();
  return KAPSO_TEMPLATE_STATUS_MAP[normalized] ?? "draft";
}

function coalesceTemplate(raw: unknown): TemplateRecord | null {
  const source = raw as RawTemplate | null;
  if (!source) {
    return null;
  }

  const id = asString(source.id ?? source.template_name ?? source.name);
  if (!id) {
    return null;
  }

  const name = asString(source.name ?? source.template_name ?? id);
  const status = normalizeTemplateStatus(
    source.status ?? source.template?.status ?? "draft"
  );

  return {
    id,
    name,
    language: normalizeTemplateLanguage(source.language ?? source.code ?? source.template?.language),
    status,
    category: source.category ?? (source.template && source.template.category)
  };
}

@Injectable()
export class CapsuleAdapterService implements MessagingProvider, TemplateProvider {
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly providerLabel: "capsule" | "kapso";
  private readonly enabled: boolean;
  private readonly logger = new Logger(CapsuleAdapterService.name);

  constructor(private readonly config: AppConfigService) {
    const capsuleBaseUrl = (config.env.CAPSULE_BASE_URL ?? "").replace(/\/+$/, "");
    const capsuleApiKey = config.env.CAPSULE_API_KEY ?? "";
    const kapsoBaseUrl = (config.env.KAPSO_BASE_URL ?? "").replace(/\/+$/, "");
    const kapsoApiKey = config.env.KAPSO_API_KEY ?? "";

    if (capsuleBaseUrl && capsuleApiKey) {
      this.baseUrl = capsuleBaseUrl;
      this.apiKey = capsuleApiKey;
      this.providerLabel = "capsule";
      this.enabled = true;
    } else if (kapsoBaseUrl && kapsoApiKey) {
      this.baseUrl = kapsoBaseUrl;
      this.apiKey = kapsoApiKey;
      this.providerLabel = "kapso";
      this.enabled = true;
    } else {
      this.baseUrl = "";
      this.apiKey = "";
      this.providerLabel = "capsule";
      this.enabled = false;
    }

    if (!this.enabled) {
      this.logger.warn(
        "CAPSULE integration disabled. Configure CAPSULE_BASE_URL and CAPSULE_API_KEY or KAPSO_BASE_URL and KAPSO_API_KEY."
      );
    } else {
      this.logger.log(
        `${this.providerLabel.toUpperCase()} official provider configured at ${this.baseUrl}`
      );
    }
  }

  private ensureConfigured(action: string): void {
    if (!this.enabled) {
      throw new BadRequestException(
        "CAPSULE integration is disabled. Configure CAPSULE_BASE_URL/CAPSULE_API_KEY or KAPSO_BASE_URL/KAPSO_API_KEY."
      );
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
        Authorization: `Bearer ${this.apiKey}`,
        "x-api-key": this.apiKey
      },
      body: options.body ? JSON.stringify(options.body) : undefined
    });

    const raw = await response.text();
    let payload: unknown = null;
    try {
      payload = raw ? JSON.parse(raw) : null;
    } catch {
      payload = raw;
    }

    if (!response.ok) {
      const message = payload && typeof payload === "object" && "message" in payload ? String(payload.message) : "Capsule request failed";
      throw new Error(String(message));
    }

    return payload as T;
  }

  private async requestAnyPath<T>(
    paths: string[],
    options: {
      method?: "GET" | "POST";
      body?: Record<string, unknown>;
      query?: Record<string, string>;
    } = {}
  ): Promise<T> {
    let lastError: Error | null = null;
    for (const path of paths) {
      try {
        return await this.request<T>(path, options);
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
      }
    }
    throw lastError ?? new Error("Capsule API request failed");
  }

  private resolvePathTemplate(template: string, context: Record<string, string>): string {
    return Object.entries(context).reduce((nextPath, [placeholder, value]) => {
      return nextPath.replace(`{{${placeholder}}}`, encodeURIComponent(value));
    }, template);
  }

  private async resolveBusinessAccountId(inputAccountId: string): Promise<string> {
    try {
      const candidates = await this.requestAnyPath<{ data?: unknown }>(
        WHATSAPP_PHONE_NUMBERS_PATHS.map((path) => `${path}?phone_number_id=${encodeURIComponent(inputAccountId)}`),
        { method: "GET", query: {} }
      );
      const list = this.extractArray(candidates);
      const direct = list.find(
        (entry): entry is PhoneNumberInfo => Boolean(this.extractString(entry, "phone_number_id") || this.extractString(entry, "id"))
      );
      const resolved = this.extractString(direct, "business_account_id");
      if (resolved) return resolved;
    } catch {
      // fallback to configured account id when API cannot map phone to business account
    }

    return inputAccountId;
  }

  private async resolvePhoneNumberId(inputAccountId: string): Promise<string> {
    try {
      const candidates = await this.requestAnyPath<{ data?: unknown }>(
        WHATSAPP_PHONE_NUMBERS_PATHS.map((path) => `${path}?business_account_id=${encodeURIComponent(inputAccountId)}`),
        { method: "GET", query: {} }
      );
      const list = this.extractArray(candidates);
      const direct = list.find((entry) => this.extractString(entry, "id"));
      const resolved = this.extractString(direct, "id") || this.extractString(direct, "phone_number_id") || this.extractString(direct, "phoneNumberId");
      if (resolved) return resolved;
    } catch {
      // fallback to incoming accountId
    }

    return inputAccountId;
  }

  private extractArray(payload: unknown): unknown[] {
    if (Array.isArray(payload)) {
      return payload;
    }
    if (payload && typeof payload === "object") {
      const candidate = payload as { data?: unknown; templates?: unknown; result?: unknown };
      if (Array.isArray(candidate.data)) {
        return candidate.data;
      }
      if (Array.isArray(candidate.templates)) {
        return candidate.templates;
      }
      if (Array.isArray(candidate.result)) {
        return candidate.result;
      }
    }
    return [];
  }

  private extractString(entry: unknown, key: string): string {
    if (!entry || typeof entry !== "object") {
      return "";
    }
    return asString((entry as Record<string, unknown>)[key]);
  }

  private extractTemplateMessages(payload: unknown): string | undefined {
    const root = (payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null);
    if (!root) {
      return undefined;
    }
    const messages = root.messages;
    if (Array.isArray(messages)) {
      const first = messages[0];
      if (first && typeof first === "object") {
        const msg = first as Record<string, unknown>;
        return this.extractString(msg, "id");
      }
    }
    return this.extractString(root, "wamid") || this.extractString(root, "messageId") || this.extractString(root, "message_id");
  }

  private buildTemplateParameters(input: Record<string, string>): MetaTemplateParameter[] {
    return Object.entries(input).map(([key, value]) => {
      const parameter: MetaTemplateParameter = {
        type: "text",
        text: value
      };
      if (!/^\d+$/.test(key)) {
        parameter.parameter_name = key;
      }
      return parameter;
    });
  }

  private normalizeTemplateInput(rawTemplates: unknown): TemplateRecord[] {
    const list = this.extractArray(rawTemplates);
    if (!list.length) {
      return [];
    }

    return list
      .map(coalesceTemplate)
      .filter((template): template is TemplateRecord => template !== null);
  }

  async getHealth(accountId: string): Promise<{ status: "healthy" | "unhealthy" | "degraded" | "unknown"; checkedAt: Date; reason?: string }> {
    this.ensureConfigured("check CAPSULE health");
    try {
      const payload = await this.requestAnyPath<HealthStatus>([
        "/health",
        "/platform/v1/health",
        "/meta/whatsapp/health"
      ]);
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
    const phoneNumberId = await this.resolvePhoneNumberId(input.accountId);
    const response = await this.requestAnyPath<{ messages?: unknown[]; messageId?: string; message_id?: string; status?: string }>([
      this.resolvePathTemplate(META_SEND_PATHS[0]!, { phoneNumberId }),
      this.resolvePathTemplate(META_SEND_PATHS[1]!, { phoneNumberId })
    ], {
      method: "POST",
      body: {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: input.recipient,
        type: "text",
        text: {
          preview_url: false,
          body: input.text
        },
        ...(input.trackId ? { biz_opaque_callback_data: input.trackId } : {}),
        ...(input.metadata ? { custom: input.metadata } : {})
      }
    });

    const providerMessageId = this.extractTemplateMessages(response) ??
      this.extractString(response, "message_id") ??
      this.extractString(response, "messageId") ??
      "unknown";
    return {
      providerMessageId: providerMessageId ?? "unknown",
      status: (response.status === "sent" || this.extractString(response, "status") === "sent" ? "sent" : "accepted") as SendResult["status"],
      raw: response
    };
  }

  async sendTemplate(input: SendTemplateInput): Promise<SendResult> {
    this.ensureConfigured("send a template");
    const phoneNumberId = await this.resolvePhoneNumberId(input.accountId);
    const response = await this.requestAnyPath<{ messages?: unknown[]; messageId?: string; message_id?: string; status?: string }>([
      this.resolvePathTemplate(META_SEND_PATHS[0]!, { phoneNumberId }),
      this.resolvePathTemplate(META_SEND_PATHS[1]!, { phoneNumberId })
    ], {
      method: "POST",
      body: {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: input.recipient,
        type: "template",
        template: {
          name: input.templateName,
          language: {
            code: normalizeTemplateLanguage(input.language)
          },
          components: [
            {
              type: "body",
              parameters: this.buildTemplateParameters(input.parameters ?? {})
            }
          ]
        },
        ...(input.trackId ? { biz_opaque_callback_data: input.trackId } : {})
      }
    });

    const providerMessageId = this.extractTemplateMessages(response) ??
      this.extractString(response, "message_id") ??
      this.extractString(response, "messageId") ??
      "unknown";
    return {
      providerMessageId: providerMessageId ?? "unknown",
      status: (response.status === "sent" || this.extractString(response, "status") === "sent" ? "sent" : "accepted") as SendResult["status"],
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
    const businessAccountId = await this.resolveBusinessAccountId(accountId);
    const payload = await this.requestAnyPath<unknown>([
      this.resolvePathTemplate(META_TEMPLATE_PATHS[0]!, {
        businessAccountId,
        accountId: businessAccountId
      }),
      this.resolvePathTemplate(META_TEMPLATE_PATHS[1]!, {
        businessAccountId,
        accountId: businessAccountId
      })
    ], {
      method: "GET"
    });

    if (!payload || typeof payload !== "object") {
      return this.normalizeTemplateInput(payload as unknown[]);
    }

    const list = this.extractArray(payload);
    return this.normalizeTemplateInput(list);
  }

  async submitTemplate(input: SubmitTemplateInput): Promise<TemplateSubmissionResult> {
    this.ensureConfigured("submit a template");
    const businessAccountId = await this.resolveBusinessAccountId(input.accountId);
    const payload = await this.requestAnyPath<{
      id?: string;
      name?: string;
      status?: string;
      language?: string;
      template_name?: string;
      templateName?: string;
    }>([
      this.resolvePathTemplate(META_TEMPLATE_PATHS[0]!, { businessAccountId }),
      this.resolvePathTemplate(META_TEMPLATE_PATHS[1]!, { businessAccountId })
    ], {
      method: "POST",
      body: {
        name: input.name,
        language: normalizeTemplateLanguage(input.language),
        category: input.category,
        components: [
          {
            type: "BODY",
            text: input.body
          }
        ],
        ...(input.example ? { example: input.example } : {})
      }
    });

    return {
      providerTemplateId: (payload.id ?? payload.name ?? payload.templateName ?? payload.template_name ?? "unknown").toString(),
      status: normalizeTemplateStatus((payload.status ?? "draft").toString()),
      raw: payload
    };
  }

  async getTemplateStatus(accountId: string, templateName: string): Promise<TemplateRecord | null> {
    this.ensureConfigured("check template status");
    try {
      const templates = await this.listTemplates(accountId);
      return templates.find((template) => template.name === templateName) ?? null;
    } catch {
      return null;
    }
  }
}
