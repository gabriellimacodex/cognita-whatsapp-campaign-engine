# Plano de Desenvolvimento — WhatsApp Campaign Engine

Baseado em:
- `outputs/prd-whatsapp-campaign-engine.md`
- `outputs/technical-design-whatsapp-campaign-engine.md`

Objetivo: entregar o MVP com revisão obrigatória entre fases para reduzir risco técnico e de compliance antes de avançar.

---

## 0) Status atual (já entregue)
- Estrutura inicial de backend em NestJS + Fastify e frontend Next.js.
- Configuração de ambiente e integração base com UAZAPI (`status`, `grupos`, `grupo allowlist`, extração de participantes).
- Persistência inicial de `Contact`, `ContactConsent`, `GroupTarget`, `GroupContactExtraction`, `SendAttempt`, `UserAudioInstruction`.
- Página inicial do console com:
  - status da instância,
  - execução manual de extração,
  - lista de contatos descobertos.
- Validação local já executada:
  - `pnpm typecheck` ✅
  - `pnpm build` ✅
  - `pnpm test` ✅

**Pendência operacional atual:** normalização de ambiente no VPS para `prisma generate` e geração de client com acesso a binário.

---

## 1) Princípio de entrega contínua
- **Regra 1:** uma execução avança até concluir uma fase inteira antes de trocar de foco.
- **Regra 2:** nenhuma ação irreversível (envios reais, criação/submissão de template em produção) sem aprovação humana.
- **Regra 3:** backend decide lógica (risco, consentimento, estados); providers só executam.
- **Regra 4:** todo envio passa por idempotência + risk engine + trilha de auditoria.

---

## 2) Governança: revisão obrigatória entre fases
O projeto só avança de uma fase para a próxima após esta sequência:

1. **Fase A (Dev):** implementação completa dos entregáveis da fase + validações unitárias.
2. **Fase B (QA):** execução da suíte de testes da fase + smoke checks associados.
3. **Fase C (Revisor):** revisão técnica independente de arquitetura, segurança, compliance e risco operacional.

Sem aprovação formal do revisor nesta etapa, não iniciamos a próxima fase.

### 2.1 Checkpoint de revisão (obrigatório)
Para cada fase, validar:

- Integridade de risk/consentimento e bloqueio de envio sem aprovação.
- Sem exposição de secrets/tokens no frontend ou logs.
- Webhooks persistidos e idempotentes (dedupe de eventos duplicados, inválidos ou fora de ordem).
- `scheduled_jobs`, `send_attempts` e timeline com rastreabilidade completa.
- Conformidade com:
  - `docs/code-review-checklist.md`
  - `docs/qa-strategy.md`

### 2.2 Critério de aceite
- **Aprovado:** registrar aprovação no rastreador (`outputs/reviewer-checkpoints.md`) e seguir para próxima fase.
- **Pendente:** listar bloqueios com dono, prazo e ação corretiva; a fase só segue após nova revisão.
- **Recusado:** bloquear avanço e retornar para correções obrigatórias no mesmo ciclo.

---

## 3) Fase 1 — Fundação de Negócio e Domínio (1 semana)
**Objetivo:** consolidar modelo do negócio em termos de domínio e contratos.

### Entregáveis
1. Completar schema Prisma conforme entidades do TDD:
   - `Campaign`, `CampaignVersion`, `WorkflowDefinition`, `WorkflowStep`,
   - `TemplateDraft`, `TemplateVersion`,
   - `ChannelAccount`, `ScheduledJob`, `Approval`, `OptOut`, `Enrollment`.
2. Criar adapters/ports de persistência com tipagem forte:
   - Repositories para cada agregado crítico.
3. Implementar `RiskEngine` formal com checks do PRD:
   - aprovação de campanha,
   - allowlist de grupo,
   - estado de opt-in,
   - janela/template/compliance,
   - idempotência.
4. Implementar `Workflow canonical JSON` (schema + validação).

### Entregáveis de QA
- Testes unitários do risk engine + validação de estados de consentimento.

### Gate de conclusão
- `GET /health`, criação de campanha em draft, tentativa de envio negada quando sem aprovação.

