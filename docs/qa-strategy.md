# QA Strategy - WhatsApp Campaign Engine MVP

## 1. Objetivo

Garantir que o MVP opere com seguranca operacional, consentimento rastreavel e execucao previsivel antes de qualquer uso em producao.

Esta estrategia cobre:

- criacao e aprovacao de campanhas;
- chat agentico com textos, prints e audios;
- workflow draft revisavel;
- envio programado em grupo via UAZAPI;
- extracao de participantes do grupo allowlistado;
- cadastro como `group_member_discovered`;
- envio oficial 1:1 apenas do template de opt-in via Kapso/Capsule + Meta;
- processamento de webhooks;
- consentimento, opt-out e bloqueios comerciais;
- filas, retries, idempotencia e auditoria.

## 2. Principios De QA

- Nenhuma campanha ativa sem aprovacao humana.
- Nenhum envio para grupo fora da allowlist.
- Nenhuma mensagem comercial 1:1 sem `opted_in`.
- Todo envio precisa de `SendAttempt`, `idempotency_key`, payload e status.
- Todo webhook precisa ser autenticado, persistido e processado de forma idempotente.
- Toda decisao critica precisa aparecer na timeline.
- Falha de compliance bloqueia execucao; falha transiente pode gerar retry limitado.
- Providers sao infraestrutura; a regra de negocio fica no backend.

## 3. Camadas De Teste

### 3.1 Unitarios

Foco: regras puras de dominio e application services.

- Risk engine:
  - bloqueia campanha nao aprovada;
  - bloqueia provider desconectado;
  - bloqueia grupo fora da allowlist;
  - bloqueia contato `opt_out`;
  - bloqueia template nao aprovado;
  - bloqueia mensagem comercial para `group_member_discovered`;
  - bloqueia tentativa duplicada com mesma `idempotency_key`.
- Consentimento:
  - transicoes validas entre `unknown`, `group_member_discovered`, `consent_request_candidate`, `opt_in_requested`, `opted_in`, `opt_out`, `expired` e `blocked`;
  - resposta positiva gera `opted_in`;
  - resposta negativa gera `opt_out`;
  - contato sem resposta nao recebe follow-up comercial.
- Idempotencia:
  - chave gerada com `campaign_id + enrollment_id/group_id + step_id + scheduled_at + message_version_id`;
  - mesma chave nao cria envio duplicado.
- Workflow compiler:
  - valida JSON canonico;
  - detecta horarios ambiguos;
  - preserva origem inferida por audio;
  - exige revisao quando houver conflito entre audio, print e texto.
- Template compiler:
  - renderiza variaveis;
  - bloqueia variavel ausente;
  - versiona mudanca relevante de texto.
- Normalizacao e dedupe:
  - normaliza telefone em E.164;
  - deduplica participantes extraidos;
  - cruza contato existente por telefone.

### 3.2 Integracao

Foco: adapters, banco, fila e contratos com providers.

- Prisma/Postgres:
  - cria campanha, versao, workflow, approvals, jobs, attempts, events e consents;
  - persiste payload bruto de webhooks;
  - garante unicidade de `idempotency_key`.
- BullMQ/Redis:
  - agenda job futuro;
  - cancela job futuro;
  - reprocessa falha transiente dentro do limite;
  - nao reprocessa bloqueio de compliance.
- UAZAPI adapter:
  - consulta `/status` (com fallback para `/instance/status` quando disponível);
  - lista grupos;
  - valida JID allowlistado;
  - consulta `/group/info`;
  - extrai participantes;
  - envia texto para grupo teste/allowlistado;
  - correlaciona `track_source` e `track_id` quando disponiveis.
- Kapso/Capsule adapter:
  - lista templates;
  - le status de template;
  - envia template de opt-in para numero teste;
  - registra `provider_message_id`;
  - trata erros oficiais como falha transiente, template rejeitado, billing/eligibility e janela 24h.
- Webhook ingestion:
  - valida assinatura/secret;
  - rejeita payload sem segredo valido;
  - salva payload bruto;
  - deduplica evento repetido;
  - atualiza `send_attempts`, `message_events` e `contact_consents`.

### 3.3 End-to-End

Foco: jornada completa com dados controlados.

1. Usuario cria campanha com texto/print.
2. Usuario envia audio de instrucao.
3. Sistema transcreve audio.
4. Usuario revisa transcricao.
5. Sistema gera workflow draft.
6. Usuario aprova workflow e campanha.
7. Sistema valida risk engine.
8. Sistema agenda mensagem no grupo allowlistado.
9. Worker envia mensagem no grupo via UAZAPI.
10. Sistema registra `SendAttempt` e timeline.
11. Sistema extrai participantes do grupo.
12. Sistema salva contatos como `group_member_discovered`.
13. Sistema deduplica contatos.
14. Sistema envia template oficial de opt-in via Kapso/Capsule.
15. Webhook de resposta positiva atualiza contato para `opted_in`.
16. Webhook de resposta negativa atualiza contato para `opt_out`.
17. Tentativa comercial para contato sem `opted_in` e bloqueada.
18. Dashboard mostra campanha, grupo, contatos, envios, falhas e consentimentos.

