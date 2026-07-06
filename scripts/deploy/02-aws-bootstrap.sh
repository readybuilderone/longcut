#!/usr/bin/env bash
# 02-aws-bootstrap.sh — one-time AWS resources for the LongCut ECS deployment.
# Idempotent: safe to re-run; existing resources are left as-is or updated.
#
# Secrets are read from env vars (never from arguments or this file):
#   SUPABASE_SERVICE_ROLE_KEY   required on first run
#   CSRF_SALT                   optional (generated if unset and absent in SSM)
#   SUPADATA_API_KEY            optional (transcript fallback; skipped if unset)
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CFG="$DIR/deploy.config.json"
if [ ! -f "$CFG" ]; then
  echo "ERROR: $CFG not found. Copy deploy.config.example.json to deploy.config.json and fill in your values." >&2
  exit 1
fi
jqc() { python3 -c "import json;print(json.load(open('$CFG'))$1)"; }

REGION=$(jqc "['awsRegion']")
ACCOUNT=$(jqc "['awsAccountId']")
REPO=$(jqc "['ecrRepository']")
SSM_PREFIX=$(jqc "['ssmPrefix']")
EXEC_ROLE=$(jqc "['roles']['execution']")
INFRA_ROLE=$(jqc "['roles']['infrastructure']")
TASK_ROLE=$(jqc "['roles']['task']")

echo "== ECR repository =="
aws ecr describe-repositories --repository-names "$REPO" --region "$REGION" >/dev/null 2>&1 \
  || aws ecr create-repository --repository-name "$REPO" --region "$REGION" >/dev/null
echo "ok: $ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$REPO"

ECS_TASKS_TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs-tasks.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
ECS_TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ecs.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

ensure_role() { # name trust-json
  aws iam get-role --role-name "$1" >/dev/null 2>&1 \
    || aws iam create-role --role-name "$1" --assume-role-policy-document "$2" >/dev/null
}

echo "== IAM: execution role =="
ensure_role "$EXEC_ROLE" "$ECS_TASKS_TRUST"
# attach-role-policy is idempotent (re-attach succeeds) — do NOT suppress
# errors here; a typo'd policy ARN must fail loudly, not leave a broken role.
aws iam attach-role-policy --role-name "$EXEC_ROLE" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam put-role-policy --role-name "$EXEC_ROLE" --policy-name longcut-ssm-read --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"ssm:GetParameters\",\"ssm:GetParameter\"],\"Resource\":\"arn:aws:ssm:$REGION:$ACCOUNT:parameter$SSM_PREFIX/*\"}]}"
echo "ok: $EXEC_ROLE"

echo "== IAM: infrastructure role =="
ensure_role "$INFRA_ROLE" "$ECS_TRUST"
# NOTE: the managed policy lives under the service-role/ path prefix.
aws iam attach-role-policy --role-name "$INFRA_ROLE" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSInfrastructureRoleforExpressGatewayServices
echo "ok: $INFRA_ROLE"

echo "== IAM: task role (Bedrock) =="
ensure_role "$TASK_ROLE" "$ECS_TASKS_TRUST"
# The Mantle endpoint signs as service bedrock-mantle; cover the classic
# namespace too so either invocation path works.
aws iam put-role-policy --role-name "$TASK_ROLE" --policy-name longcut-bedrock-access --policy-document \
  '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["bedrock-mantle:*","bedrock:InvokeModel","bedrock:InvokeModelWithResponseStream"],"Resource":"*"}]}'
echo "ok: $TASK_ROLE"

echo "== SSM parameters =="
put_param() { # name value
  aws ssm put-parameter --name "$1" --type SecureString --value "$2" --overwrite --region "$REGION" >/dev/null
  echo "ok: $1"
}
have_param() { aws ssm get-parameter --name "$1" --region "$REGION" >/dev/null 2>&1; }

if [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  put_param "$SSM_PREFIX/supabase-service-role-key" "$SUPABASE_SERVICE_ROLE_KEY"
elif ! have_param "$SSM_PREFIX/supabase-service-role-key"; then
  echo "ERROR: SUPABASE_SERVICE_ROLE_KEY is not set and no existing parameter found." >&2
  exit 1
fi

if [ -n "${CSRF_SALT:-}" ]; then
  put_param "$SSM_PREFIX/csrf-salt" "$CSRF_SALT"
elif ! have_param "$SSM_PREFIX/csrf-salt"; then
  put_param "$SSM_PREFIX/csrf-salt" "$(openssl rand -hex 32)"
fi

if [ -n "${SUPADATA_API_KEY:-}" ]; then
  put_param "$SSM_PREFIX/supadata-api-key" "$SUPADATA_API_KEY"
elif ! have_param "$SSM_PREFIX/supadata-api-key"; then
  echo "note: SUPADATA_API_KEY not set — transcript fallback will be disabled until provided"
fi

if [ -n "${GEMINI_API_KEY:-}" ]; then
  put_param "$SSM_PREFIX/gemini-api-key" "$GEMINI_API_KEY"
elif ! have_param "$SSM_PREFIX/gemini-api-key"; then
  echo "note: GEMINI_API_KEY not set — image generation will return 500 until provided"
fi

echo "AWS bootstrap complete."