### Revisor (entre Fase 1 e Fase 2)
- Validar se risco/consentimento está travando envio comercial sem aprovação humana.
- Validar idempotência inicial dos testes de consentimento.
- Aprovar ou bloquear evolução conforme checklist de dados sensíveis e trilha de auditoria.

---

## 4) Fase 2 — Executor Oficial 1:1 (Kapso/Capsule) + Consentimento (1.5 semana)
**Objetivo:** completar a “branch oficial” com trilha de opt-in.

### Entregáveis
1. Adapter `TemplateProvider` com:
   - listar templates,
   - submeter template,
   - status de template,
   - envio de template oficial 1:1.
2. Adapter de template oficial:
   - cadastro/submissão de versão.
3. Workflow de extração em fluxo:
   - `group_member_discovered` → dedupe + normalização E.164 → `consent_request_candidate` → envio template de opt-in → `opt_in_requested`.
4. Webhook receiver para eventos oficiais:
   - `message.sent`, `delivered`, `failed`, `received`,
   - mapear em `SendAttempt`, `MessageEvent`, `ContactConsent`.
5. Prova de consentimento:
   - prova guardada com `template`, `payload`, `template renderizado`, `message id`, `resposta/ação`.
6. Regra hard: bloqueio de fluxo comercial para contatos sem `opted_in`.

### Entregáveis de QA
- Teste de integração (mockado) para o ciclo de consentimento:
  - descoberta → opt-in enviado → retorno positivo/negativo → atualização de estado.

### Gate de conclusão
- Template de opt-in aprovado pela lógica de negócio e rastreável em logs/timeline.

### Revisor (entre Fase 2 e Fase 3)
- Validar que apenas template de opt-in é disparado para contatos descobertos.
- Validar prova de consentimento completa e persistida.
- Validar tratamento seguro de webhook para eventos de resposta/erro sem duplicidade.

---

## 5) Fase 3 — Branch de Grupo (UAZAPI) com agendamento e timeline (1.5 semana)
**Objetivo:** tornar o envio em grupo operacional com controles de segurança.

### Entregáveis
1. `CampaignScheduler` (BullMQ) para passos do fluxo.
2. `GroupExecutor` para `uazapi_group`:
   - validação de status da instância,
   - validação de allowlist,
   - sem concorrência excessiva (concurrency limitada),
   - deduplicação por idempotency key.
3. APIs de operação do fluxo de grupo:
   - criar/editar/pausar/cancelar envio.
   - visualizar, reagendar e cancelar job individuais.
4. Expandir integração de eventos UAZAPI:
   - conexão/sender/groups/messages.
5. Falhas transientes com retry limitado; falha de compliance sem retry.
6. Console operacional de campanha com timeline de jobs para operação manual.
7. Entrega de validação operacional:
   - `outputs/phase3-staging-smoke-checklist.md`
   - `scripts/phase3-staging-smoke.sh`

### Entregáveis de QA
- Testes de contrato do scheduler + integração de execução controlada (ambiente de staging com grupo allowlist).
- Teste de integração de API/UI (agendamento e controle de jobs) com cenários de pausa, retomada, cancelamento e re-agendamento.

### Gate de conclusão
- Execução de agendamento no grupo + status registrado em timeline real.

### Revisor (entre Fase 3 e Fase 4)
- Validar bloqueio de grupos fora da allowlist e de instância desconectada.
- Validar que falhas transitórias não afetam trilha de consentimento.
- Validar limites de concorrência e ausência de vazamento de secrets de envio.

---

## 6) Fase 4 — Chat Ágil + Áudio (3 semanas)
**Objetivo:** entregar o fluxo de entrada (prints/texto/audio) com revisão humana.

### Entregáveis
1. Upload e gestão de anexos:
   - imagem,
   - áudio,
   - storage versionado.
2. Transcrição de áudio:
   - estado `uploaded → transcribing → transcribed → needs_review/approved_for_workflow`.
3. Parser/segmentador de instruções:
   - detectar mensagem/time/channel/dependency/hora etc.
4. Geração de `WorkflowDraft` a partir de entradas;
5. Edição manual antes de salvar draft.
6. Marcação de origem (`audio` / `print` / `texto`) em cada etapa.

