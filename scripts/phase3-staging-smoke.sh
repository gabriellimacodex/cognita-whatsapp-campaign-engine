#!/usr/bin/env bash

set -euo pipefail

API_BASE="${API_BASE:-http://localhost:3001}"
ACCOUNT_ID="${ACCOUNT_ID:-${1:-}}"
GROUP_JID="${GROUP_JID:-${2:-}}"
START_AT="${START_AT:-}"
LOG_PREFIX="[phase3-smoke]"

if [[ -z "${ACCOUNT_ID}" ]]; then
  echo "${LOG_PREFIX} ERROR: ACCOUNT_ID is required."
  echo "Usage:"
  echo "  API_BASE=http://localhost:3001 ./scripts/phase3-staging-smoke.sh accounts/default"
  echo "  or"
  echo "  ACCOUNT_ID=accounts/default ./scripts/phase3-staging-smoke.sh"
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "${LOG_PREFIX} ERROR: curl é obrigatório."
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "${LOG_PREFIX} WARNING: jq não encontrado. Validações estruturadas ficarão limitadas."
  HAVE_JQ=0
else
  HAVE_JQ=1
fi

TMP_DIR="${TMPDIR:-/tmp}/cognita_phase3_smoke_$(date +%Y%m%d_%H%M%S)"
mkdir -p "${TMP_DIR}"
HTTP_BODY_FILE="${TMP_DIR}/http-body.json"
HTTP_STATUS=""

log() {
  echo "${LOG_PREFIX} $(date --iso-8601=seconds) - $*"
}

http() {
  local method="$1"
  local path="$2"
  local body="${3:-}"
  local status=""

  if [[ -n "${body}" ]]; then
    status=$(
      curl -sS -o "${HTTP_BODY_FILE}" -w "%{http_code}" \
        -X "${method}" "${API_BASE%/}${path}" \
        -H "Content-Type: application/json" \
        --data "${body}"
    )
  else
    status=$(
      curl -sS -o "${HTTP_BODY_FILE}" -w "%{http_code}" \
        -X "${method}" "${API_BASE%/}${path}" \
        -H "Content-Type: application/json"
    )
  fi

  HTTP_STATUS="${status}"
  if [[ ! -f "${HTTP_BODY_FILE}" ]]; then
    printf "%s" ""
    return
  fi

  cat "${HTTP_BODY_FILE}"
}

assert_http_success() {
  local endpoint="$1"
  local status="$2"
  if [[ "${status}" -lt 200 || "${status}" -ge 300 ]]; then
    echo "${LOG_PREFIX} ERROR: ${endpoint} retornou HTTP ${status}"
    echo "Body: $(cat "${HTTP_BODY_FILE}")"
    exit 1
  fi
}

require_json() {
  local file="$1"
  local json="${2:-}"
  if [[ "${HAVE_JQ}" == "1" ]]; then
    if ! jq -e . >/dev/null 2>&1 <<<"${json}"; then
      echo "${LOG_PREFIX} ERROR: JSON inválido em ${file}"
      echo "${json}"
      exit 1
    fi
  fi
}

ensure_array() {
  local json="$1"
  local title="$2"
  if [[ "${HAVE_JQ}" == "0" ]]; then
    return 0
  fi
  if ! jq -e 'type=="array"' <<<"${json}" >/dev/null 2>&1; then
    echo "${LOG_PREFIX} ERROR: ${title} não retornou array."
    echo "${json}"
    exit 1
  fi
}

write_json() {
  local payload="$1"
  local file="$2"
  printf "%s\n" "${payload}" > "${file}"
  if [[ "${HAVE_JQ}" == "1" ]]; then
    jq . "${file}" > "${file}.pretty"
    mv "${file}.pretty" "${file}"
  fi
}

isolate_candidate_id() {
  local campaign_list="$1"
  jq -r '.[] | select(.status|IN("templates_approved","scheduled","running","paused","completed")) | .id' <<<"${campaign_list}" | head -n 1 || true
}

build_schedule_payload() {
  local campaign_id="$1"
  local payload="{\"campaignId\":\"${campaign_id}\",\"accountId\":\"${ACCOUNT_ID}\""
  if [[ -n "${START_AT}" ]]; then
    payload="${payload},\"startAt\":\"${START_AT}\""
  fi
  if [[ -n "${GROUP_JID}" ]]; then
    payload="${payload},\"groupJid\":\"${GROUP_JID}\""
  fi
  payload="${payload}}"
  printf "%s" "${payload}"
}

