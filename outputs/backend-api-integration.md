# API de Integração Implementada (fase atual)

## Endpoints iniciais UAZAPI

- `GET /integration/uazapi/status`
  - Retorna `connected`, `loggedIn`, `status` e `reason`.

- `GET /integration/uazapi/groups`
  - Lista grupos visíveis na instância por UAZAPI.

- `GET /integration/uazapi/groups/allowlisted`
  - Busca o grupo do ambiente (`UAZAPI_GROUP_ALLOWLIST_JID`) registrado no banco.

- `GET /integration/uazapi/contacts/discovered?limit=200`
  - Lista contatos com consentimento em `group_member_discovered`.

- `POST /integration/uazapi/groups/extract`
  - Body opcional: `{ "groupJid": "...@g.us" }`.
  - No MVP, somente o `groupJid` allowlist é aceito.
  - Extrai participantes do grupo, normaliza telefone e grava:
    - `Contact`
    - `ContactConsent` com status `group_member_discovered`
    - `GroupContactExtraction`

- `POST /integration/uazapi/groups/extract/preview`
  - Body opcional: `{ "groupJid": "...@g.us" }`.
  - Mesma validação de allowlist e conectividade da rota real, porém **sem persistência**.
  - Retorna a lista de participantes normalizados e o efeito esperado (`would_keep`/`would_create_consent`) para revisão antes da extração.

- `POST /workflow/validate`
  - Recebe um `WorkflowDefinition` e retorna `{ valid, issues }` com validação estrutural.
  - Regras de validação incluem:
    - estrutura mínima (`version`, `timezone`, `entry`, `nodes`, `edges`);
    - unicidade de `nodes.id` e existência de `start`;
    - unicidade/integridade de referências entre `edges`;
    - validações específicas por tipo de node (`send_template`, `send_text`, `send_group_message`, espera de tempo, etc).

## Endpoints de campanha (MVP inicial)

- `POST /campaigns`
  - Cria uma campanha em `draft` com `CampaignVersion` 1
  - Recebe:
    - `name?: string`
    - `timezone?: string`
    - `workflow: unknown`
  - Executa validação estrutural de `workflow` antes de persistir.
  - Retorna `campaignId`, `campaignVersionId`, `status` e `workflowValidation`.

- `GET /campaigns?limit=25`
  - Lista campanhas ordenadas pela mais recente, com versão mais nova anexada.

## Endpoints de operações de campanha em grupo

- `POST /campaigns/schedule`
  - Cria o plano de envio da campanha no canal `uazapi_group` a partir do `WorkflowDefinition`.
  - Body:
    - `campaignId` (obrigatório)
    - `accountId` (obrigatório): conta/instância a ser usada no envio do grupo
    - `startAt` (opcional): ISO datetime de início do fluxo (ex.: `2026-06-07T17:00:00.000Z`)
    - `groupJid` (opcional): substitui a allowlist padrão
  - A resposta retorna:
    - `campaignId`, `campaignStatus`, `scheduleStartedAt`, `jobs[]`.
    - Cada job possui `scheduledJobId`, `workflowStepId`, `runAt`, `status`, `idempotencyKey`, `groupTargetId`.

- `GET /campaigns/:campaignId/schedule`
  - Lista jobs de uma campanha para operação operacional.
  - Retorna `campaignId`, `campaignName`, `jobs[]` com `status`, `runAt`, `attemptCount`, `maxAttempts`.

- `POST /campaigns/:campaignId/pause`
  - Interrompe jobs ativos da campanha e marca status interno como `paused`.
  - Retorna `campaignId`, `status`, `jobsUpdated`.

- `POST /campaigns/:campaignId/resume`
  - Retorna jobs com status `blocked` para a fila.
  - Retorna `campaignId`, `status`, `jobsEnqueued`.

- `POST /campaigns/:campaignId/cancel`
  - Cancela jobs da campanha e marca status interno como `paused`.
  - Retorna `campaignId`, `status`, `jobsCancelled`.

- `POST /campaigns/jobs/:jobId/cancel`
  - Cancela um job específico.
  - Retorna `scheduledJobId`, `campaignId`, `status`.

