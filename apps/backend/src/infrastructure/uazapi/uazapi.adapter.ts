import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable
} from "@nestjs/common";
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

const SENDER_SIMPLE_PATH = "/sender/simple";

const INSTANCE_STATUS_PATHS = ["/status", "/instance/status"];
const GROUP_LIST_PATHS = ["/group/list", "/groups/list", "/groups"];
const GROUP_INFO_PATHS = [
  "/group/info",
  "/groups/info",
  "/group/members"
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
    requiresToken?: boolean;
  } = {}): Promise<T> {
    const requiresToken = options.requiresToken ?? true;
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
        Accept: "application/json"
      }
    };
    if (requiresToken) {
      if (!this.instanceToken) {
        throw new BadRequestException("UAZAPI instance token missing");
      }
      requestInit.headers = {
        ...requestInit.headers,
        token: this.instanceToken
      };
    }

    if (options.body) {
      requestInit.body = JSON.stringify(options.body);
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
      const status = response.status;
      const message =
        (payload && typeof payload === "object" && (payload as { message?: string }).message) ??
        `UAZAPI request failed ${response.status}`;
      if (status === HttpStatus.UNAUTHORIZED || status === HttpStatus.FORBIDDEN) {
        throw new HttpException(String(message), status);
      }
      if (status >= HttpStatus.BAD_REQUEST && status < HttpStatus.INTERNAL_SERVER_ERROR) {
        throw new BadRequestException(String(message));
      }
      throw new HttpException(String(message), HttpStatus.BAD_GATEWAY);
    }

    return payload as T;
  }

  private shouldRetryRequestForPath(status: number) {
    return status === HttpStatus.NOT_FOUND || status === HttpStatus.METHOD_NOT_ALLOWED;
  }

  private async requestAnyPath<T>(
    paths: string[],
    options: {
      method?: "GET" | "POST";
      query?: Record<string, string>;
      body?: Record<string, unknown>;
      requiresToken?: boolean;
    } = {}
  ): Promise<T> {
    let lastError: Error | null = null;
    for (const path of paths) {
      try {
        return this.unwrapData(await this.request<unknown>(path, options)) as T;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (error instanceof HttpException && this.shouldRetryRequestForPath(error.getStatus())) {
          continue;
        }
        break;
      }
    }

    throw lastError ?? new Error("UAZAPI request failed");
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
    const payload = await this.requestAnyPath<unknown>(INSTANCE_STATUS_PATHS, {
      method: "GET",
      requiresToken: false
    });
    const normalizedStatus = this.coerceObject(payload);
    const candidateStatus = this.coerceObject(normalizedStatus?.status) ?? normalizedStatus;
    const checkedInstance = this.coerceObject(candidateStatus?.checked_instance);

    const connectedValue =
      checkedInstance
        ? this.boolFromUnknown(
          checkedInstance.connected ??
          checkedInstance.is_connected ??
          checkedInstance.connection_status
        ) ||
          this.toString(checkedInstance.connection_status).toLowerCase() === "connected"
        : this.boolFromUnknown(candidateStatus?.connected, false);

    const loggedInValue =
      this.boolFromUnknown(
        checkedInstance?.loggedIn ??
        checkedInstance?.is_logged_in ??
        (candidateStatus && candidateStatus.loggedIn)
      , true);

    const statusBag = this.toString(
      checkedInstance?.connection_status ??
      candidateStatus?.status ??
      checkedInstance?.status ??
      candidateStatus?.connectionStatus
    ).toLowerCase();
    const connected = connectedValue || checkedInstance?.is_healthy === true || statusBag === "connected";
    const loggedIn = loggedInValue && connected;

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
        checkedInstance?.message ??
        checkedInstance?.reason ??
        candidateStatus?.reason ??
        candidateStatus?.message ??
        normalizedStatus?.message
      )
    };
  }

  async listGroups(_accountId?: string): Promise<GroupRemoteRecord[]> {
    const payload = await this.requestAnyPath<unknown>(GROUP_LIST_PATHS, {
      method: "GET",
      requiresToken: true
    });
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

    const delaySeconds = Math.max(1, Math.floor((input.delayMs ?? 2000) / 1000));
    const delayJitter = delaySeconds + 1;
    let lastError: Error = new Error("Unable to send via UAZAPI");

    const simplePayload = {
      numbers: [groupJid],
      type: "text",
      delayMin: delaySeconds,
      delayMax: delayJitter,
      scheduled_for: Date.now(),
      text,
      folder: `uazapi-${input.accountId}-${this.normalizeForFolder(groupJid)}`
    };

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

    try {
      const response = await this.request<unknown>(SENDER_SIMPLE_PATH, {
        method: "POST",
        body: simplePayload
      });
      const normalized = this.unwrapData(response);
      const record = normalized && typeof normalized === "object" ? normalized as Record<string, unknown> : {};
      const status = this.toString(record.status).toLowerCase() || "accepted";
      return {
        providerMessageId: this.toString(record.folder_id || record.folder || record.id || record.batchId) || "sender-batch",
        status: status.includes("sent") || status.includes("delivered") ? "sent" : "accepted",
        raw: response
      };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
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

  private normalizeForFolder(value: string): string {
    return value.replace(/[@.]/g, "-");
  }

  async getGroupInfo(groupJid: string): Promise<UazapiGroupInfo | null> {
    const queryVariants: Array<{ query?: Record<string, string>; body?: Record<string, unknown>; method: "GET" | "POST" }> = [
      { method: "GET", query: { groupjid: groupJid } },
      { method: "GET", query: { groupId: groupJid } },
      { method: "GET", query: { jid: groupJid } },
      { method: "POST", body: { groupjid: groupJid } },
      { method: "POST", body: { groupId: groupJid } },
      { method: "POST", body: { jid: groupJid } }
    ];

    let payload: unknown = null;
    let lastError: Error | null = null;

    for (const path of GROUP_INFO_PATHS) {
      for (const variant of queryVariants) {
        try {
          payload = await this.requestAnyPath<unknown>([path], {
            method: variant.method,
            query: variant.query,
            body: variant.body
          });
          break;
        } catch (error) {
          lastError = error instanceof Error ? error : new Error(String(error));
        }
      }

      if (payload) {
        break;
      }
    }

    const candidate = this.parseGroupInfoCandidate(payload);
    if (candidate?.jid) {
      return candidate;
    }

    const fallbackPayload = await this.requestAnyPath<unknown>(GROUP_LIST_PATHS, {
      method: "GET"
    });
    const list = this.coerceArray(fallbackPayload).map((entry) => this.coerceObject(entry)).filter((entry): entry is Record<string, unknown> => !!entry);
    for (const item of list) {
      const parsed = this.parseGroupInfoCandidate(item);
      if (parsed && parsed.jid === groupJid) {
        return parsed;
      }
    }

    throw lastError ?? new Error("Could not get group info from UAZAPI");
  }

  private parseGroupInfoCandidate(payload: unknown): UazapiGroupInfo | null {
    const candidate = this.coerceObject(payload);
    if (!candidate) {
      return null;
    }

    const jid = this.extractStringField(candidate, ["jid", "groupjid", "groupJid", "JID", "GroupId", "group_id"]);
    if (!jid || !jid.endsWith("@g.us")) {
      return null;
    }

    const participantsCandidate = this.coerceArray(
      candidate.participants ?? candidate.Participants ?? candidate.participantsList ?? []
    );

    return {
      jid,
      name: this.extractStringField(candidate, ["name", "subject", "groupName", "GroupName", "Nome", "Title"]),
      participants: participantsCandidate
        .map((entry) => this.mapParticipant(entry))
        .filter((participant): participant is UazapiGroupParticipant => participant !== null),
      ownerCanSendMessage: this.boolFromUnknown(
        candidate.ownerCanSendMessage ?? candidate.canSendMessage ?? candidate.canSendMessages ?? candidate.OwnerCanSendMessage
      ),
      ownerIsAdmin: this.boolFromUnknown(
        candidate.ownerIsAdmin ?? candidate.OwnerIsAdmin ?? candidate.isOwnerAdmin
      ),
      suspended: this.boolFromUnknown(candidate.suspended)
    };
  }

  private mapGroup(participant: unknown): GroupRemoteRecord | null {
    if (!participant || typeof participant !== "object") return null;
    const candidate = participant as Record<string, unknown>;
    const jid = this.extractStringField(
      candidate,
      ["jid", "groupjid", "groupJid", "id", "JID", "GroupId", "group_id", "group_id_jid", "groupId"]
    );
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
    const phoneNumber = this.extractStringField(candidate, ["PhoneNumber", "phone", "number"]);
    const normalizedParticipantJid = jid || (phoneNumber ? `${phoneNumber}@s.whatsapp.net` : "");
    if (!normalizedParticipantJid) return null;

    const displayName = this.extractStringField(
      candidate,
      ["notify", "pushName", "name", "title", "displayName"]
    );

    return {
      jid: normalizedParticipantJid || jid,
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