now_plus_two_minutes_iso() {
  if command -v date >/dev/null 2>&1 && date -v +2M +"%Y-%m-%dT%H:%M:%S.000Z" >/dev/null 2>&1; then
    date -v +2M +"%Y-%m-%dT%H:%M:%S.000Z"
  elif command -v node >/dev/null 2>&1; then
    node -e "const d = new Date(Date.now() + 120000); process.stdout.write(d.toISOString())"
  else
    python3 - <<'PY'
from datetime import datetime, timedelta
import sys
sys.stdout.write((datetime.utcnow() + timedelta(minutes=2)).replace(microsecond=0).isoformat() + ".000Z")
PY
  fi
}

log "======== FASE 3 — STAGING SMOKE ========"
log "API_BASE=${API_BASE}"
log "ACCOUNT_ID=${ACCOUNT_ID}"
log "GROUP_JID=${GROUP_JID:-<padrão allowlist>}"

HEALTH_RESPONSE=$(http GET "/health")
assert_http_success "/health" "${HTTP_STATUS}"
write_json "${HEALTH_RESPONSE}" "${TMP_DIR}/01-health.json"
require_json "01-health.json" "${HEALTH_RESPONSE}"
if [[ "${HAVE_JQ}" == "1" ]]; then
  log "Saúde da API: $(jq -r '.status // \"unknown\"' < "${TMP_DIR}/01-health.json")"
else
  log "Saúde da API (bruta): $(cat "${TMP_DIR}/01-health.json")"
fi

CAMPAIGNS_RESPONSE=$(http GET "/campaigns?limit=200")
assert_http_success "/campaigns?limit=200" "${HTTP_STATUS}"
write_json "${CAMPAIGNS_RESPONSE}" "${TMP_DIR}/02-campaigns-before.json"
require_json "02-campaigns-before.json" "${CAMPAIGNS_RESPONSE}"

if [[ "${HAVE_JQ}" == "1" ]]; then
  ensure_array "${CAMPAIGNS_RESPONSE}" "GET /campaigns"
  CANDIDATE_ID="$(isolate_candidate_id "${CAMPAIGNS_RESPONSE}")"
else
  CANDIDATE_ID=""
fi

if [[ -z "${CANDIDATE_ID}" ]]; then
  log "Nenhuma campanha elegível para agendamento encontrada."
  log "Vou criar uma campanha em draft para validar o fluxo da API."

  cat > "${TMP_DIR}/workflow.json" <<'JSON'
{
  "version": "1.0",
  "timezone": "America/Sao_Paulo",
  "campaignId": "phase3-smoke",
  "entry": "start",
  "nodes": [
    { "id": "start", "type": "start" },
    {
      "id": "m1",
      "type": "send_group_message",
      "channel": "uazapi_group",
      "messageKey": "Mensagem automática de smoke test",
      "source": "manual"
    },
    { "id": "end", "type": "stop" }
  ],
  "edges": [
    { "from": "start", "to": "m1" },
    { "from": "m1", "to": "end" }
  ]
}
JSON

  CREATE_PAYLOAD="$(cat <<JSON
{
  "name": "Smoke Test Campaign",
  "timezone": "America/Sao_Paulo",
  "workflow": $(cat "${TMP_DIR}/workflow.json")
}
JSON
)"

  CREATE_RESPONSE=$(http POST "/campaigns" "${CREATE_PAYLOAD}")
  assert_http_success "/campaigns" "${HTTP_STATUS}"
  write_json "${CREATE_RESPONSE}" "${TMP_DIR}/03-campaign-create.json"
  if [[ "${HAVE_JQ}" == "1" ]]; then
    CANDIDATE_ID=$(jq -r '.campaignId // empty' < "${TMP_DIR}/03-campaign-create.json")
    CREATED_STATUS=$(jq -r '.status // empty' < "${TMP_DIR}/03-campaign-create.json")
    if [[ "${CREATED_STATUS}" != "templates_approved" ]]; then
      log "Campanha criada em status '${CREATED_STATUS}'."
      log "Ações necessárias para seguir:"
      log "  - Promova campanha para 'templates_approved' no DB ou por fluxo de aprovação."
      log "  - Em seguida, reexecute o script com o mesmo ACCOUNT_ID."
      log "  - Exemplo (PostgreSQL): update \"Campaign\" set status='templates_approved' where id='${CANDIDATE_ID}';"
      log "Arquivo de saída para auditoria: 03-campaign-create.json"
      exit 1
    fi
    log "Campanha criada em status pronto para schedule: ${CANDIDATE_ID}"
  else
    log "Campanha criada. Ajuste manualmente para status 'templates_approved' antes de agendar."
  fi
fi

