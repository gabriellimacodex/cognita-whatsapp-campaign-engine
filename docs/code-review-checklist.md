# Code Review Checklist - WhatsApp Campaign Engine

Use este checklist antes de aprovar PRs que alterem backend, workers, adapters, filas,
webhooks, banco, frontend operacional ou deploy. O objetivo da revisao e impedir
envios indevidos, vazamento de dados, perda de auditoria e acoplamento fragil com
providers.

## 1. Arquitetura Hexagonal

- [ ] Regras de negocio ficam no dominio ou application layer, nao em controllers,
      adapters, filas ou componentes de UI.
- [ ] Providers sao tratados como executores de infraestrutura; o backend decide quem
      pode receber, quando, por qual canal, com qual template e com qual consentimento.
- [ ] Casos de uso dependem de ports/interfaces, nao diretamente de Kapso/Capsule,
      UAZAPI, Prisma, BullMQ, Redis, HTTP clients ou SDKs externos.
- [ ] Adapters implementam contratos pequenos e testaveis, com DTOs traduzidos para
      tipos do dominio/application layer.
- [ ] Alteracoes em provider nao vazam nomenclatura externa para entidades centrais,
      workflow canonico ou frontend.
- [ ] O workflow canonico em JSON continua sendo a fonte de verdade; canvas ou UI sao
      apenas representacoes.
- [ ] O agente/chat so gera draft, sugestoes ou payloads revisaveis; nenhuma acao
      irreversivel ocorre sem aprovacao humana persistida.
- [ ] Mudancas de texto, template ou workflow aprovado criam nova versao rastreavel.

## 2. Seguranca E Secrets

- [ ] Nenhum token, API key, webhook secret, bearer token, session token ou admintoken
      aparece no codigo, migrations, fixtures, logs, screenshots ou payloads enviados
      ao frontend.
- [ ] Secrets sao lidos de env/secret manager por ambiente e possuem nomes especificos
      por provider/canal.
- [ ] Credenciais Kapso/Capsule e UAZAPI sao separadas; comprometer uma nao concede
      acesso a outra.
- [ ] O worker de envio UAZAPI usa apenas token da instancia autorizada, nunca
      `admintoken`.
- [ ] Qualquer chave Kapso/Capsule previamente exposta foi rotacionada antes de staging
      ou producao.
- [ ] Logs e spans mascaram telefones quando apropriado e sempre mascaram tokens,
      headers sensiveis e payloads de autenticacao.
- [ ] Controllers validam autenticacao, RBAC e ownership antes de ler ou alterar
      campanhas, grupos, templates, contatos, consentimentos e jobs.
- [ ] Webhooks validam assinatura ou segredo antes de persistir efeitos de negocio.
- [ ] Uploads de audio/imagem validam tamanho, tipo, extensao, storage path e acesso.
- [ ] Kill switch global e por canal sao checados antes de enfileirar e antes de enviar.

## 3. Providers E Adapters

- [ ] `KapsoOfficialProvider`, `KapsoTemplateProvider` e `UazapiGroupProvider` nao
      contem regra de consentimento, aprovacao ou segmentacao.
- [ ] Health checks de provider sao consultados ou considerados antes de criar envio.
- [ ] Falhas de provider sao normalizadas em codigos internos estaveis.
- [ ] Erros de compliance, opt-out, template rejeitado, billing ou elegibilidade nao
      geram retry automatico.
- [ ] Erro oficial tipo janela de 24h fechada bloqueia mensagem livre e exige template
      aprovado.
- [ ] Erro oficial de billing/elegibilidade bloqueia campanha/canal e gera alerta.
- [ ] UAZAPI `disconnected` bloqueia envio e pausa jobs pendentes do canal; nao e
      tratado como retry imediato.
- [ ] UAZAPI so envia para grupos allowlistados por JID canonico `@g.us`.
- [ ] Descoberta automatica de novos grupos nao habilita envio; novos grupos exigem
      cadastro/allowlist explicito.
- [ ] Payloads UAZAPI usam `track_source` e `track_id` quando disponivel para
      correlacionar eventos com `send_attempts`.
- [ ] Logs de envios oficiais e envios de grupo ficam distinguiveis por canal/provider.

## 4. Consentimento E Compliance

- [ ] Participante extraido de grupo entra como `group_member_discovered`, nunca como
      `opted_in`.
- [ ] Contato `group_member_discovered` so pode receber o template oficial inicial de
      solicitacao de opt-in.
