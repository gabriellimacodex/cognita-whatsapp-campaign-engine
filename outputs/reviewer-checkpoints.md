# Registro de Checkpoints de Revisão por Fase

Objetivo: controlar o gate de revisão entre fases e manter trilha de aprovação humana do projeto.

## Template de revisão (padrão)

- **Fase:**  
- **Período:**  
- **Revisor:**  
- **Data:**  
- **Decisão:** ✅ Aprovado / ⚠️ Pendente / ❌ Rejeitado  
- **Riscos críticos encontrados:**  
- **Correções solicitadas:**  
- **Link dos artefatos validados:**  
- **Observações:**  

---

## Fase 1 — Fundação de Negócio e Domínio
- **Data:** 2026-06-07
- **Revisor:** Revisor interno (QA/Arquitetura)
- **Decisão:** ✅ Aprovado para continuação
- **Checkpoints validados:**
  - [x] Domínio e contratos conferidos
  - [x] Bloqueios de consentimento e risco validados
  - [x] Sem envio sem aprovação persistida (apenas validação de regras implementada nesta fase)
  - [x] Idempotência inicial e trilha mínima de auditoria (schemas e entidades de tentativa)
- **Evidências:**
  - `packages/domain/src/risk-engine.ts`, `packages/domain/src/consent.ts`
  - `packages/domain/src/risk-engine.test.ts`, `packages/domain/src/consent.test.ts`, `packages/domain/src/workflow.test.ts`
  - `prisma/schema.prisma` atualizado com Campaign/Workflow/ScheduledJob/Approval/Enrollment/OptOut
  - `pnpm typecheck`, `pnpm build`, `pnpm test` concluídos com sucesso

---

## Fase 2 — Executor Oficial 1:1 + Consentimento
- **Data:** 2026-06-07
- **Revisor:** Revisor interno (QA/Arquitetura)
- **Decisão:** ✅ Aprovado para continuação
- **Checkpoints validados:**
  - [x] Endpoint para envio de opt-in via `Capsule` implementado e idempotente por `idempotencyKey`
  - [x] Enriquecimento de `SendAttempt` com prova (template, message id, payload bruto)
  - [x] Extração de resposta por webhook (status/mensagem) com dedupe por assinatura calculada
  - [x] Atualização de `ContactConsent` com trilha de resposta positiva/negativa detectada por texto
  - [x] Bloqueio de fluxo comercial sem `opted_in` via `evaluateSendRisk` no novo endpoint oficial
- **Evidências:**  
  - `apps/backend/src/application/official/official-campaign.service.ts`
  - `apps/backend/src/web/official.controller.ts`
  - `outputs/reviewer-checkpoints.md`

---

## Fase 3 — Branch de Grupo (UAZAPI)
- **Data:** 2026-06-08
- **Revisor:** Revisor interno (QA/Arquitetura) + revisão funcional em implementação
- **Decisão:** ⚠️ Pendente (validar integração operacional UAZAPI em produção)
- **Checkpoints validados:**
  - [x] `GET /campaigns/:campaignId/approvals` e `POST /campaigns/:campaignId/approve` validados com criação de registro de aprovação.
  - [x] `GET /campaigns/:campaignId/schedule` e `POST /campaigns/schedule` validados até pré-condição de integração (`templates_approved` + validação de grupo/instância).
  - [x] `POST /campaigns/:campaignId/pause`, `POST /campaigns/:campaignId/resume`, `POST /campaigns/:campaignId/cancel`, `POST /campaigns/jobs/:jobId/reschedule` e `POST /campaigns/jobs/:jobId/cancel` validados.
  - [ ] Validação de concorrência, retry e consistência entre `ScheduledJob`/`SendAttempt` em execução real.
- **Evidências:**  
  - `apps/backend/src/application/scheduler/campaign-scheduler.service.ts`
  - `apps/backend/src/application/group/group-sync.service.ts`
  - `apps/worker/src/main.ts`
  - `apps/frontend/src/app/page.tsx`
  - `apps/frontend/.eslintrc.json`
  - `apps/frontend/package.json`
  - `outputs/backend-api-integration.md`
  - `outputs/phase3-staging-smoke-checklist.md`
  - `scripts/phase3-staging-smoke.sh`
  - `pnpm build`, `pnpm typecheck`, `pnpm test`
  - `pnpm lint`, `COREPACK_HOME=/tmp/cognita-corepack pnpm -C apps/frontend lint`
- **Observações:**  
  - No ambiente atual, `GET /integration/uazapi/status` retorna conexão/instância saudável, porém `GET /integration/uazapi/groups` falha com `401 Invalid token` usando o token informado.
  - Sem sincronização de `GroupTarget` e `ChannelAccount`, o `schedule` ainda não cria jobs persistentes em produção.

## Fase 4 — Chat Ágil + Áudio
- **Data:** 2026-06-08
- **Revisor:** Revisor interno (QA/Arquitetura)
- **Decisão:** ⚠️ Pendente (implementado e parcialmente validado)
- **Checkpoints validados:**
  - [x] `POST /audio-instructions` (criação)
  - [x] `GET /audio-instructions` com filtro por campanha
  - [x] `PATCH /audio-instructions/:id` com atualização de metadados/revisão
  - [ ] `needs_review` aplicado para baixa confiança em regra automática de negócio
  - [ ] Origem da etapa (`audio`/`print`/`texto`) rastreável por decisão
  - [ ] Ambiguidade e ausência de validação humana não geram execução automática
- **Evidências:**  
  - `apps/backend/src/application/audio/audio-instruction.service.ts`
  - `apps/backend/src/web/audio.controller.ts`
  - `apps/frontend/src/app/page.tsx`

---

## Fase 5 — Approval Console + Frontend
- **Data:**  
- **Revisor:**  
- **Decisão:**  
- **Checkpoints validados:**
  - [ ] Aprovação de etapas críticas com registro
  - [ ] UI bloqueia ação irreversível sem estado aprovado
  - [ ] Timeline operacional coerente com backend
- **Evidências:**  

---

## Fase 6 — Operação, Segurança e Produção
- **Data:**  
- **Revisor:**  
- **Decisão:**  
- **Checkpoints validados:**
  - [ ] Readiness completo em staging
  - [ ] Rollback, observabilidade e alertas funcionando
  - [ ] Kill switches e feature flags validadas
  - [ ] Runbook e RBAC aprovados
- **Evidências:**  

---

## Fechamento final
- **Data de go-live:**  
- **Revisor final:**  
- **Decisão de liberação:**  
- **Condições de contingência:**  
- **Plano de monitoramento pós-go-live (72h):**  