if [[ -z "${CANDIDATE_ID}" ]]; then
  log "Não foi possível obter uma campanha para continuar."
  log "Ação necessária:"
  log "  - Crie/atualize uma campanha com status 'templates_approved'."
  log "  - Em DB (se necessário): update \"Campaign\" set status='templates_approved' where id='<ID>'; "
  exit 1
fi

log "Campanha alvo selecionada: ${CANDIDATE_ID}"

SCHEDULE_PAYLOAD=$(build_schedule_payload "${CANDIDATE_ID}")
SCHEDULE_RESPONSE=$(http POST "/campaigns/schedule" "${SCHEDULE_PAYLOAD}")
assert_http_success "/campaigns/schedule" "${HTTP_STATUS}"
write_json "${SCHEDULE_RESPONSE}" "${TMP_DIR}/04-campaign-schedule.json"
require_json "04-campaign-schedule.json" "${SCHEDULE_RESPONSE}"

if [[ "${HAVE_JQ}" == "1" ]]; then
  if jq -e '.campaignId' "${TMP_DIR}/04-campaign-schedule.json" >/dev/null 2>&1; then
    log "Agendamento criado para campanha: $(jq -r '.campaignId // empty' "${TMP_DIR}/04-campaign-schedule.json")"
  fi
  JOB_ID=$(jq -r '.jobs[0].scheduledJobId // .jobs[0].id // empty' "${TMP_DIR}/04-campaign-schedule.json")
else
  JOB_ID=""
fi

SCHEDULE_LIST_RESPONSE=$(http GET "/campaigns/${CANDIDATE_ID}/schedule")
assert_http_success "/campaigns/${CANDIDATE_ID}/schedule" "${HTTP_STATUS}"
write_json "${SCHEDULE_LIST_RESPONSE}" "${TMP_DIR}/05-campaign-jobs.json"
require_json "05-campaign-jobs.json" "${SCHEDULE_LIST_RESPONSE}"

if [[ -z "${JOB_ID}" && "${HAVE_JQ}" == "1" ]]; then
  JOB_ID=$(jq -r '.jobs[0].id // empty' "${TMP_DIR}/05-campaign-jobs.json")
fi

if [[ -n "${JOB_ID}" ]]; then
  log "Job localizado: ${JOB_ID}"
else
  log "Atenção: campanha sem jobs no retorno do momento."
  log "Valide agendamento no banco e na fila."
fi

PAUSE_RESPONSE=$(http POST "/campaigns/${CANDIDATE_ID}/pause")
assert_http_success "/campaigns/${CANDIDATE_ID}/pause" "${HTTP_STATUS}"
write_json "${PAUSE_RESPONSE}" "${TMP_DIR}/06-campaign-pause.json"

RESUME_RESPONSE=$(http POST "/campaigns/${CANDIDATE_ID}/resume")
assert_http_success "/campaigns/${CANDIDATE_ID}/resume" "${HTTP_STATUS}"
write_json "${RESUME_RESPONSE}" "${TMP_DIR}/07-campaign-resume.json"

if [[ -n "${JOB_ID}" ]]; then
  NOW=$(now_plus_two_minutes_iso)
  RESCHEDULE_PAYLOAD="$(cat <<JSON
{"runAt":"${NOW}"}
JSON
)"

  RESCHEDULE_RESPONSE=$(http POST "/campaigns/jobs/${JOB_ID}/reschedule" "${RESCHEDULE_PAYLOAD}")
  assert_http_success "/campaigns/jobs/${JOB_ID}/reschedule" "${HTTP_STATUS}"
  write_json "${RESCHEDULE_RESPONSE}" "${TMP_DIR}/08-job-reschedule.json"

  CANCEL_JOB_RESPONSE=$(http POST "/campaigns/jobs/${JOB_ID}/cancel")
  assert_http_success "/campaigns/jobs/${JOB_ID}/cancel" "${HTTP_STATUS}"
  write_json "${CANCEL_JOB_RESPONSE}" "${TMP_DIR}/09-job-cancel.json"
fi

echo "======== RESUMO ========"
ls -1 "${TMP_DIR}"
log "Smoke test concluído. Saída em: ${TMP_DIR}"
log "Valide visualmente:"
log "  - 01-health.json"
log "  - 02-campaigns-before.json"
log "  - 03-campaign-create.json (se aplicável)"
log "  - 04-campaign-schedule.json"
log "  - 05-campaign-jobs.json"
log "  - 06-campaign-pause.json"
log "  - 07-campaign-resume.json"
if [[ -n "${JOB_ID}" ]]; then
  log "  - 08-job-reschedule.json"
  log "  - 09-job-cancel.json"
fi
log "Checklist final de revisão: comparar scheduled_job.status e send_attempt.status no banco para consistência."
echo "========================"
