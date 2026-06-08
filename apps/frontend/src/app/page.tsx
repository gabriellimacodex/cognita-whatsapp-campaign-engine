"use client";

import { useEffect, useState } from "react";
import {
  Activity,
  CalendarClock,
  CheckCircle2,
  CircleAlert,
  Pause,
  Play,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  Users,
  FileAudio
} from "lucide-react";

interface GroupStatus {
  allowlistJid?: string;
  status?: {
    connected: boolean;
    loggedIn: boolean;
    status: string;
    reason?: string;
  };
  groups?: {
    total: number;
  };
}

interface ContactResult {
  contactId: string;
  phoneE164: string;
  displayName: string | null;
  sourceGroupName: string | null;
  discoveredAt: string;
}

interface ExtractionResult {
  groupJid: string;
  groupName: string;
  upsertedConsents: number;
  extractedMembers: number;
}

interface ExtractionPreviewContact {
  phoneE164: string;
  contactId: string | null;
  displayName: string | null;
  status: "would_create_consent" | "would_keep";
  source: string;
  existingConsentStatus: string | null;
}

interface ExtractionPreviewResult {
  preview: true;
  groupJid: string;
  groupName: string;
  groupTargetId: string;
  extractedMembers: number;
  upsertedConsents: number;
  extractedContacts: ExtractionPreviewContact[];
}

interface WorkflowValidationIssue {
  code: string;
  message: string;
  path: string;
}

interface WorkflowValidationResponse {
  valid: boolean;
  issues: WorkflowValidationIssue[];
}

interface CampaignSummary {
  id: string;
  name: string;
  status: string;
  timezone: string;
  createdAt: string;
  updatedAt: string;
}

interface CampaignListResponse {
  limit?: number;
  items: CampaignSummary[];
}

interface CampaignScheduleRequest {
  campaignId: string;
  accountId: string;
  startAt?: string;
  groupJid?: string;
}

type CampaignApprovalAction = "approve_workflow" | "approve_template" | "start_campaign";

interface CampaignApprovalRecord {
  id: string;
  status: string;
  action: CampaignApprovalAction | string;
  metadata: unknown;
  notes: string | null;
  reviewedBy: string | null;
  requestedBy: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface CampaignScheduleResponse {
  campaignId: string;
  campaignStatus: string;
  scheduleStartedAt: string;
  jobs: ScheduledJobItem[];
}

interface ScheduledJobItem {
  id: string;
  campaignId: string;
  workflowStepId: string;
  status: string;
  runAt: string;
  idempotencyKey: string;
  attemptCount: number;
  maxAttempts: number;
  createdAt: string;
}

interface CampaignJobsResponse {
  campaignId: string;
  campaignName: string;
  jobs: ScheduledJobItem[];
}

type AudioInstructionStatus =
  | "uploaded"
  | "transcribing"
  | "transcribed"
  | "needs_review"
  | "approved_for_workflow"
  | "rejected";

interface AudioInstructionItem {
  id: string;
  campaignId: string | null;
  originalFileUrl: string;
  durationMs: number | null;
  detectedLanguage: string | null;
  rawTranscript: string | null;
  reviewedTranscript: string | null;
  confidence: number | null;
  contentClass: string | null;
  status: AudioInstructionStatus;
  createdAt: string;
  updatedAt: string;
}

interface AudioInstructionsResponse {
  total: number;
  items: AudioInstructionItem[];
}

interface CampaignCreateResponse {
  campaignId: string;
  campaignVersionId: string;
  status: string;
  workflowValidation: WorkflowValidationResponse;
}

interface SendOptInResponse {
  sendAttemptId: string;
  consentId: string;
  contactId: string;
  phoneE164: string;
  providerMessageId: string;
  requestTemplateId: string;
  requestedAt: string;
  status: string;
}

interface OfficialSendAttempt {
  id: string;
  status: string;
  contactId: string;
  templateKey: string | null;
  providerMessageId: string | null;
  consentStatus: string | null;
  scheduledAt: string;
  createdAt: string;
  updatedAt: string;
  phoneE164: string | null;
  displayName: string | null;
}

const API_BASE = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {})
    }
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(error || `Request failed ${response.status}`);
  }
  return response.json() as Promise<T>;
}

