# Fase 3 — Checklist de Smoke em Staging

Objetivo: validar controle operacional do agendador de grupo (`/campaigns`) e rastreabilidade de jobs no staging antes da próxima etapa.

## 1) Pré-requisitos

- Serviços de apoio no VPS: PostgreSQL e Redis apontando para o `DATABASE_URL` e `REDIS_URL` da API.
- Backend (porta 3001) e Worker ativos para processar fila `campaign-jobs`.
- Frontend opcional ativo (porta 3000) para visualização.
- Variáveis essenciais definidas:
  - `DATABASE_URL`
  - `REDIS_URL`
  - `UAZAPI_GROUP_ALLOWLIST_JID`
  - `KAPSO_BASE_URL`, `KAPSO_API_KEY` (se habilitada a camada oficial)
  - `API_BASE_URL` ou `NEXT_PUBLIC_API_BASE_URL` (frontend)
- Chave de instância definida para o canal de grupo:
  - `UAZAPI_GABRIEL_INSTANCE_TOKEN` / credenciais da integração conforme o adapter atual.

## 2) Executar smoke script de staging (local/VPS)

### 2.1) Rodando local para pré-validação

```bash
cd /caminho/do/projeto
export ACCOUNT_ID=accounts/default   # ajuste para o id da conta/canal correta
export API_BASE=http://localhost:3001
export GROUP_JID=120363409578992998@g.us # opcional (ou deixe vazio para allowlist padrão)
bash scripts/phase3-staging-smoke.sh "$ACCOUNT_ID"
```

### 2.2) Rodando no VPS

```bash
cd /opt/cognita-whatsapp-campaign-engine
export ACCOUNT_ID=accounts/default   # ou accountId real utilizado na campanha
export API_BASE=https://<host-da-api>/        # URL pública da API
export GROUP_JID=120363409578992998@g.us    # opcional
bash scripts/phase3-staging-smoke.sh "$ACCOUNT_ID"
```

## 3) O que cada arquivo gerado deve provar

- `01-health.json` → API responde `.status`.
- `02-campaigns-before.json` → listagem de campanhas retorna JSON válido.
- `03-campaign-create.json` → campanha fallback criada (aparecer apenas quando não houver elegíveis).
- `04-campaign-schedule.json` → schedule retorna `campaignId` e `jobs`.
- `05-campaign-jobs.json` → jobs do campanha com `id`, `status`, `runAt`, `attemptCount`.
- `06-campaign-pause.json` → pause retornou `jobsUpdated`.
- `07-campaign-resume.json` → resume retornou `jobsEnqueued`.
- `08-job-reschedule.json` → job foi remarcado para `runAt` futuro.
- `09-job-cancel.json` → job cancelado com sucesso.

## 4) Validação complementar no banco

### 4.1) Conferir estado da campanha/schedule

```sql
select id, name, status
from "Campaign"
where id = '<CAMPAIGN_ID>'
order by "createdAt" desc;

select id, "workflowStepId", status, "attemptCount", "maxAttempts", "runAt", "idempotencyKey", "createdAt"
from "ScheduledJob"
where "campaignId" = '<CAMPAIGN_ID>'
order by "createdAt" desc;
```

### 4.2) Conferir trilha de tentativa associada

```sql
select sa.id, sa."campaignId", sa."scheduledJobId", sa.status, sa."providerMessageId", sa."errorMessage", sa."updatedAt"
from "SendAttempt" sa
where sa."campaignId" = '<CAMPAIGN_ID>'
order by sa."createdAt" desc;

select me.id, me."sendAttemptId", me."providerMessageId", me."eventType", me."provider", me."occurredAt"
from "MessageEvent" me
where me."sendAttemptId" in (
  select id from "SendAttempt" where "campaignId" = '<CAMPAIGN_ID>'
)
order by me."occurredAt" desc;
```

## 5) Criterios de aceitação da fase

- [ ] `POST /campaigns/schedule` responde sucesso e cria ao menos um `job` quando workflow possui `send_group_message`.
- [ ] `GET /campaigns/:id/schedule` devolve lista de jobs da campanha.
- [ ] `POST /campaigns/:id/pause` altera pendentes para estado `blocked` no payload e/ou DB.
- [ ] `POST /campaigns/:id/resume` retorna re-enfileiramento.
- [ ] `POST /campaigns/jobs/:jobId/reschedule` aceita novo `runAt` e atualiza status.
- [ ] `POST /campaigns/jobs/:jobId/cancel` atualiza job para `cancelled`/`cancelled`.
- [ ] `ScheduledJob` e `SendAttempt` convergem com os eventos da execução real no staging.

## 6) Rollback rápido

Se algo falhar no smoke:

1. Pausar campanha: `POST /campaigns/<CAMPAIGN_ID>/pause`
2. Cancelar jobs pendentes: `POST /campaigns/<CAMPAIGN_ID>/cancel`
3. Em ambiente de banco, checar jobs `status in ('queued','retrying','running')` e forçar `blocked`/`cancelled`.
4. Reexecutar deploy apenas após corrigir causa raiz.