### 3.4 Contrato

Foco: impedir drift entre ports e adapters.

- `MessagingProvider` deve retornar sempre `SendResult` normalizado.
- `TemplateProvider` deve normalizar status do provider oficial.
- `GroupProvider` deve normalizar grupo, participantes e status da instancia.
- `SchedulerPort` deve expor enqueue, cancel e reschedule com erro padronizado.
- Webhooks de Kapso e UAZAPI devem produzir eventos internos consistentes, mesmo com payloads diferentes.

### 3.5 Exploratorios

Executar em staging antes de liberar producao:

- desconectar a instancia UAZAPI e confirmar pausa dos jobs;
- reenviar webhook duplicado e confirmar ausencia de duplicidade;
- simular template rejeitado e confirmar bloqueio;
- simular campanha pausada durante fila pendente;
- simular audio com baixa confianca;
- simular conflito entre audio e print;
- simular grupo admin-only e confirmar permissao de envio;
- simular participante sem telefone valido;
- simular resposta negativa com variacoes como "NAO", "nao quero", "parar" e "remover".

## 4. Smoke Tests Do MVP

Rodar a cada deploy em staging e antes de producao.

### 4.1 Smoke De Infra

- Backend sobe e responde healthcheck.
- Frontend carrega dashboard.
- Postgres aceita leitura/escrita.
- Redis/BullMQ aceita enqueue e processamento.
- Secrets obrigatorios existem por ambiente.
- Kill switch global e por canal sao lidos pelo backend.
- Tokens nao aparecem no frontend, logs ou respostas de API.

### 4.2 Smoke De UAZAPI Grupo

- Status da instancia retorna `connected`.
- Grupo allowlistado `120363409578992998@g.us` aparece como ativo.
- Instancia autorizada aparece como admin do grupo.
- Grupo fora da allowlist e bloqueado.
- Job de mensagem em grupo e criado, executado e registrado.
- Desconexao bloqueia novo envio e pausa jobs pendentes do canal.

### 4.3 Smoke De Kapso/Capsule Oficial

- Templates podem ser listados.
- Template de opt-in aprovado aparece como utilizavel.
- Envio do template de opt-in para contato teste retorna `provider_message_id`.
- Webhook de sent/delivered/read atualiza timeline.
- Webhook de resposta positiva gera `opted_in`.
- Webhook de resposta negativa gera `opt_out`.

### 4.4 Smoke De Campanha

- Workflow draft nasce em estado nao executavel.
- Aprovacao humana muda estado para executavel.
- Campanha aprovada agenda jobs.
- Campanha pausada nao executa jobs futuros.
- Timeline exibe approvals, jobs, attempts, webhooks e falhas.

### 4.5 Smoke De Chat Agentico

- Upload de imagem cria `MediaAsset`.
- Upload de audio cria estado `uploaded`.
- Audio passa por `transcribing`, `transcribed` e `needs_review`.
- Transcricao revisada pode gerar workflow draft.
- Audio com baixa confianca exige revisao.
- Workflow inferido por audio fica marcado como tal.

## 5. Testes De Risco E Compliance

### 5.1 Consentimento

- Participante extraido nunca vira `opted_in` automaticamente.
- Participante extraido entra como `group_member_discovered`.
- Primeiro envio 1:1 permitido e apenas template oficial de opt-in.
- Contato `opt_in_requested` nao recebe mensagem comercial.
- Contato `expired` nao recebe follow-up automatico.
- Contato `opt_out` nao recebe novas mensagens.
- Prova de consentimento guarda telefone, origem, grupo, template, horario, resposta/clique, provider message id e payload.

### 5.2 Conteudo E Template

- Template de opt-in e curto, claro e orientado a autorizacao.
- Template de opt-in permite resposta negativa.
- Template de opt-in nao contem oferta comercial completa.
- Mudanca relevante cria nova versao.
- Template pendente ou rejeitado bloqueia campanha.
- Template comercial para contato sem opt-in e bloqueado pelo risk engine.

### 5.3 Canal De Grupo

- Somente grupo allowlistado pode receber mensagem.
- Worker nao usa `admintoken` da UAZAPI.
- Falhas consecutivas pausam o canal.
- Instancia `disconnected` bloqueia envio e exige reconexao manual/assistida.
- Envio concorrente em massa no grupo e bloqueado.

