import { BadRequestException, Injectable } from "@nestjs/common";
import {
  GroupProvider,
  GroupInstanceStatus,
  GroupRemoteRecord,
  SendGroupMessageInput,
  SendResult
} from "@cognita-campaign/domain";
import { AppConfigService } from "../config/app-config.service.js";

const SEND_PATHS = [
  "/send/text",
  "/messages/send",
  "/group/send/text",
  "/group/send/message"
];

const TRACK_SOURCE_KEYS = ["track_source", "trackSource", "source"];
const TRACK_ID_KEYS = ["track_id", "trackId", "track"];

const TRUE_PATTERNS = ["1", "true", "yes", "y", "on"];
const FALSE_PATTERNS = ["0", "false", "no", "off"];

export interface UazapiGroupInfo {
  jid: string;
  name: string;
  participants: UazapiGroupParticipant[];
  ownerCanSendMessage: boolean;
  ownerIsAdmin?: boolean;
  suspended?: boolean;
}

export interface UazapiGroupParticipant {
  jid: string;
  displayName?: string;
  raw: unknown;
}

@Injectable()
export class UazapiAdapterService implements GroupProvider {
  constructor(private readonly config: AppConfigService) {}

  private get baseUrl() {
    return this.config.env.UAZAPI_BASE_URL.replace(/\/+$/, "");
  }

  private get instanceToken() {
    return this.config.env.UAZAPI_GABRIEL_INSTANCE_TOKEN;
  }

  private async request<T>(path: string, options: {
    method?: "GET" | "POST";
    query?: Record<string, string>;
    body?: Record<string, unknown>;
  } = {}): Promise<T> {
    const queryParams = options.query
      ? new URLSearchParams(options.query)
      : undefined;
    const url = new URL(path.startsWith("/") ? path : `/${path}`, this.baseUrl);
    if (queryParams) {
      for (const [key, value] of queryParams) {
        url.searchParams.set(key, value);
      }
    }

    const requestInit: RequestInit = {
      method: options.method ?? "GET",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        token: this.instanceToken ?? ""
      }
    };

    if (options.body) {
      requestInit.body = JSON.stringify(options.body);
    }

    if (!this.instanceToken) {
      throw new BadRequestException("UAZAPI instance token missing");
    }

    const response = await fetch(url, requestInit);
    const rawBody = await response.text();
    let payload: unknown;
    try {
      payload = rawBody ? JSON.parse(rawBody) : null;
    } catch {
      payload = rawBody;
    }

    if (!response.ok) {
      const message =
        (payload && typeof payload === "object" && (payload as { message?: string }).message) ??
        `UAZAPI request failed ${response.status}`;
      throw new Error(String(message));
    }