- [ ] Contato `opt_in_requested` ou pendente nao entra em sequencias comerciais.
- [ ] Sem retry automatico da solicitacao inicial de opt-in para quem nao respondeu.
- [ ] Respostas negativas, termos de descadastro ou bloqueios viram `opt_out`.
- [ ] Resposta afirmativa ou clique rastreado so vira `opted_in` com prova persistida.
- [ ] Prova de consentimento guarda telefone E.164, origem, grupo de origem, template,
      texto renderizado, horario do pedido, resposta/clique, horario da confirmacao e
      provider message id.
- [ ] Opt-out tem precedencia sobre qualquer campanha, template, fila ou janela de
      atendimento.
- [ ] Normalizacao e dedupe por telefone ocorrem antes de criar contato, consentimento
      ou enrollment.
- [ ] Mudancas no modelo de consentimento preservam historico/auditoria.

## 5. Idempotencia E Concorrencia

- [ ] Cada envio possui idempotency key baseada em campanha, enrollment/grupo, step,
      horario agendado e versao da mensagem/template.
- [ ] O executor verifica envio bem-sucedido com a mesma idempotency key antes de chamar
      o provider.
- [ ] Criacao de `SendAttempt` e transicao para estado de envio sao atomicas ou
      protegidas contra corrida.
- [ ] Webhooks duplicados nao duplicam eventos finais, tentativas, consentimentos ou
      timelines.
- [ ] Reprocessamento de jobs preserva a mesma idempotency key.
- [ ] Locks, constraints ou transacoes impedem envio concorrente em massa no canal de
      grupo.
- [ ] Cancelamento, pausa e reagendamento nao deixam jobs orfaos ou executaveis.
- [ ] Retries sao limitados, com backoff e classificacao de erro transiente versus
      bloqueante.

## 6. Filas, Scheduler E Workers

- [ ] Jobs gravam estado em `scheduled_jobs` e `send_attempts` antes e depois da
      execucao.
- [ ] Workers revalidam campanha aprovada, canal ativo, provider health, consentimento,
      opt-out, template aprovado, allowlist e kill switch imediatamente antes do envio.
- [ ] Jobs futuros podem ser pausados, cancelados e reagendados sem perder auditoria.
- [ ] Falhas consecutivas em UAZAPI pausam o canal/grupo e acionam alerta.
- [ ] Dead-letter/retry exhausted fica visivel no dashboard ou em alerta operacional.
- [ ] Timezone `America/Sao_Paulo` e timestamps com offset/UTC sao tratados de forma
      explicita.
- [ ] Agendamentos no passado, horarios ambiguos ou campanhas sem aprovacao caem em
      `needs_manual_review` ou bloqueio.
- [ ] Worker nao depende de SSE, browser session ou estado em memoria para producao.

## 7. Webhooks

- [ ] Webhooks persistem payload bruto em `webhook_events` antes de aplicar efeitos de
      negocio.
- [ ] Processamento de webhook e idempotente por event id, provider message id, wamid,
      `track_id` ou chave equivalente.
- [ ] Kapso/Capsule valida assinatura/secret e resolve campanha/tentativa por metadata,
      callback data ou provider message id.
- [ ] UAZAPI usa webhook por instancia, nao apenas webhook global administrativo.
- [ ] UAZAPI cobre eventos esperados: `connection`, `messages`, `messages_update`,
      `groups` e `sender`.
- [ ] Evento de desconexao UAZAPI pausa jobs pendentes de `uazapi_group`.
- [ ] Eventos de falha atualizam `send_attempts`, timeline e alertas.
- [ ] Eventos de resposta/clique atualizam consentimento somente quando passam pelas
      regras de prova e dedupe.
- [ ] Payloads invalidos, sem assinatura ou sem correlacao ficam auditaveis e nao
      quebram o worker.

## 8. Banco, Prisma E Dados

- [ ] Migrations criam constraints/indices para idempotency key, provider message id,
      telefone E.164, consentimento atual e relacionamentos criticos.
- [ ] Tabelas de auditoria (`approvals`, `webhook_events`, `message_events`,
      `send_attempts`) nao perdem payloads necessarios para investigacao.
- [ ] Campos sensiveis nao sao salvos quando devem ficar apenas em secret manager.
- [ ] Payloads JSON de request/response sao sanitizados antes de persistir.
- [ ] Deletes destrutivos sao evitados para entidades auditaveis; preferir status,
      soft delete ou historico.
- [ ] Alteracoes de schema incluem plano de migracao para dados existentes.
- [ ] Consultas de dashboard possuem indices compatveis com filtros por campanha,
      contato, grupo, canal, status e periodo.

## 9. Frontend Operacional

- [ ] UI nunca recebe tokens, secrets ou headers de provider.
- [ ] Approval Console diferencia claramente draft, reviewed, submitted, approved,
      scheduled, running, paused, failed e completed.