### 5.4 Seguranca

- Webhooks exigem assinatura ou segredo.
- Segredos ficam em env/secret manager.
- Logs mascaram tokens, telefones quando aplicavel e payloads sensiveis.
- RBAC impede operador de executar acao reservada a owner/admin.
- Kill switch global bloqueia todos os envios.
- Kill switch por canal bloqueia apenas o canal correspondente.

## 6. Webhooks

### 6.1 Kapso/Capsule

Cenarios obrigatorios:

- `whatsapp.message.sent` atualiza attempt para enviado.
- `whatsapp.message.delivered` registra entrega.
- `whatsapp.message.read` registra leitura.
- `whatsapp.message.failed` registra falha e motivo.
- `whatsapp.message.received` resolve resposta do contato.
- Evento duplicado nao duplica `MessageEvent`.
- Evento fora de ordem nao regride status final.
- Payload sem assinatura/secret valido e rejeitado.
- Payload valido, mas nao correlacionado, fica salvo como evento pendente de analise.

### 6.2 UAZAPI

Cenarios obrigatorios:

- `connection` com desconexao pausa jobs pendentes do canal `uazapi_group`.
- `messages` correlaciona envio por `track_source` e `track_id`.
- `messages_update` atualiza status quando disponivel.
- `groups` atualiza metadados do grupo allowlistado.
- `sender` com falha aciona alerta e registra motivo.
- Evento duplicado nao duplica timeline.
- Webhook por instancia deve estar configurado para `connection`, `messages`, `messages_update`, `groups` e `sender`.

## 7. Fila, Retries E Idempotencia

### 7.1 Regras Gerais

- Todo job deve referenciar campanha, step, target, canal e `idempotency_key`.
- Worker verifica risk engine imediatamente antes do provider.
- Worker verifica se ja existe envio bem-sucedido com a mesma chave.
- Job cancelado ou campanha pausada nao executa.
- Retry so ocorre para falha transiente.
- Falhas de compliance, opt-out, template rejeitado, billing/eligibility e grupo nao allowlistado nao geram retry automatico.

### 7.2 Cenarios Obrigatorios

- Dois jobs com mesma `idempotency_key`: apenas um envio real.
- Worker cai apos enviar, antes de salvar status: reprocessamento consulta attempt/provider antes de reenviar.
- Webhook chega antes da resposta do endpoint de envio: status final permanece consistente.
- Job agendado e campanha pausada antes da execucao: job nao envia.
- Provider temporariamente indisponivel: retry limitado e backoff.
- UAZAPI desconecta no meio da execucao: canal pausa e jobs futuros ficam bloqueados.
- Kapso retorna erro de billing/eligibility: campanha/canal oficial bloqueia e alerta.

## 8. Matriz De Cenarios Criticos

| ID | Area | Cenario | Resultado Esperado | Prioridade |
| --- | --- | --- | --- | --- |
| C01 | Approval | Campanha draft tenta agendar envio | Bloqueio por falta de aprovacao | P0 |
| C02 | Approval | Usuario aprova campanha valida | Jobs sao criados e auditados | P0 |
| C03 | Grupo | Envio para grupo allowlistado conectado | Mensagem enviada e timeline atualizada | P0 |
| C04 | Grupo | Envio para grupo nao allowlistado | Bloqueio antes do provider | P0 |
| C05 | Grupo | Instancia UAZAPI desconectada | Jobs pausados e alerta gerado | P0 |
| C06 | Grupo | Worker tenta usar credencial administrativa | Teste falha; worker deve usar token da instancia | P0 |
| C07 | Extracao | Participantes extraidos do grupo | Contatos salvos como `group_member_discovered` | P0 |
| C08 | Extracao | Telefones duplicados | Um contato canonico em E.164 | P0 |
| C09 | Consentimento | `group_member_discovered` recebe template de opt-in | Permitido e registrado | P0 |
| C10 | Consentimento | `group_member_discovered` recebe template comercial | Bloqueio pelo risk engine | P0 |
| C11 | Consentimento | Resposta "SIM" ao opt-in | Status vira `opted_in` com prova | P0 |
| C12 | Consentimento | Resposta "NAO" ou opt-out | Status vira `opt_out` e bloqueia envios | P0 |
| C13 | Consentimento | Sem resposta ao opt-in | Sem retry comercial automatico | P0 |
| C14 | Template | Template oficial pendente | Campanha oficial nao executa | P0 |
| C15 | Template | Template rejeitado | Campanha bloqueada e alerta exibido | P0 |
| C16 | Webhook | Webhook com segredo invalido | Rejeitado e nao processado | P0 |
| C17 | Webhook | Webhook duplicado | Persistencia/processamento idempotente | P0 |
| C18 | Webhook | Webhook fora de ordem | Status final nao regride | P1 |
| C19 | Fila | Job duplicado com mesma chave | Um unico envio real | P0 |
| C20 | Fila | Campanha pausada antes do horario | Job nao envia | P0 |
| C21 | Chat | Audio transcrito com baixa confianca | Exige revisao humana | P1 |
| C22 | Chat | Audio contradiz print/texto | Conflito destacado antes da aprovacao | P1 |
| C23 | Chat | Workflow inferido por audio | Etapas marcadas com origem de audio | P1 |
| C24 | Dashboard | Falha de provider | Falha, motivo e attempt aparecem na timeline | P1 |
| C25 | Seguranca | Kill switch global ativo | Nenhum canal envia | P0 |
| C26 | Seguranca | Kill switch UAZAPI ativo | Apenas grupo fica bloqueado | P0 |
| C27 | Seguranca | Token aparece em log/resposta | Teste falha; deploy bloqueado | P0 |
| C28 | Observabilidade | Provider unhealthy | Alerta e status visivel no dashboard | P1 |