    return payload as T;
  }

  private unwrapData(payload: unknown): unknown {
    if (payload == null) {
      return payload;
    }
    if (Array.isArray(payload)) {
      return payload;
    }
    if (typeof payload === "object") {
      if (Array.isArray((payload as { data?: unknown }).data)) {
        return (payload as { data: unknown }).data;
      }
      if (Array.isArray((payload as { result?: unknown }).result)) {
        return (payload as { result: unknown }).result;
      }
      if (Array.isArray((payload as { response?: unknown }).response)) {
        return (payload as { response: unknown }).response;
      }
      if (Array.isArray((payload as { groups?: unknown }).groups)) {
        return (payload as { groups: unknown }).groups;
      }
    }

    return payload;
  }

  private boolFromUnknown(value: unknown, fallback = false): boolean {
    if (typeof value === "boolean") return value;
    if (typeof value === "string") {
      const normalized = value.toLowerCase().trim();
      if (TRUE_PATTERNS.includes(normalized)) return true;
      if (FALSE_PATTERNS.includes(normalized)) return false;
    }
    if (typeof value === "number") {
      return value !== 0;
    }
    return fallback;
  }

  private toString(value: unknown): string {
    if (value == null) return "";
    if (typeof value === "string") return value;
    return String(value);
  }

  private extractStringField(container: Record<string, unknown>, keys: string[]): string {
    for (const key of keys) {
      const value = container[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
      if (value && typeof value === "object" && !Array.isArray(value)) {
        const nested = value as Record<string, unknown>;
        const nestedValue = this.extractStringField(nested, ["_serialized", "id", "jid"]);
        if (nestedValue) return nestedValue;
      }
    }
    return "";
  }

  async getInstanceStatus(_accountId?: string): Promise<GroupInstanceStatus> {
    const payload = this.unwrapData(await this.request<unknown>("/instance/status"));
    const statusBag = this.toString(
      (payload && typeof payload === "object" && (payload as Record<string, unknown>).status) ?? ""
    ).toLowerCase();
    const connected =
      this.boolFromUnknown(
        payload &&
          typeof payload === "object" &&
          ((payload as Record<string, unknown>).connected || (payload as Record<string, unknown>).connected === false)
          ? (payload as Record<string, unknown>).connected
          : undefined
      ) || statusBag === "connected";
    const loggedIn =
      this.boolFromUnknown(
        payload &&
          typeof payload === "object" &&
          ((payload as Record<string, unknown>).loggedIn || (payload as Record<string, unknown>).loggedIn === false)
          ? (payload as Record<string, unknown>).loggedIn
          : undefined,
        true
      ) && connected;

    return {
      connected,
      loggedIn,
      status:
        statusBag === "connected"
          ? "connected"
          : statusBag === "connecting"
            ? "connecting"
            : connected
              ? "connected"
              : "disconnected",
      reason: this.toString(
        payload &&
          typeof payload === "object" &&
          (payload as Record<string, unknown>).reason
      )
    };
  }

  async listGroups(_accountId?: string): Promise<GroupRemoteRecord[]> {
    const payload = this.unwrapData(await this.request<unknown>("/group/list"));
    if (!Array.isArray(payload)) {
      return [];
    }
    return payload
      .map((entry) => this.mapGroup(entry))
      .filter((group): group is GroupRemoteRecord => group !== null);
  }

  async sendGroupMessage(input: SendGroupMessageInput): Promise<SendResult> {
    const text = input.text?.trim();
    if (!text) {
      throw new BadRequestException("text is required");
    }
    const groupJid = input.groupJid.trim();
    if (!groupJid.endsWith("@g.us")) {
      throw new BadRequestException("groupJid must be a group jid");
    }

    const payloads: Record<string, unknown>[] = [
      {
        accountId: input.accountId,
        number: groupJid,
        to: groupJid,
        groupJid,
        text,
        body: text,
        track_source: input.accountId,
        trackId: input.trackId,
        track_id: input.trackId,
        delayMs: input.delayMs
      },
      {
        accountId: input.accountId,
        recipient: groupJid,
        jid: groupJid,
        message: text,
        track_source: input.accountId,
        trackId: input.trackId,
        track_id: input.trackId,
        delayMs: input.delayMs
      },
      {
        accountId: input.accountId,
        target: groupJid,
        chatId: groupJid,
        content: text,
        text,
        track_source: input.accountId,
        trackId: input.trackId,
        track_id: input.trackId,
        delayMs: input.delayMs
      }
    ];

    let lastError: Error = new Error("Unable to send via UAZAPI");
    for (const path of SEND_PATHS) {
      for (const payload of payloads) {
        try {
          const response = await this.request<unknown>(path, {
            method: "POST",
            body: payload
          });

          const normalized = this.unwrapData(response);
          const normalizedRecord =
            normalized && typeof normalized === "object"
              ? (normalized as Record<string, unknown>)
              : null;
          const status = this.toString(
            normalizedRecord && typeof normalizedRecord.status === "string"
              ? normalizedRecord.status
              : null
          ).toLowerCase() || "accepted";
          const messageId = this.toString(
            normalizedRecord && (
              normalizedRecord.messageId ??
              normalizedRecord.message_id ??
              normalizedRecord.id ??
              normalizedRecord.wamid
            )
          ) || "unknown";

          if (status.includes("error") || status.includes("fail")) {
            const reason = this.toString(normalizedRecord?.message ?? normalizedRecord?.error);
            throw new Error(reason || "UAZAPI send failed");
          }

          return {
            providerMessageId: messageId,
            status: status.includes("sent") || status.includes("delivered") ? "sent" : "accepted",
            raw: response
          };
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
        }
      }
    }

    throw lastError;
  }

  async sendGroupText(
    accountId: string,
    groupJid: string,
    text: string,
    trackId: string
  ): Promise<SendResult> {
    return this.sendGroupMessage({
      accountId,
      groupJid,
      text,
      trackId
    });
  }

  async getGroupInfo(groupJid: string): Promise<UazapiGroupInfo | null> {
    const tryGet = async (query: "get" | "post"): Promise<unknown> => {
      if (query === "get") {
        return this.request<unknown>("/group/info", {
          method: "GET",
          query: { groupjid: groupJid }
        });
      }
      return this.request<unknown>("/group/info", {
        method: "POST",
        body: { groupjid: groupJid }
      });
    };

    let payload: unknown = null;
    try {
      payload = this.unwrapData(await tryGet("get"));
    } catch {
      payload = this.unwrapData(await tryGet("post"));
    }

    const candidate = this.coerceObject(payload);
    if (!candidate) {
      return null;
    }

    const jid = this.extractStringField(candidate, ["jid", "groupjid", "groupJid"]);
    if (!jid) {
      return null;
    }

    const participantsCandidate = this.coerceArray(candidate.participants ?? candidate.participantsList ?? []);

    return {
      jid,
      name: this.extractStringField(candidate, ["name", "subject", "groupName"]),
      participants: participantsCandidate
        .map((entry) => this.mapParticipant(entry))
        .filter((participant): participant is UazapiGroupParticipant => participant !== null),
      ownerCanSendMessage: this.boolFromUnknown(
        candidate.ownerCanSendMessage ?? candidate.canSendMessage ?? candidate.canSendMessages
      ),
      ownerIsAdmin: this.boolFromUnknown(candidate.ownerIsAdmin),
      suspended: this.boolFromUnknown(candidate.suspended)
    };
  }

  private mapGroup(participant: unknown): GroupRemoteRecord | null {
    if (!participant || typeof participant !== "object") return null;
    const candidate = participant as Record<string, unknown>;
    const jid = this.extractStringField(candidate, ["jid", "groupjid", "groupJid", "id"]);
    if (!jid || !jid.endsWith("@g.us")) {
      return null;
    }

    return {
      jid,
      name: this.toString(candidate.name || candidate.groupName || "Sem nome"),
      ownerCanSendMessage: this.boolFromUnknown(
        candidate.ownerCanSendMessage ?? candidate.canSendMessage ?? candidate.canSendMessages
      ),
      ownerIsAdmin: this.boolFromUnknown(candidate.ownerIsAdmin),
      suspended: this.boolFromUnknown(candidate.suspended)
    };
  }

  private mapParticipant(participant: unknown): UazapiGroupParticipant | null {
    if (!participant || typeof participant !== "object") return null;
    const candidate = participant as Record<string, unknown>;

    const jid = this.extractStringField(candidate, ["jid", "id", "rawId", "phone", "phone_number"]);
    if (!jid) return null;

    const displayName = this.extractStringField(
      candidate,
      ["notify", "pushName", "name", "title", "displayName"]
    );

    return {
      jid,
      displayName: displayName || undefined,
      raw: candidate
    };
  }

  private coerceObject(payload: unknown): Record<string, unknown> | null {
    if (!payload || typeof payload !== "object") {
      return null;
    }
    if (Array.isArray(payload)) {
      return payload[0] as Record<string, unknown>;
    }
    return payload as Record<string, unknown>;
  }

  private coerceArray(value: unknown): unknown[] {
    if (Array.isArray(value)) {
      return value;
    }
    return [];
  }
}