function toInputDateTime(value?: string | null): string {
  if (!value) return "";
  const normalized = new Date(value);
  if (Number.isNaN(normalized.getTime())) return "";
  const yyyy = String(normalized.getFullYear());
  const mm = String(normalized.getMonth() + 1).padStart(2, "0");
  const dd = String(normalized.getDate()).padStart(2, "0");
  const hh = String(normalized.getHours()).padStart(2, "0");
  const mi = String(normalized.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

export default function Home() {
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [groupInfo, setGroupInfo] = useState<{
    group: { name?: string; remoteJid: string; extractionCount: number } | null;
    configuredAllowlist: string;
  } | null>(null);
  const [status, setStatus] = useState<GroupStatus["status"] | null>(null);
  const [contacts, setContacts] = useState<ContactResult[]>([]);
  const [message, setMessage] = useState<string>("");
  const [extractionResult, setExtractionResult] = useState<ExtractionResult | null>(null);
  const [extractionPreviewResult, setExtractionPreviewResult] = useState<ExtractionPreviewResult | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [workflowDraft, setWorkflowDraft] = useState<string>(
    '{\n  "version": "1.0",\n  "timezone": "America/Sao_Paulo",\n  "campaignId": "camp_123",\n  "entry": "start",\n  "nodes": [\n    { "id": "start", "type": "start" },\n    { "id": "tpl_1", "type": "send_text", "channel": "uazapi_group", "messageKey": "boas_vindas" },\n    { "id": "end", "type": "stop" }\n  ],\n  "edges": [\n    { "from": "start", "to": "tpl_1" },\n    { "from": "tpl_1", "to": "end" }\n  ]\n}'
  );
  const [validationResult, setValidationResult] = useState<WorkflowValidationResponse | null>(null);
  const [validationLoading, setValidationLoading] = useState(false);
  const [campaignName, setCampaignName] = useState("Campanha Inicial");
  const [campaignTimezone, setCampaignTimezone] = useState("America/Sao_Paulo");
  const [campaignCreating, setCampaignCreating] = useState(false);
  const [campaignResult, setCampaignResult] = useState<CampaignCreateResponse | null>(null);
  const [campaignMessage, setCampaignMessage] = useState("");
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([]);
  const [campaignApprovalsByCampaign, setCampaignApprovalsByCampaign] = useState<Record<string, CampaignApprovalRecord[]>>({});
  const [selectedCampaignForApprovals, setSelectedCampaignForApprovals] = useState<string>("");
  const [campaignApprovalLoading, setCampaignApprovalLoading] = useState<Record<string, boolean>>({});
  const [selectedCampaignId, setSelectedCampaignId] = useState("");
  const [campaignJobs, setCampaignJobs] = useState<ScheduledJobItem[]>([]);
  const [campaignJobsCampaignName, setCampaignJobsCampaignName] = useState("");
  const [jobsLoading, setJobsLoading] = useState(false);
  const [campaignActionLoading, setCampaignActionLoading] = useState<Record<string, boolean>>({});
  const [campaignActionMessage, setCampaignActionMessage] = useState("");
  const [schedulerAccountId, setSchedulerAccountId] = useState("");
  const [schedulerStartAt, setSchedulerStartAt] = useState("");
  const [schedulerGroupJid, setSchedulerGroupJid] = useState("");
  const [jobRescheduleById, setJobRescheduleById] = useState<Record<string, string>>({});
  const [capsuleAccountId, setCapsuleAccountId] = useState("");
  const [optInTemplateName, setOptInTemplateName] = useState("opt_in_template");
  const [optInLanguage, setOptInLanguage] = useState("pt_BR");
  const [sendingContactId, setSendingContactId] = useState<string | null>(null);
  const [optInPayloadResult, setOptInPayloadResult] = useState("");
  const [officialAttempts, setOfficialAttempts] = useState<OfficialSendAttempt[]>([]);

  const [audioListCampaignId, setAudioListCampaignId] = useState("");
  const [audioListStatus, setAudioListStatus] = useState("");
  const [audioListLimit, setAudioListLimit] = useState("25");
  const [audioInstructions, setAudioInstructions] = useState<AudioInstructionItem[]>([]);
  const [audioInstructionsLoading, setAudioInstructionsLoading] = useState(false);
  const [audioInstructionMessage, setAudioInstructionMessage] = useState("");
  const [audioCreatorCampaignId, setAudioCreatorCampaignId] = useState("");
  const [audioOriginalFileUrl, setAudioOriginalFileUrl] = useState("");
  const [audioDurationMs, setAudioDurationMs] = useState("");
  const [audioDetectedLanguage, setAudioDetectedLanguage] = useState("");
  const [audioRawTranscript, setAudioRawTranscript] = useState("");
  const [audioReviewedTranscript, setAudioReviewedTranscript] = useState("");
  const [audioConfidence, setAudioConfidence] = useState("");
  const [audioContentClass, setAudioContentClass] = useState("");
  const [audioStatus, setAudioStatus] = useState<AudioInstructionStatus>("uploaded");
  const [audioUpdatingId, setAudioUpdatingId] = useState("");
  const [audioUpdateStatus, setAudioUpdateStatus] = useState<AudioInstructionStatus>("uploaded");
  const [audioUpdateConfidence, setAudioUpdateConfidence] = useState("");
  const [audioUpdateReviewedTranscript, setAudioUpdateReviewedTranscript] = useState("");
  const [audioUpdateContentClass, setAudioUpdateContentClass] = useState("");

  const refresh = async () => {
    setLoading(true);
    setCampaignActionMessage("");
    setExtractionPreviewResult(null);
    try {
      const [allowlisted, uazapiStatus, discovered, recentAttempts, campaignList, audioInstructionResult] = await Promise.all([
        fetchJson<{ group: { name?: string; remoteJid: string; extractionCount: number } | null; configuredAllowlist: string }>(
          "/integration/uazapi/groups/allowlisted"
        ),
        fetchJson<{ connected: boolean; loggedIn: boolean; status: string; reason?: string }>(
          "/integration/uazapi/status"
        ),
        fetchJson<{ items: ContactResult[] }>("/integration/uazapi/contacts/discovered?limit=25"),
        fetchJson<OfficialSendAttempt[]>("/integration/capsule/send-attempts?limit=20"),
        fetchJson<CampaignSummary[] | CampaignListResponse>("/campaigns?limit=200"),
        fetchJson<AudioInstructionsResponse>("/audio-instructions?limit=25")
      ]);
      setGroupInfo(allowlisted);
      setStatus(uazapiStatus);
      setContacts(discovered.items);
      setOfficialAttempts(recentAttempts);
      const resolvedCampaigns = Array.isArray(campaignList)
        ? campaignList
        : campaignList.items ?? [];
      setCampaigns(resolvedCampaigns);
      setAudioInstructions(audioInstructionResult.items);
      setMessage("");
    } catch (error) {
      setMessage((error as Error).message || "Falha ao carregar status da integração");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const runExtraction = async () => {
    if (!extractionPreviewResult) {
      setMessage("Faça a prévia da extração antes de executar a gravação real.");
      return;
    }

    setSyncing(true);
    setMessage("");
    try {
      const result = await fetchJson<ExtractionResult>("/integration/uazapi/groups/extract", {
        method: "POST",
        body: JSON.stringify({})
      });
      setExtractionResult(result);
      setExtractionPreviewResult(null);
      await refresh();
    } catch (error) {
      setMessage((error as Error).message || "Falha ao extrair contatos");
    } finally {
      setSyncing(false);
    }
  };

  const runExtractionPreview = async () => {
    setPreviewing(true);
    setMessage("");
    try {
      const result = await fetchJson<ExtractionPreviewResult>("/integration/uazapi/groups/extract/preview", {
        method: "POST",
        body: JSON.stringify({})
      });
      setExtractionPreviewResult(result);
    } catch (error) {
      setMessage((error as Error).message || "Falha ao pré-visualizar extração");
    } finally {
      setPreviewing(false);
    }
  };

  const sendOptIn = async (contact: ContactResult) => {
    if (!capsuleAccountId || !optInTemplateName) {
      setOptInPayloadResult("Informe accountId e template.");
      return;
    }

    setSendingContactId(contact.contactId);
    setOptInPayloadResult("");
    try {
      const result = await fetchJson<SendOptInResponse>("/integration/capsule/send/opt-in", {
        method: "POST",
        body: JSON.stringify({
          contactId: contact.contactId,
          accountId: capsuleAccountId,
          templateName: optInTemplateName,
          language: optInLanguage
        })
      });
      setOptInPayloadResult(
        `Opt-in enviado para ${result.phoneE164} | tentativa ${result.sendAttemptId} | status ${result.status}`
      );
      await refresh();
    } catch (error) {
      setOptInPayloadResult((error as Error).message || "Falha ao enviar opt-in");
    } finally {
      setSendingContactId(null);
    }
  };

  const validateWorkflow = async () => {
    setValidationLoading(true);
    setCampaignResult(null);
    setCampaignMessage("");
    try {
      const workflow = JSON.parse(workflowDraft);
      const result = await fetchJson<WorkflowValidationResponse>("/workflow/validate", {
        method: "POST",
        body: JSON.stringify(workflow)
      });
      setValidationResult(result);
    } catch (error) {
      setValidationResult({
        valid: false,
        issues: [
          {
            code: "INVALID_NODE",
            message: (error as Error).message || "Falha ao validar fluxo",
            path: "workflow"
          }
        ]
      });
    } finally {
      setValidationLoading(false);
    }
  };

  const createCampaign = async () => {
    setCampaignCreating(true);
    setCampaignResult(null);
    setCampaignMessage("");
    try {
      const workflow = JSON.parse(workflowDraft);
      const result = await fetchJson<CampaignCreateResponse>("/campaigns", {
        method: "POST",
        body: JSON.stringify({
          name: campaignName || "Campanha sem nome",
          timezone: campaignTimezone || "America/Sao_Paulo",
          workflow
        })
      });
      setCampaignResult(result);
      if (!result.workflowValidation.valid) {
        setValidationResult(result.workflowValidation);
      }
    } catch (error) {
      setCampaignMessage((error as Error).message || "Falha ao criar campanha");
    } finally {
      setCampaignCreating(false);
    }
  };

  const setActionLoading = (key: string, value: boolean) => {
    setCampaignActionLoading((current) => ({
      ...current,
      [key]: value
    }));
  };

  const loadCampaignJobs = async (campaignId: string) => {
    if (!campaignId) {
      setCampaignJobs([]);
      setCampaignJobsCampaignName("");
      return;
    }
    setJobsLoading(true);
    setCampaignActionMessage("");
    try {
      const payload = await fetchJson<CampaignJobsResponse>(`/campaigns/${campaignId}/schedule`);
      setSelectedCampaignId(campaignId);
      setCampaignJobs(payload.jobs);
      setCampaignJobsCampaignName(payload.campaignName);
      setJobRescheduleById({});
      if (payload.jobs.length === 0) {
        setCampaignActionMessage("Nenhum job encontrado. Agende a campanha primeiro.");
      }
    } catch (error) {
      setCampaignActionMessage((error as Error).message || "Falha ao carregar jobs da campanha");
    } finally {
      setJobsLoading(false);
    }
  };

  const scheduleCampaign = async (campaignId: string) => {
    setCampaignActionMessage("");
    if (!schedulerAccountId.trim()) {
      setCampaignActionMessage("Informe accountId da instância UAZAPI para agendar.");
      return;
    }

    const payload: CampaignScheduleRequest = {
      campaignId,
      accountId: schedulerAccountId.trim()
    };
    if (schedulerStartAt.trim()) {
      payload.startAt = schedulerStartAt.trim();
    }
    if (schedulerGroupJid.trim()) {
      payload.groupJid = schedulerGroupJid.trim();
    }

    const loadingKey = `schedule:${campaignId}`;
    setActionLoading(loadingKey, true);
    try {
      const result = await fetchJson<CampaignScheduleResponse>("/campaigns/schedule", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      await loadCampaignJobs(result.campaignId);
      setCampaignActionMessage(`Campanha ${campaignId} agendada em ${result.scheduleStartedAt}`);
      await refresh();
    } catch (error) {
      setCampaignActionMessage((error as Error).message || "Falha ao agendar campanha");
    } finally {
      setActionLoading(loadingKey, false);
    }
  };

  const pauseCampaign = async (campaignId: string) => {
    const loadingKey = `pause:${campaignId}`;
    setActionLoading(loadingKey, true);
    setCampaignActionMessage("");
    try {
      await fetchJson(`/campaigns/${campaignId}/pause`, { method: "POST" });
      await loadCampaignJobs(campaignId);
      await refresh();
    } catch (error) {
      setCampaignActionMessage((error as Error).message || "Falha ao pausar campanha");
    } finally {
      setActionLoading(loadingKey, false);
    }
  };

  const resumeCampaign = async (campaignId: string) => {
    const loadingKey = `resume:${campaignId}`;
    setActionLoading(loadingKey, true);
    setCampaignActionMessage("");
    try {
      await fetchJson(`/campaigns/${campaignId}/resume`, { method: "POST" });
      await loadCampaignJobs(campaignId);
      await refresh();
    } catch (error) {
      setCampaignActionMessage((error as Error).message || "Falha ao retomar campanha");
    } finally {
      setActionLoading(loadingKey, false);
    }
  };

  const cancelCampaign = async (campaignId: string) => {
    const loadingKey = `cancel:${campaignId}`;
    setActionLoading(loadingKey, true);
    setCampaignActionMessage("");
    try {
      await fetchJson(`/campaigns/${campaignId}/cancel`, { method: "POST" });
      await loadCampaignJobs(campaignId);
      await refresh();
    } catch (error) {
      setCampaignActionMessage((error as Error).message || "Falha ao cancelar campanha");
    } finally {
      setActionLoading(loadingKey, false);
    }
  };

  const cancelJob = async (jobId: string) => {
    const loadingKey = `cancelJob:${jobId}`;
    setActionLoading(loadingKey, true);
    setCampaignActionMessage("");
    try {
      const campaignId = selectedCampaignId;
      if (!campaignId) {
        throw new Error("Selecione a campanha antes de cancelar job.");
      }
      await fetchJson(`/campaigns/jobs/${jobId}/cancel`, { method: "POST" });
      await loadCampaignJobs(campaignId);
      await refresh();
    } catch (error) {
      setCampaignActionMessage((error as Error).message || "Falha ao cancelar job");
    } finally {
      setActionLoading(loadingKey, false);
    }
  };

  const updateJobReschedule = (jobId: string, runAt: string) => {
    setJobRescheduleById((current) => ({
      ...current,
      [jobId]: runAt
    }));
  };

  const rescheduleJob = async (jobId: string) => {
    const desired = jobRescheduleById[jobId];
    if (!desired) {
      setCampaignActionMessage("Informe nova data/hora para reagendar.");
      return;
    }
    const loadingKey = `rescheduleJob:${jobId}`;
    setActionLoading(loadingKey, true);
    setCampaignActionMessage("");
    try {
      await fetchJson(`/campaigns/jobs/${jobId}/reschedule`, {
        method: "POST",
        body: JSON.stringify({ runAt: new Date(desired).toISOString() })
      });
      if (selectedCampaignId) {
        await loadCampaignJobs(selectedCampaignId);
      }
      await refresh();
    } catch (error) {
      setCampaignActionMessage((error as Error).message || "Falha ao reagendar job");
    } finally {
      setActionLoading(loadingKey, false);
    }
  };

  const isCampaignActionLoading = (key: string) => Boolean(campaignActionLoading[key]);
  const isCampaignApprovalLoading = (key: string) => Boolean(campaignApprovalLoading[key]);

  const withCampaignApprovalLoading = async (campaignId: string, action: string, execute: () => Promise<void>) => {
    const key = `${action}:${campaignId}`;
    setCampaignApprovalLoading((current) => ({ ...current, [key]: true }));
    try {
      await execute();
    } finally {
      setCampaignApprovalLoading((current) => ({ ...current, [key]: false }));
    }
  };

  const loadCampaignApprovals = async (campaignId: string) => {
    setCampaignApprovalsByCampaign((current) => ({ ...current, [campaignId]: [] }));
    try {
      const approvals = await fetchJson<CampaignApprovalRecord[]>(`/campaigns/${campaignId}/approvals`);
      setCampaignApprovalsByCampaign((current) => ({ ...current, [campaignId]: approvals }));
      setSelectedCampaignForApprovals(campaignId);
    } catch (error) {
      setCampaignActionMessage((error as Error).message || "Falha ao carregar aprovações da campanha");
    }
  };

  const approveCampaignAction = async (campaignId: string, action: CampaignApprovalAction) => {
    await withCampaignApprovalLoading(campaignId, action, async () => {
      await fetchJson(`/campaigns/${campaignId}/approve`, {
        method: "POST",
        body: JSON.stringify({
          action,
          reviewer: "operator"
        })
      });
      await loadCampaignApprovals(campaignId);
      await refresh();
      setCampaignActionMessage(`Ação ${action} registrada para a campanha ${campaignId}`);
    });
  };

  const loadAudioInstructions = async () => {
    setAudioInstructionsLoading(true);
    setAudioInstructionMessage("");
    try {
      const params = new URLSearchParams();
      if (audioListCampaignId.trim()) {
        params.set("campaignId", audioListCampaignId.trim());
      }
      if (audioListStatus.trim()) {
        params.set("status", audioListStatus.trim());
      }
      if (audioListLimit.trim()) {
        params.set("limit", audioListLimit.trim());
      }

      const query = params.toString();
      const result = await fetchJson<AudioInstructionsResponse>(`/audio-instructions${query ? `?${query}` : ""}`);
      setAudioInstructions(result.items);
      setAudioInstructionMessage(`Instruções carregadas: ${result.total}`);
    } catch (error) {
      setAudioInstructionMessage((error as Error).message || "Falha ao carregar instruções de áudio");
    } finally {
      setAudioInstructionsLoading(false);
    }
  };

  const createAudioInstruction = async () => {
    if (!audioOriginalFileUrl.trim()) {
      setAudioInstructionMessage("Informe o link do arquivo de áudio");
      return;
    }

    setAudioInstructionMessage("");
    setAudioInstructionsLoading(true);
    try {
      const parsedDuration = Number(audioDurationMs);
      const parsedConfidence = Number(audioConfidence);
      await fetchJson<AudioInstructionItem>("/audio-instructions", {
        method: "POST",
        body: JSON.stringify({
          campaignId: audioCreatorCampaignId.trim() || undefined,
          originalFileUrl: audioOriginalFileUrl.trim(),
          durationMs: Number.isFinite(parsedDuration) ? parsedDuration : undefined,
          detectedLanguage: audioDetectedLanguage.trim() || undefined,
          rawTranscript: audioRawTranscript.trim() || undefined,
          reviewedTranscript: audioReviewedTranscript.trim() || undefined,
          confidence: Number.isFinite(parsedConfidence) ? parsedConfidence : undefined,
          contentClass: audioContentClass.trim() || undefined,
          status: audioStatus
        })
      });

      setAudioOriginalFileUrl("");
      setAudioDurationMs("");
      setAudioDetectedLanguage("");
      setAudioRawTranscript("");
      setAudioReviewedTranscript("");
      setAudioConfidence("");
      setAudioContentClass("");
      setAudioStatus("uploaded");
      setAudioInstructionMessage("Instrução de áudio registrada.");
      await loadAudioInstructions();
    } catch (error) {
      setAudioInstructionMessage((error as Error).message || "Falha ao registrar instrução de áudio");
    } finally {
      setAudioInstructionsLoading(false);
    }
  };

  const prepareAudioUpdate = (instruction: AudioInstructionItem) => {
    setAudioUpdatingId(instruction.id);
    setAudioUpdateStatus(instruction.status);
    setAudioUpdateConfidence(instruction.confidence?.toString() ?? "");
    setAudioUpdateReviewedTranscript(instruction.reviewedTranscript ?? "");
    setAudioUpdateContentClass(instruction.contentClass ?? "");
    setAudioInstructionMessage("");
  };

  const applyAudioUpdate = async (instructionId: string) => {
    const parsedConfidence = Number(audioUpdateConfidence);
    setAudioInstructionMessage("");
    setAudioInstructionsLoading(true);
    try {
      await fetchJson(`/audio-instructions/${instructionId}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: audioUpdateStatus,
          reviewedTranscript: audioUpdateReviewedTranscript.trim() || undefined,
          contentClass: audioUpdateContentClass.trim() || undefined,
          confidence: Number.isFinite(parsedConfidence) ? parsedConfidence : undefined
        })
      });
      setAudioUpdatingId("");
      setAudioInstructionMessage("Instrução de áudio atualizada.");
      await loadAudioInstructions();
    } catch (error) {
      setAudioInstructionMessage((error as Error).message || "Falha ao atualizar instrução de áudio");
    } finally {
      setAudioInstructionsLoading(false);
    }
  };

  return (
    <main className="min-h-screen px-6 py-6 lg:px-10">
      <section className="mx-auto flex max-w-7xl flex-col gap-6">
        <header className="flex flex-col gap-4 border-b border-line pb-6 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-sm font-medium text-slate-500">Cognita Campaign Engine</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-normal text-ink">Operations Console</h1>
          </div>
          <button
            onClick={() => void refresh()}
            className="flex items-center gap-2 rounded-full border border-line bg-white px-4 py-2 text-sm text-slate-600 shadow-sm"
          >
            <RefreshCw className="h-4 w-4" aria-hidden="true" />
            Recarregar
          </button>
        </header>

        <article className="grid gap-4 rounded-lg border border-line bg-white p-5 shadow-panel">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-ink">Saúde da instância UAZAPI</h2>
            <Activity className="h-5 w-5 text-accent" aria-hidden="true" />
          </div>

          {loading ? (
            <p className="text-sm text-slate-500">Carregando...</p>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-slate-700">
                Conectada: <strong>{status?.connected ? "Sim" : "Não"}</strong>
              </p>
              <p className="text-sm text-slate-700">
                Login ativo: <strong>{status?.loggedIn ? "Sim" : "Não"}</strong>
              </p>
              <p className="text-sm text-slate-700">
                Estado: <strong>{status?.status ?? "desconhecido"}</strong>
              </p>
              {status?.reason ? <p className="text-xs text-slate-500">Motivo: {status.reason}</p> : null}
            </div>
          )}
        </article>

        <section className="grid gap-4 md:grid-cols-2">
          <article className="rounded-lg border border-line bg-white p-5 shadow-panel">
            <h2 className="text-lg font-semibold text-ink">Grupo alvo</h2>
            {loading ? (
              <p className="mt-3 text-sm text-slate-500">Sincronizando...</p>
            ) : (
              <div className="mt-3 space-y-2">
                <p className="text-sm text-slate-700">
                  Allowlist: <strong>{groupInfo?.configuredAllowlist}</strong>
                </p>
                <p className="text-sm text-slate-700">
                  Nome: <strong>{groupInfo?.group?.name ?? "Não sincronizado"}</strong>
                </p>
                <p className="text-sm text-slate-700">
                  Contatos descobertos: <strong>{groupInfo?.group?.extractionCount ?? 0}</strong>
                </p>
                <div className="mt-3 grid gap-2">
                  <button
                    disabled={previewing}
                    onClick={() => void runExtractionPreview()}
                    className="rounded-md border border-line bg-mist px-4 py-2 text-sm disabled:opacity-50"
                  >
                    {previewing ? "Analisando..." : "Prévia da extração (sem gravar)"}
                  </button>
                  <button
                    disabled={syncing || !extractionPreviewResult}
                    onClick={() => void runExtraction()}
                    className="rounded-md border border-line bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
                  >
                    {syncing ? "Extraindo..." : "Executar extração real"}
                  </button>
                </div>
                {extractionPreviewResult ? (
                  <div className="mt-3 space-y-2 rounded-md border border-line bg-mist p-3">
                    <p className="text-sm font-medium text-slate-800">
                      Prévia: {extractionPreviewResult.groupName} ({extractionPreviewResult.groupJid})
                    </p>
                    <p className="text-xs text-slate-600">
                      Processaria <strong>{extractionPreviewResult.extractedMembers}</strong> contatos no total.
                    </p>
                    <p className="text-xs text-slate-600">
                      Novos consentimentos simulados:{" "}
                      <strong>{extractionPreviewResult.upsertedConsents}</strong>
                    </p>
                    <div className="max-h-56 overflow-auto rounded border border-line bg-white">
                      <table className="min-w-full text-left text-xs">
                        <thead className="sticky top-0 bg-white">
                          <tr className="border-b border-line text-slate-500">
                            <th className="py-1 px-3">Telefone</th>
                            <th className="py-1 px-3">Contato</th>
                            <th className="py-1 px-3">Resultado</th>
                            <th className="py-1 px-3">Consentimento atual</th>
                          </tr>
                        </thead>
                        <tbody>
                          {extractionPreviewResult.extractedContacts.map((contact) => (
                            <tr key={contact.phoneE164} className="border-b border-line last:border-0">
                              <td className="px-3 py-1 text-slate-700">{contact.phoneE164}</td>
                              <td className="px-3 py-1 text-slate-700">
                                {contact.displayName || "Sem nome"}
                                {contact.contactId ? null : " (novo)"}
                              </td>
                              <td className="px-3 py-1 text-slate-700">
                                {contact.status === "would_create_consent"
                                  ? "Criar consentimento"
                                  : "Manter contato"}
                              </td>
                              <td className="px-3 py-1 text-slate-700">{contact.existingConsentStatus ?? "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </article>

          <article className="rounded-lg border border-line bg-white p-5 shadow-panel">
            <h2 className="text-lg font-semibold text-ink">Próximos contatos descobertos</h2>
            <div className="mt-3 space-y-2">
              {contacts.slice(0, 6).map((contact) => (
                <div
                  key={contact.contactId}
                  className="flex items-center justify-between rounded-md border border-line bg-mist px-3 py-2"
                >
                  <div>
                    <p className="text-sm font-medium text-slate-800">{contact.displayName ?? "Sem nome"}</p>
                    <p className="text-xs text-slate-500">{contact.phoneE164}</p>
                  </div>
                  <button
                    type="button"
                    onClick={() => void sendOptIn(contact)}
                    disabled={sendingContactId === contact.contactId}
                    className="rounded-md border border-line bg-mist px-3 py-2 text-xs disabled:opacity-50"
                  >
                    {sendingContactId === contact.contactId ? "Enviando..." : "Enviar opt-in"}
                  </button>
                  <Users className="h-4 w-4 text-slate-500" aria-hidden="true" />
                </div>
              ))}
              {contacts.length === 0 ? <p className="text-sm text-slate-500">Nenhum contato ainda.</p> : null}
            </div>
            <div className="mt-4 space-y-2">
              <label className="block text-sm">
                <span className="text-slate-700">CAPSULE accountId</span>
                <input
                  className="mt-1 w-full rounded-md border border-line px-3 py-2"
                  value={capsuleAccountId}
                  onChange={(event) => setCapsuleAccountId(event.target.value)}
                  placeholder="accounts/default"
                />
              </label>
              <label className="block text-sm">
                <span className="text-slate-700">Template de opt-in</span>
                <input
                  className="mt-1 w-full rounded-md border border-line px-3 py-2"
                  value={optInTemplateName}
                  onChange={(event) => setOptInTemplateName(event.target.value)}
                  placeholder="opt_in_template"
                />
              </label>
              <label className="block text-sm">
                <span className="text-slate-700">Idioma</span>
                <input
                  className="mt-1 w-full rounded-md border border-line px-3 py-2"
                  value={optInLanguage}
                  onChange={(event) => setOptInLanguage(event.target.value)}
                  placeholder="pt_BR"
                />
              </label>
              {optInPayloadResult ? <p className="text-xs text-slate-600">{optInPayloadResult}</p> : null}
            </div>
          </article>
        </section>

        <article className="rounded-lg border border-line bg-white p-5 shadow-panel">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-ink">Campanhas + agendamento (Grupo)</h2>
            <CalendarClock className="h-5 w-5 text-accent" aria-hidden="true" />
          </div>

          <div className="grid gap-4">
            <div className="grid gap-3 md:grid-cols-3">
              <label className="block text-sm md:col-span-2">
                <span className="text-slate-700">AccountId do grupo</span>
                <input
                  className="mt-1 w-full rounded-md border border-line px-3 py-2"
                  value={schedulerAccountId}
                  onChange={(event) => setSchedulerAccountId(event.target.value)}
                  placeholder="accounts/default"
                />
              </label>
              <label className="block text-sm">
                <span className="text-slate-700">Início (opcional)</span>
                <input
                  className="mt-1 w-full rounded-md border border-line px-3 py-2"
                  type="datetime-local"
                  value={schedulerStartAt}
                  onChange={(event) => setSchedulerStartAt(event.target.value)}
                />
              </label>
            </div>

            <label className="block text-sm">
              <span className="text-slate-700">Group JID (opcional)</span>
              <input
                className="mt-1 w-full rounded-md border border-line px-3 py-2"
                value={schedulerGroupJid}
                onChange={(event) => setSchedulerGroupJid(event.target.value)}
                placeholder="120000000000000000@g.us"
              />
            </label>
          </div>

          {loading ? (
            <p className="mt-3 text-sm text-slate-500">Carregando campanhas...</p>
          ) : (
            <div className="mt-4 space-y-3">
              <div className="grid gap-2 md:grid-cols-3">
                {campaigns.length === 0 ? (
                  <p className="text-sm text-slate-500">Ainda não há campanhas cadastradas.</p>
                ) : (
                  campaigns.map((campaign) => (
                    <div key={campaign.id} className="rounded-md border border-line bg-mist p-3 text-sm">
                      <p className="font-medium text-slate-800">{campaign.name}</p>
                      <p className="text-xs text-slate-500">Status: {campaign.status}</p>
                      <p className="text-xs text-slate-500">Timezone: {campaign.timezone}</p>
                      <p className="mt-2 text-xs text-slate-500">Criada: {new Date(campaign.createdAt).toLocaleString()}</p>
	                          <div className="mt-3 flex flex-wrap gap-2">
	                            <button
	                              type="button"
	                              onClick={() => void scheduleCampaign(campaign.id)}
                          disabled={isCampaignActionLoading(`schedule:${campaign.id}`)}
                          className="rounded-md border border-line bg-slate-900 px-3 py-2 text-xs text-white disabled:opacity-50"
                        >
	                              {isCampaignActionLoading(`schedule:${campaign.id}`) ? "Agendando..." : "Agendar"}
	                            </button>
	                            <button
	                              type="button"
	                              onClick={() => void loadCampaignApprovals(campaign.id)}
	                              className="rounded-md border border-line bg-mist px-3 py-2 text-xs"
	                            >
	                              {selectedCampaignForApprovals === campaign.id ? "Atualizar aprovações" : "Ver aprovações"}
	                            </button>
	                            <button
	                              type="button"
	                              onClick={() => void loadCampaignJobs(campaign.id)}
	                              className="rounded-md border border-line bg-mist px-3 py-2 text-xs"
	                            >
	                              Ver jobs
	                            </button>
                        <button
                          type="button"
                          onClick={() => void pauseCampaign(campaign.id)}
                          disabled={isCampaignActionLoading(`pause:${campaign.id}`)}
                          className="rounded-md border border-line bg-mist px-3 py-2 text-xs disabled:opacity-50"
                        >
                          <Pause className="mr-1 inline-block h-3.5 w-3.5" aria-hidden="true" />
                          {isCampaignActionLoading(`pause:${campaign.id}`) ? "..." : "Pausar"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void resumeCampaign(campaign.id)}
                          disabled={isCampaignActionLoading(`resume:${campaign.id}`)}
                          className="rounded-md border border-line bg-mist px-3 py-2 text-xs disabled:opacity-50"
                        >
                          <Play className="mr-1 inline-block h-3.5 w-3.5" aria-hidden="true" />
                          {isCampaignActionLoading(`resume:${campaign.id}`) ? "..." : "Retomar"}
                        </button>
                        <button
                          type="button"
                          onClick={() => void cancelCampaign(campaign.id)}
                          disabled={isCampaignActionLoading(`cancel:${campaign.id}`)}
                          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600 disabled:opacity-50"
                        >
                          <Trash2 className="mr-1 inline-block h-3.5 w-3.5" aria-hidden="true" />
                          {isCampaignActionLoading(`cancel:${campaign.id}`) ? "..." : "Cancelar"}
	                              </button>
	                            <button
	                              type="button"
	                              onClick={() => void approveCampaignAction(campaign.id, "approve_workflow")}
	                              disabled={isCampaignApprovalLoading(`approve_workflow:${campaign.id}`)}
	                              className="rounded-md border border-line bg-emerald-50 px-3 py-2 text-xs text-emerald-700 disabled:opacity-50"
	                            >
	                              <ShieldCheck className="mr-1 inline-block h-3.5 w-3.5" aria-hidden="true" />
	                              {isCampaignApprovalLoading(`approve_workflow:${campaign.id}`) ? "Aprovando..." : "Aprovar workflow"}
	                            </button>
	                            <button
	                              type="button"
	                              onClick={() => void approveCampaignAction(campaign.id, "approve_template")}
	                              disabled={isCampaignApprovalLoading(`approve_template:${campaign.id}`)}
	                              className="rounded-md border border-line bg-emerald-50 px-3 py-2 text-xs text-emerald-700 disabled:opacity-50"
	                            >
	                              {isCampaignApprovalLoading(`approve_template:${campaign.id}`) ? "Aprovando..." : "Aprovar template"}
	                            </button>
	                            <button
	                              type="button"
	                              onClick={() => void approveCampaignAction(campaign.id, "start_campaign")}
	                              disabled={isCampaignApprovalLoading(`start_campaign:${campaign.id}`)}
	                              className="rounded-md border border-line bg-emerald-50 px-3 py-2 text-xs text-emerald-700 disabled:opacity-50"
	                            >
	                              {isCampaignApprovalLoading(`start_campaign:${campaign.id}`) ? "Aprovando..." : "Aprovar início"}
	                            </button>
	                          </div>
	                        {selectedCampaignForApprovals === campaign.id ? (
                          <div className="mt-3 rounded-md border border-line bg-white p-2">
                            {(() => {
                              const approvals = campaignApprovalsByCampaign[campaign.id] ?? [];
                              return approvals.length ? (
                                <div className="max-h-40 overflow-auto space-y-2">
                                  {approvals.map((approval) => (
                                    <div
                                      key={approval.id}
                                      className="rounded border border-line px-2 py-1 text-xs"
                                    >
                                      <p className="font-medium text-slate-800">{approval.action}</p>
                                      <p className="text-slate-500">
                                        status: {approval.status} | criado: {new Date(approval.createdAt).toLocaleString()}
                                      </p>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <p className="text-xs text-slate-500">Ainda sem aprovações registradas.</p>
                              );
                            })()}
                          </div>
                        ) : null}
	                        </div>
	                      ))
	                    )}
	                  </div>

              <div className="rounded-md border border-line">
                <div className="border-b border-line p-3">
                  <p className="text-sm font-medium text-slate-700">
                    {campaignJobsCampaignName ? `Jobs da campanha: ${campaignJobsCampaignName}` : "Linha de execução"}
                  </p>
                </div>
                {jobsLoading ? (
                  <p className="p-3 text-sm text-slate-500">Carregando jobs...</p>
                ) : campaignJobs.length === 0 ? (
                  <p className="p-3 text-sm text-slate-500">Nenhum job agendado no momento.</p>
                ) : (
                  <div className="max-h-[320px] overflow-auto">
                    <table className="min-w-full text-left text-sm">
                      <thead>
                        <tr className="border-b border-line text-slate-500">
                          <th className="py-2 pr-4 pl-3">Passo</th>
                          <th className="py-2 pr-4">Status</th>
                          <th className="py-2 pr-4">Execução</th>
                          <th className="py-2 pr-4">Tentativas</th>
                          <th className="py-2 pr-4">Reagendar</th>
                          <th className="py-2">Ações</th>
                        </tr>
                      </thead>
                      <tbody>
                        {campaignJobs.map((job) => (
                          <tr key={job.id} className="border-b border-line last:border-0">
                            <td className="py-2 pr-4 pl-3">
                              <p className="text-slate-700">{job.workflowStepId}</p>
                              <p className="text-xs text-slate-500">{job.id}</p>
                            </td>
                            <td className="py-2 pr-4 text-slate-700">{job.status}</td>
                            <td className="py-2 pr-4 text-slate-700">
                              {new Date(job.runAt).toLocaleString()}
                              <p className="text-xs text-slate-500">Criado: {new Date(job.createdAt).toLocaleString()}</p>
                            </td>
                            <td className="py-2 pr-4 text-slate-700">
                              {job.attemptCount}/{job.maxAttempts}
                            </td>
                            <td className="py-2 pr-4">
                              <input
                                type="datetime-local"
                                value={jobRescheduleById[job.id] ?? toInputDateTime(job.runAt)}
                                onChange={(event) => updateJobReschedule(job.id, event.target.value)}
                                className="w-44 rounded-md border border-line px-2 py-1"
                              />
                            </td>
                            <td className="space-x-2 py-2">
                              <button
                                type="button"
                                onClick={() => void rescheduleJob(job.id)}
                                disabled={isCampaignActionLoading(`rescheduleJob:${job.id}`)}
                                className="rounded-md border border-line bg-mist px-3 py-2 text-xs disabled:opacity-50"
                              >
                                {isCampaignActionLoading(`rescheduleJob:${job.id}`) ? "..." : "Reagendar"}
                              </button>
                              <button
                                type="button"
                                onClick={() => void cancelJob(job.id)}
                                disabled={isCampaignActionLoading(`cancelJob:${job.id}`)}
                                className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 disabled:opacity-50"
                              >
                                <Trash2 className="mr-1 inline-block h-3.5 w-3.5" aria-hidden="true" />
                                {isCampaignActionLoading(`cancelJob:${job.id}`) ? "..." : "Cancelar"}
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {campaignActionMessage ? <p className="mt-3 rounded-md border border-line bg-amber-50 px-3 py-2 text-sm text-amber-700">{campaignActionMessage}</p> : null}
        </article>

        <article className="rounded-lg border border-line bg-white p-5 shadow-panel">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-ink">Tentativas de envio oficial recentes</h2>
            <Send className="h-5 w-5 text-accent" aria-hidden="true" />
          </div>
          {loading ? (
            <p className="mt-3 text-sm text-slate-500">Sincronizando...</p>
          ) : officialAttempts.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">Ainda não há envios oficiais.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-line text-slate-500">
                    <th className="pb-2 pr-4">Contato</th>
                    <th className="pb-2 pr-4">Template</th>
                    <th className="pb-2 pr-4">Status</th>
                    <th className="pb-2 pr-4">Consentimento</th>
                    <th className="pb-2">Atualizado</th>
                  </tr>
                </thead>
                <tbody>
                  {officialAttempts.map((attempt) => (
                    <tr key={attempt.id} className="border-b border-line last:border-0">
                      <td className="py-2 pr-4">
                        <p className="font-medium text-slate-700">{attempt.displayName || "Sem nome"}</p>
                        <p className="text-xs text-slate-500">{attempt.phoneE164 || "—"}</p>
                      </td>
                      <td className="py-2 pr-4 text-slate-700">{attempt.templateKey || "—"}</td>
                      <td className="py-2 pr-4 text-slate-700">{attempt.status}</td>
                      <td className="py-2 pr-4 text-slate-700">{attempt.consentStatus || "—"}</td>
                      <td className="py-2 text-xs text-slate-500">{new Date(attempt.updatedAt).toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </article>

        <article className="rounded-lg border border-line bg-white p-5 shadow-panel">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-ink">Áudio do usuário e instruções da campanha</h2>
            <FileAudio className="h-5 w-5 text-accent" aria-hidden="true" />
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            <section className="space-y-3">
              <p className="text-sm text-slate-600">Cadastro manual da instrução de áudio (pré-processamento da etapa)</p>
              <label className="block text-sm">
                <span className="text-slate-700">Campaign ID (opcional)</span>
                <input
                  className="mt-1 w-full rounded-md border border-line px-3 py-2"
                  value={audioCreatorCampaignId}
                  onChange={(event) => setAudioCreatorCampaignId(event.target.value)}
                  placeholder="ID da campanha (opcional)"
                />
              </label>
              <label className="block text-sm">
                <span className="text-slate-700">Arquivo (URL pública do áudio)</span>
                <input
                  className="mt-1 w-full rounded-md border border-line px-3 py-2"
                  value={audioOriginalFileUrl}
                  onChange={(event) => setAudioOriginalFileUrl(event.target.value)}
                  placeholder="https://..."
                />
              </label>
              <div className="grid gap-2 md:grid-cols-3">
                <label className="block text-sm">
                  <span className="text-slate-700">Duração (ms)</span>
                  <input
                    className="mt-1 w-full rounded-md border border-line px-3 py-2"
                    value={audioDurationMs}
                    onChange={(event) => setAudioDurationMs(event.target.value)}
                    placeholder="120000"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-slate-700">Idioma</span>
                  <input
                    className="mt-1 w-full rounded-md border border-line px-3 py-2"
                    value={audioDetectedLanguage}
                    onChange={(event) => setAudioDetectedLanguage(event.target.value)}
                    placeholder="pt-BR"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-slate-700">Status</span>
                  <select
                    value={audioStatus}
                    onChange={(event) => setAudioStatus(event.target.value as AudioInstructionStatus)}
                    className="mt-1 w-full rounded-md border border-line px-3 py-2"
                  >
                    <option value="uploaded">uploaded</option>
                    <option value="transcribing">transcribing</option>
                    <option value="transcribed">transcribed</option>
                    <option value="needs_review">needs_review</option>
                    <option value="approved_for_workflow">approved_for_workflow</option>
                    <option value="rejected">rejected</option>
                  </select>
                </label>
              </div>
              <label className="block text-sm">
                <span className="text-slate-700">Classificação</span>
                <input
                  className="mt-1 w-full rounded-md border border-line px-3 py-2"
                  value={audioContentClass}
                  onChange={(event) => setAudioContentClass(event.target.value)}
                  placeholder="template, timing, routing..."
                />
              </label>
              <label className="block text-sm">
                <span className="text-slate-700">Transcrição bruta</span>
                <textarea
                  className="mt-1 min-h-[110px] w-full rounded-md border border-line px-3 py-2 text-xs"
                  value={audioRawTranscript}
                  onChange={(event) => setAudioRawTranscript(event.target.value)}
                  placeholder="Cole aqui a transcrição bruta"
                />
              </label>
              <label className="block text-sm">
                <span className="text-slate-700">Transcrição revisada</span>
                <textarea
                  className="mt-1 min-h-[110px] w-full rounded-md border border-line px-3 py-2 text-xs"
                  value={audioReviewedTranscript}
                  onChange={(event) => setAudioReviewedTranscript(event.target.value)}
                  placeholder="Ajuste manual da transcrição (opcional)"
                />
              </label>
              <div className="grid gap-2 md:grid-cols-3">
                <label className="block text-sm">
                  <span className="text-slate-700">Confiança</span>
                  <input
                    className="mt-1 w-full rounded-md border border-line px-3 py-2"
                    value={audioConfidence}
                    onChange={(event) => setAudioConfidence(event.target.value)}
                    placeholder="0.97"
                  />
                </label>
                <div className="block text-sm md:col-span-2">
                  <p className="text-slate-700">Filtros / busca</p>
                  <button
                    type="button"
                    onClick={() => void loadAudioInstructions()}
                    className="mt-1 inline-flex w-full justify-center rounded-md border border-line bg-mist px-3 py-2 text-sm"
                  >
                    Atualizar lista atual
                  </button>
                </div>
              </div>
              <button
                type="button"
                onClick={() => void createAudioInstruction()}
                className="rounded-md border border-line bg-slate-900 px-4 py-2 text-sm text-white"
                disabled={audioInstructionsLoading}
              >
                {audioInstructionsLoading ? "Registrando..." : "Registrar instrução"}
              </button>
            </section>

            <section className="space-y-3">
              <div className="grid gap-2 md:grid-cols-2">
                <label className="block text-sm">
                  <span className="text-slate-700">Filtrar por campaignId</span>
                  <input
                    className="mt-1 w-full rounded-md border border-line px-3 py-2"
                    value={audioListCampaignId}
                    onChange={(event) => setAudioListCampaignId(event.target.value)}
                    placeholder="campanha"
                  />
                </label>
                <label className="block text-sm">
                  <span className="text-slate-700">Filtrar por status</span>
                  <input
                    className="mt-1 w-full rounded-md border border-line px-3 py-2"
                    value={audioListStatus}
                    onChange={(event) => setAudioListStatus(event.target.value)}
                    placeholder="uploaded, transcribed..."
                  />
                </label>
              </div>
              <label className="block text-sm">
                <span className="text-slate-700">Limite</span>
                <input
                  className="mt-1 w-full rounded-md border border-line px-3 py-2"
                  value={audioListLimit}
                  onChange={(event) => setAudioListLimit(event.target.value)}
                  placeholder="25"
                />
              </label>
              <div className="overflow-auto rounded-md border border-line">
                {audioInstructionsLoading ? (
                  <p className="p-3 text-sm text-slate-500">Carregando instruções...</p>
                ) : audioInstructions.length === 0 ? (
                  <p className="p-3 text-sm text-slate-500">Nenhuma instrução cadastrada.</p>
                ) : (
                  <table className="min-w-full text-left text-sm">
                    <thead>
                      <tr className="border-b border-line text-slate-500">
                        <th className="py-2 pr-2 pl-3">Arquivo</th>
                        <th className="py-2 pr-2">Status</th>
                        <th className="py-2 pr-2">Confiança</th>
                        <th className="py-2 pr-2">Ações</th>
                      </tr>
                    </thead>
                    <tbody>
                      {audioInstructions.map((instruction) => (
                        <tr key={instruction.id} className="border-b border-line last:border-0">
                          <td className="max-w-[260px] px-2 py-2">
                            <p className="truncate text-xs text-slate-500" title={instruction.originalFileUrl}>
                              {instruction.originalFileUrl}
                            </p>
                            <p className="text-[11px] text-slate-500">ID: {instruction.id}</p>
                            <p className="text-[11px] text-slate-500">Campanha: {instruction.campaignId ?? "-"}</p>
                          </td>
                          <td className="px-2 py-2">{instruction.status}</td>
                          <td className="px-2 py-2">{instruction.confidence?.toFixed(2) ?? "-"}</td>
                          <td className="px-2 py-2">
                            <button
                              type="button"
                              onClick={() => prepareAudioUpdate(instruction)}
                              className="rounded-md border border-line bg-mist px-3 py-1 text-xs"
                            >
                              Revisar
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              {audioUpdatingId ? (
                <div className="rounded-md border border-line bg-mist p-3">
                  <p className="text-sm font-medium text-slate-700">Revisão de instrução</p>
                  <div className="mt-2 grid gap-2 md:grid-cols-2">
                    <label className="block text-sm">
                      <span className="text-slate-700">Status</span>
                      <select
                        value={audioUpdateStatus}
                        onChange={(event) => setAudioUpdateStatus(event.target.value as AudioInstructionStatus)}
                        className="mt-1 w-full rounded-md border border-line px-3 py-2"
                      >
                        <option value="uploaded">uploaded</option>
                        <option value="transcribing">transcribing</option>
                        <option value="transcribed">transcribed</option>
                        <option value="needs_review">needs_review</option>
                        <option value="approved_for_workflow">approved_for_workflow</option>
                        <option value="rejected">rejected</option>
                      </select>
                    </label>
                    <label className="block text-sm">
                      <span className="text-slate-700">Confiança</span>
                      <input
                        className="mt-1 w-full rounded-md border border-line px-3 py-2"
                        value={audioUpdateConfidence}
                        onChange={(event) => setAudioUpdateConfidence(event.target.value)}
                      />
                    </label>
                  </div>
                  <label className="mt-2 block text-sm">
                    <span className="text-slate-700">Classificação</span>
                    <input
                      className="mt-1 w-full rounded-md border border-line px-3 py-2"
                      value={audioUpdateContentClass}
                      onChange={(event) => setAudioUpdateContentClass(event.target.value)}
                    />
                  </label>
                  <label className="mt-2 block text-sm">
                    <span className="text-slate-700">Transcrição revisada</span>
                    <textarea
                      className="mt-1 min-h-[100px] w-full rounded-md border border-line px-3 py-2 text-xs"
                      value={audioUpdateReviewedTranscript}
                      onChange={(event) => setAudioUpdateReviewedTranscript(event.target.value)}
                    />
                  </label>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => void applyAudioUpdate(audioUpdatingId)}
                      className="rounded-md border border-line bg-slate-900 px-3 py-2 text-xs text-white"
                    >
                      Salvar revisão
                    </button>
                    <button
                      type="button"
                      onClick={() => setAudioUpdatingId("")}
                      className="rounded-md border border-line bg-mist px-3 py-2 text-xs"
                    >
                      Cancelar
                    </button>
                  </div>
                </div>
              ) : null}
            </section>
          </div>
          {audioInstructionMessage ? <p className="mt-3 rounded-md border border-line bg-amber-50 px-3 py-2 text-sm text-amber-700">{audioInstructionMessage}</p> : null}
        </article>

        <article className="rounded-lg border border-line bg-white p-5 shadow-panel">
          <h2 className="text-lg font-semibold text-ink">Rascunho e validação de workflow</h2>
          <p className="mt-1 text-sm text-slate-600">
            Cole aqui o JSON do fluxo, valide as regras e gere um rascunho de campanha.
          </p>
          <div className="mt-4 space-y-3">
            <div className="grid gap-3 md:grid-cols-3">
              <label className="space-y-1 text-sm md:col-span-2">
                <span className="text-slate-700">Nome da campanha</span>
                <input
                  className="w-full rounded-md border border-line px-3 py-2"
                  value={campaignName}
                  onChange={(event) => setCampaignName(event.target.value)}
                  placeholder="Campanha inicial"
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="text-slate-700">Timezone</span>
                <input
                  className="w-full rounded-md border border-line px-3 py-2"
                  value={campaignTimezone}
                  onChange={(event) => setCampaignTimezone(event.target.value)}
                  placeholder="America/Sao_Paulo"
                />
              </label>
            </div>
            <label className="block">
              <span className="text-sm text-slate-700">Workflow JSON</span>
              <textarea
                className="mt-1 min-h-[220px] w-full rounded-md border border-line px-3 py-2 font-mono text-xs"
                value={workflowDraft}
                onChange={(event) => setWorkflowDraft(event.target.value)}
              />
            </label>
            <div className="flex flex-wrap gap-2">
              <button
                onClick={() => void validateWorkflow()}
                disabled={validationLoading}
                className="rounded-md border border-line bg-mist px-4 py-2 text-sm disabled:opacity-50"
              >
                {validationLoading ? "Validando..." : "Validar fluxo"}
              </button>
              <button
                onClick={() => void createCampaign()}
                disabled={campaignCreating}
                className="rounded-md border border-line bg-slate-900 px-4 py-2 text-sm text-white disabled:opacity-50"
              >
                {campaignCreating ? "Criando..." : "Criar campanha draft"}
              </button>
            </div>
          </div>

          {validationResult ? (
            <div className="mt-4 rounded-md border border-line p-3">
              <p className="mb-2 flex items-center gap-2 text-sm font-medium">
                {validationResult.valid ? (
                  <>
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
                    Fluxo válido
                  </>
                ) : (
                  <>
                    <CircleAlert className="h-4 w-4 text-amber-600" aria-hidden="true" />
                    Fluxo com ajustes
                  </>
                )}
              </p>
              <ul className="space-y-1 text-sm">
                {validationResult.issues.map((issue) => (
                  <li className="text-slate-700" key={`${issue.code}-${issue.path}-${issue.message}`}>
                    <strong>{issue.path}</strong>: {issue.message} <span className="text-slate-500">({issue.code})</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {campaignResult ? (
            <div className="mt-4 rounded-md border border-line bg-mist px-3 py-2 text-sm text-slate-700">
              <p>Campanha criada: {campaignResult.campaignId}</p>
              <p>Versão: {campaignResult.campaignVersionId}</p>
              <p>Status: {campaignResult.status}</p>
            </div>
          ) : null}

          {campaignMessage ? <p className="mt-2 rounded-md border border-line bg-amber-50 px-3 py-2 text-sm">{campaignMessage}</p> : null}
        </article>

        {extractionResult ? (
          <article className="rounded-lg border border-line bg-white p-5 shadow-panel">
            <h2 className="text-lg font-semibold text-ink">Última extração</h2>
            <p className="mt-2 text-sm text-slate-700">
              {extractionResult.groupName} ({extractionResult.groupJid})
            </p>
            <p className="mt-1 text-sm text-slate-700">
              Contatos processados: <strong>{extractionResult.extractedMembers}</strong>
            </p>
            <p className="mt-1 text-sm text-slate-700">
              Novos consentimentos: <strong>{extractionResult.upsertedConsents}</strong>
            </p>
          </article>
        ) : null}

        {message ? <p className="rounded-md border border-line bg-amber-50 px-4 py-2 text-sm text-amber-700">{message}</p> : null}
        {campaignMessage && !campaignResult ? <p className="rounded-md border border-line bg-amber-50 px-4 py-2 text-sm text-amber-700">{campaignMessage}</p> : null}
      </section>
    </main>
  );
}