## 9. Dados De Teste

Usar dados controlados e segregados por ambiente.

- Campanha teste: `qa_mvp_campaign`.
- Grupo teste/allowlistado: `+4x lead, -68% de custo comercial`.
- JID allowlistado: `120363409578992998@g.us`.
- Contato teste positivo: numero interno autorizado para responder `SIM`.
- Contato teste negativo: numero interno autorizado para responder `NAO`.
- Template opt-in teste: aprovado no provider oficial antes do smoke.
- Audio teste:
  - instrucao clara com horario;
  - audio com baixa confianca;
  - audio contraditorio com texto.

Nao usar contatos reais para testes exploratorios de opt-in sem aprovacao explicita.

## 10. Criterios Para Liberar Staging

Staging pode ser liberado quando:

- migrations aplicam limpas em banco novo;
- unitarios de dominio e risk engine passam;
- integracao com Postgres, Redis/BullMQ e Prisma passa;
- adapters de UAZAPI e Kapso funcionam com credenciais de staging/teste;
- webhooks publicos de staging validam assinatura/secret;
- smoke de infra, campanha, grupo, oficial e chat passa;
- dashboard exibe timeline de attempts, webhooks e consentimentos;
- kill switches foram testados;
- tokens nao aparecem em frontend, logs ou respostas;
- matriz P0 esta 100% verde ou com excecao documentada e aprovada pelo owner.

## 11. Criterios Para Liberar Producao

Producao pode ser liberada quando:

- todos os criterios de staging estao cumpridos;
- teste controlado no grupo allowlistado foi executado com sucesso;
- webhook da UAZAPI esta expandido para `connection`, `messages`, `messages_update`, `groups` e `sender`;
- template oficial de opt-in esta aprovado;
- envio de opt-in para contato teste registrou provider message id e prova;
- resposta positiva atualizou `opted_in`;
- resposta negativa atualizou `opt_out`;
- tentativa comercial sem opt-in foi bloqueada em teste real/controlado;
- desconexao da UAZAPI pausa jobs pendentes;
- idempotencia foi validada com job e webhook duplicados;
- alertas minimos estao ativos para provider unhealthy, desconexao, template rejeitado, billing/eligibility e falhas repetidas;
- plano de rollback esta definido;
- kill switch global e por canal foram testados em producao sem envio real indevido;
- aprovador humano revisou campanha, template e janela de envio.

## 12. Go / No-Go

### Go

- P0 da matriz critica 100% aprovado.
- Nenhum vazamento de segredo.
- Nenhum envio comercial sem opt-in.
- Nenhum envio para grupo fora da allowlist.
- Webhooks autenticados e idempotentes.
- Fila sem duplicidade de envio.
- Timeline auditavel ponta a ponta.

### No-Go

- Qualquer falha de consentimento.
- Qualquer envio duplicado real causado por retry/idempotencia.
- Qualquer token exposto em log, frontend ou payload publico.
- Webhook sem validacao de segredo.
- UAZAPI usando `admintoken` no worker.
- Grupo allowlistado nao validado.
- Template de opt-in pendente, rejeitado ou com texto comercial agressivo.
- Dashboard sem visibilidade de falhas, consentimentos ou attempts.

## 13. Cadencia De QA

- A cada PR: unitarios, contrato dos ports afetados e revisao de risco.
- A cada merge para staging: smoke completo e matriz P0.
- Antes de campanha real: smoke de provider, allowlist, template, opt-in e kill switch.
- Semanalmente durante MVP: replay de webhooks duplicados, teste de desconexao UAZAPI e auditoria de consentimentos.
- Apos incidente: criar teste regressivo antes de reabilitar o canal afetado.