- [ ] Acoes irreversiveis exigem confirmacao e mostram impacto: canal, grupo/contatos,
      template, horario e versao.
- [ ] Tela de grupo mostra status da instancia UAZAPI antes de permitir agendamento.
- [ ] Frontend bloqueia acoes invalidas, mas backend tambem revalida tudo.
- [ ] Timeline mostra eventos por campanha, grupo, contato, envio, webhook e falha.
- [ ] Estados de consentimento aparecem de forma explicita e nao sugerem opt-in para
      contatos apenas descobertos.
- [ ] Transcricoes de audio sao revisaveis; conteudo inferido de audio fica marcado.
- [ ] Ambiguidades de horario, canal, texto ou conflito entre audio/print/texto exigem
      revisao humana.
- [ ] Dashboard mostra falhas de provider, templates pendentes/rejeitados, opt-in,
      opt-out, desconexao UAZAPI e jobs pausados.

## 10. Observabilidade E Auditoria

- [ ] Logs possuem correlation id para campanha, workflow step, scheduled job,
      send attempt, provider message id e webhook event.
- [ ] Metricas cobrem scheduled, sent, delivered, read, failed, reply, opt-in, opt-out,
      provider failure rate, disconnect count e tempo de aprovacao de template.
- [ ] Alertas existem para provider unhealthy, numero desconectado, template rejeitado,
      billing/elegibilidade, falha repetida em grupo, webhook sem entrega recente e
      campanha agendada com template pendente.
- [ ] Cada aprovacao registra usuario, papel, data/hora, objeto aprovado, versao e
      snapshot relevante.
- [ ] Cada bloqueio do risk engine registra motivo acionavel para auditoria e suporte.
- [ ] Erros de worker e webhook sao rastreaveis sem expor dados sensiveis.
- [ ] SSE e realtime sao usados para visualizacao, nao como mecanismo de consistencia.

## 11. Deploy E Readiness

- [ ] Ambientes dev, staging e producao usam secrets, bancos, Redis, filas e webhook
      URLs separados.
- [ ] URL publica de webhook de staging/producao esta configurada e testada para cada
      provider.
- [ ] Migrations rodam antes de workers processarem jobs que dependem do novo schema.
- [ ] Deploy de backend/workers inclui estrategia para drenar, pausar ou retomar filas.
- [ ] Kill switches podem ser acionados sem novo deploy.
- [ ] Health checks cobrem API, banco, Redis/BullMQ, workers e providers.
- [ ] Rollback nao reexecuta envios ja concluidos por causa da idempotencia.
- [ ] Feature flags protegem funcionalidades de alto risco, como envio em grupo,
      submissao de template e execucao oficial 1:1.
- [ ] Backups e retencao cobrem Postgres, payloads de auditoria e assets/provas em
      storage.

## 12. Testes Obrigatorios Para PRs De Risco

- [ ] Unit tests para risk engine, idempotency key, workflow parser, template compiler,
      renderizacao de variaveis e transicoes de consentimento.
- [ ] Integration tests para adapters Kapso/Capsule e UAZAPI usando mocks contratuais ou
      ambiente controlado.
- [ ] Tests de webhook para assinatura invalida, payload duplicado, evento fora de
      ordem, evento sem correlacao e resposta de opt-in/opt-out.
- [ ] Tests de fila para retry transiente, erro bloqueante, pausa, cancelamento,
      reagendamento e dead-letter.
- [ ] E2E minimo cobre draft -> aprovacao -> agendamento -> envio -> webhook -> timeline.
- [ ] Tests negativos confirmam bloqueio para campanha sem aprovacao, template pendente,
      provider desconectado, grupo nao allowlistado, opt-out e contato sem opt-in.
- [ ] Testes de frontend cobrem estados vazios, loading, erro, permissao insuficiente,
      acao bloqueada e confirmacao de aprovacao/pausa.

## 13. Perguntas De Revisao Antes De Aprovar

- [ ] Este PR aumenta a chance de enviar mensagem para alguem sem consentimento?
- [ ] Este PR permite algum caminho de envio sem aprovacao humana persistida?
- [ ] Este PR usa algum token administrativo onde bastaria token de instancia/canal?
- [ ] Este PR torna retry, webhook ou reprocessamento capaz de duplicar envio?
- [ ] Este PR acopla regra de negocio a Kapso/Capsule, UAZAPI, BullMQ, Prisma ou UI?
- [ ] Este PR remove ou enfraquece prova de consentimento, auditoria ou timeline?
- [ ] Este PR melhora ou preserva a capacidade de pausar tudo rapidamente em producao?