- `POST /campaigns/jobs/:jobId/reschedule`
  - Reagenda data/hora (`runAt`) de um job.
  - Body: `{ "runAt": "2026-06-07T17:00:00.000Z" }`.
  - Retorna `scheduledJobId`, `campaignId`, `status`, `runAt`.

### Comportamentos operacionais

- Criação de agendamento é idempotente por `idempotencyKey`.
- Regras de risco válidas para execução em grupo:
  - campanha precisa estar aprovada para execução;
  - grupo precisa ser allowlisted;
  - instância conectada/logada;
  - risco de concorrência controlado com queue `concurrency=2`.
- Falhas transitórias no worker (`timeout`, `429`, `5xx`, erros de rede) retornam ao estado `retrying` até `maxAttempts`.
- Falhas não transitórias ficam em `failed`.

- Todas as transições relevantes atualizam:
  - `scheduled_job.status`
  - `send_attempt.status`
  - `send_attempt.errorMessage` (quando aplicável)

### Smoke de validação em staging (fase 3)

- `scripts/phase3-staging-smoke.sh` executa:
  - healthcheck,
  - consulta e escolha de campanha elegível,
  - criação de campanha em draft (se necessário),
  - schedule/pause/resume/listagem,
  - reschedule/cancel de job.
- Checklist operacional complementar: `outputs/phase3-staging-smoke-checklist.md`.

## Endpoints oficiais (Capsule/Kapso)

- `GET /integration/capsule/health?accountId=...`
  - Health check da conexão/provedor oficial.
  - O serviço oficial tenta configuração por:
    - `CAPSULE_BASE_URL` + `CAPSULE_API_KEY`; se não houver, usa
    - `KAPSO_BASE_URL` + `KAPSO_API_KEY`.
- `GET /integration/capsule/templates?accountId=...`
  - Lista templates oficiais registrados no provedor.
- `GET /integration/capsule/templates/{templateName}/status?accountId=...`
  - Consulta status de template.
- `POST /integration/capsule/templates`
  - Submissão de template.
- `POST /integration/capsule/send/opt-in`
  - Envia template de opt-in para lead extraído e retorna o `sendAttempt`.
- `POST /integration/capsule/send/template`
  - Envia template oficial com validação de risco por estado de consentimento.
  - Query/body aceitam `isOptInTemplate` e `isCommercialTemplate` para direção de política.
- `GET /integration/capsule/send-attempts?limit=40`
  - Lista tentativas oficiais para operação operacional.
- `POST /integration/capsule/webhook`
  - Recebe eventos de status/resposta do provedor oficial e atualiza:
    - `WebhookEvent`
    - `MessageEvent`
    - `SendAttempt` (sent/delivered/read/failed)
    - `ContactConsent` (`opted_in` ou `opt_out` conforme resposta por texto)
## Infra de backend adicionada

- `apps/backend/src/infrastructure/config/*`
  - `AppConfigService` + módulo global de configuração com validação Zod via `@cognita-campaign/config`.

- `apps/backend/src/infrastructure/prisma/*`
  - Cliente Prisma no Nest (`PrismaService`) + módulo.

  - `apps/backend/src/infrastructure/uazapi/uazapi.adapter.ts`
  - Adapter dos endpoints auditados da UAZAPI (`/status` com fallback para `/instance/status`, `/group/list`, `/group/info`, tentativa de `/send/text` com fallback para `/sender/simple`).

- `apps/backend/src/application/group/group-sync.service.ts`
  - Lógica de sincronização/extracao e persistência de contatos.

- `apps/backend/src/web/uazapi.controller.ts`
  - Controlador REST dos endpoints UAZAPI.

- `apps/backend/src/modules/group.module.ts`
  - Composição de providers/controllers da operação UAZAPI.

## Front-end inicial

- `apps/frontend/src/app/page.tsx`
  - Console operacional inicial com:
    - saúde da instância,
    - dados do grupo allowlisted,
    - disparo manual de extração,
    - lista de contatos descobertos.
  - Editor de workflow draft JSON com validação visual e criação de campanha em `draft`.