### Entregáveis de QA
- Teste de ambiguidade/conflict detection + fluxo `needs_review` quando baixa confiança.

### Gate de conclusão
- Usuário cria workflow e aprova manualmente.

### Revisor (entre Fase 4 e Fase 5)
- Validar revisão obrigatória para itens com confiança baixa.
- Validar rastreabilidade de origem dos passos do fluxo.
- Validar que não existe execução automática sem aprovação humana do draft.

---

## 7) Fase 5 — Approval Console + Frontend “Apple-grade” (2 semanas)
**Objetivo:** visão operacional completa e segura.

### Entregáveis
1. Telas priorizadas (segundo o PRD):
   - Command Center,
   - Campaign Builder,
   - Approval Console,
   - Group Operations,
   - Consent Inbox,
   - Timeline unificada.
2. Aprovações rastreadas:
   - aprovar workflow,
   - aprovar template,
   - aprovar início de campanha,
   - pausar.
3. Timeline por campanha/grupo/contato com origem da decisão.
4. SSE para atualização near-real-time.

### Entregáveis de UX
- Estados claros, microinterações discretas, sem marketing page.

### Gate de conclusão
- Painel exibe em tempo real: contatos, tentativas, falhas, consentimentos e marcos da campanha.

### Revisor (entre Fase 5 e Fase 6)
- Revisar fluxo de aprovação e bloqueios no UI/Backend.
- Validar consistência de estados entre frontend e auditoria.
- Verificar exposição de operações críticas e confirmações obrigatórias.

---

## 8) Fase 6 — Operação, Segurança e Produção (1 semana)
**Objetivo:** hardening completo para entrada em uso real.

### Entregáveis
1. Kill switch global e por canal.
2. RBAC básico (owner/admin/operator/viewer).
3. Secrets centralizadas (sem logs de token).
4. Assinatura e validação de webhooks (secrets por canal).
5. Métricas e alertas:
   - falha de provider,
   - opt-out spikes,
   - campanhas com template pendente,
   - desconexão UAZAPI.
6. Runbook para rollback e incidente.

### Entregáveis de QA
- Testes de ponta a ponta com cenário mínimo do PRD.

### Gate de conclusão
- Ambiente de staging com execução controlada e deploy reprodutível.

### Revisor (go-live)
- Validar readiness completo: webhooks, secrets, rollback, observabilidade.
- Validar kill switches e feature flags.
- Assinar liberação condicional de produção.

---

## 9) Plano de execução paralela (sem interrupção)
- **Fluxo A (Desenvolvimento):** implementação por fases acima.
- **Fluxo B (QA):** enquanto há código novo, validação de contratos e testes.
- **Fluxo C (Revisor):** revisão de segurança/riscos (tokens, consentimento, retry, idempotência).

Sequência prática:
- Fase finalizada e testada em A/B.
- Revisor C valida o checkpoint documentado.
- Só então iniciamos a próxima fase.

---

## 10) Marcos de aceite obrigatórios (PRD)
1. Criar campanha por texto/print/audio.
2. Revisar e aprovar workflow draft.
3. Extrair grupo allowlistado.
4. Salvar contatos como `group_member_discovered` e deduplicar.
5. Enviar opt-in oficial e registrar prova.
6. Bloquear disparo comercial sem `opted_in`.
7. Dashboard mostra timeline completa de campanha, grupo e contatos.

---

## 11) Cronograma sugerido
- **Semanas 1-2:** Fase 1 + início da Fase 2  
- **Semanas 3-4:** Fase 2 completa + início da Fase 3  
- **Semanas 5-6:** Fase 3 completa + início da Fase 4  
- **Semanas 7-8:** Fase 4 completa + início da Fase 5  
- **Semanas 9-10:** Fase 5 + Fase 6 (hardening + produção)

---

## 12) Próximo passo imediato (sem pedido de decisão)
Vamos iniciar a **Fase 1** com foco em:
1) completar domínio/prisma do workflow oficial + scheduled jobs,  
2) construir `RiskEngine` final com regras de opt-in/allowlist/concurrency,  
3) preparar contratos de scheduler + tentativa de envio idempotente.

Depois disso, seguimos para a **Fase 2** somente com sinal verde do revisor.
