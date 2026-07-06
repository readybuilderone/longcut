#!/usr/bin/env bash
# 04-deploy-service.sh — register the task definition and create/update the
# ECS Express Mode service, then close the loop on Supabase auth URLs.
#
# Idempotent: creates the service if absent, otherwise rolls it to a new
# task-definition revision.
#
# Hard-won invariants baked into the task definition (do not "simplify"):
#   - container name MUST be "Main" (Express Mode validation)
#   - port mapping MUST be named, TCP, with containerPort
#   - runtimePlatform MUST match the image architecture; images built on an
#     ARM host without this crash-loop with "exec format error" (Express
#     Mode's simple --primary-container path defaults to x86)
#   - passing taskDefinitionArn to create-express-gateway-service requires
#     AWS CLI >= 2.35
#
# Required env for the Supabase back-fill step: SUPABASE_ACCESS_TOKEN
# Optional env: UNLIMITED_VIDEO_USERS (owner user id for limit bypass)
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
SERVICE=$(jqc "['serviceName']")
CLUSTER=$(jqc "['cluster']")
ARCH=$(jqc "['cpuArchitecture']")
CPU=$(jqc "['cpu']")
MEMORY=$(jqc "['memory']")
PORT=$(jqc "['containerPort']")
HEALTH=$(jqc "['healthCheckPath']")
MIN_TASKS=$(jqc "['scaling']['minTaskCount']")
MAX_TASKS=$(jqc "['scaling']['maxTaskCount']")
LOG_GROUP=$(jqc "['logGroup']")
SSM_PREFIX=$(jqc "['ssmPrefix']")
EXEC_ROLE=$(jqc "['roles']['execution']")
INFRA_ROLE=$(jqc "['roles']['infrastructure']")
TASK_ROLE=$(jqc "['roles']['task']")
REF=$(jqc "['supabase']['projectRef']")
PROVIDER=$(jqc "['aiProvider']")
SUBNETS_JSON=$(python3 -c "import json;print(json.dumps(json.load(open('$CFG'))['subnets']))")

ANON_KEY="${NEXT_PUBLIC_SUPABASE_ANON_KEY:?set NEXT_PUBLIC_SUPABASE_ANON_KEY}"

echo "== log group =="
aws logs create-log-group --log-group-name "$LOG_GROUP" --region "$REGION" 2>/dev/null || true

echo "== task definition =="
SUPADATA_SECRET=""
if aws ssm get-parameter --name "$SSM_PREFIX/supadata-api-key" --region "$REGION" >/dev/null 2>&1; then
  SUPADATA_SECRET=",{\"name\":\"SUPADATA_API_KEY\",\"valueFrom\":\"arn:aws:ssm:$REGION:$ACCOUNT:parameter$SSM_PREFIX/supadata-api-key\"}"
fi
GEMINI_SECRET=""
if aws ssm get-parameter --name "$SSM_PREFIX/gemini-api-key" --region "$REGION" >/dev/null 2>&1; then
  GEMINI_SECRET=",{\"name\":\"GEMINI_API_KEY\",\"valueFrom\":\"arn:aws:ssm:$REGION:$ACCOUNT:parameter$SSM_PREFIX/gemini-api-key\"}"
fi
UNLIMITED_ENV=""
if [ -n "${UNLIMITED_VIDEO_USERS:-}" ]; then
  UNLIMITED_ENV=",{\"name\":\"UNLIMITED_VIDEO_USERS\",\"value\":\"$UNLIMITED_VIDEO_USERS\"}"
fi
APP_URL_ENV=""
if [ -n "${NEXT_PUBLIC_APP_URL:-}" ]; then
  APP_URL_ENV=",{\"name\":\"NEXT_PUBLIC_APP_URL\",\"value\":\"$NEXT_PUBLIC_APP_URL\"}"
fi

cat > /tmp/longcut-taskdef.json <<EOF
{
  "family": "longcut-arm",
  "networkMode": "awsvpc",
  "requiresCompatibilities": ["FARGATE"],
  "cpu": "$CPU",
  "memory": "$MEMORY",
  "runtimePlatform": {"cpuArchitecture": "$ARCH", "operatingSystemFamily": "LINUX"},
  "executionRoleArn": "arn:aws:iam::$ACCOUNT:role/$EXEC_ROLE",
  "taskRoleArn": "arn:aws:iam::$ACCOUNT:role/$TASK_ROLE",
  "containerDefinitions": [
    {
      "name": "Main",
      "image": "$ACCOUNT.dkr.ecr.$REGION.amazonaws.com/$REPO:latest",
      "essential": true,
      "portMappings": [{"name": "http", "containerPort": $PORT, "protocol": "tcp"}],
      "environment": [
        {"name": "AI_PROVIDER", "value": "$PROVIDER"},
        {"name": "NEXT_PUBLIC_AI_PROVIDER", "value": "$PROVIDER"},
        {"name": "NEXT_PUBLIC_SUPABASE_URL", "value": "https://$REF.supabase.co"},
        {"name": "NEXT_PUBLIC_SUPABASE_ANON_KEY", "value": "$ANON_KEY"}$UNLIMITED_ENV$APP_URL_ENV
      ],
      "secrets": [
        {"name": "SUPABASE_SERVICE_ROLE_KEY", "valueFrom": "arn:aws:ssm:$REGION:$ACCOUNT:parameter$SSM_PREFIX/supabase-service-role-key"},
        {"name": "CSRF_SALT", "valueFrom": "arn:aws:ssm:$REGION:$ACCOUNT:parameter$SSM_PREFIX/csrf-salt"}$SUPADATA_SECRET$GEMINI_SECRET
      ],
      "logConfiguration": {
        "logDriver": "awslogs",
        "options": {
          "awslogs-group": "$LOG_GROUP",
          "awslogs-region": "$REGION",
          "awslogs-stream-prefix": "longcut-arm"
        }
      }
    }
  ]
}
EOF
TD_ARN=$(aws ecs register-task-definition --region "$REGION" \
  --cli-input-json file:///tmp/longcut-taskdef.json \
  --query 'taskDefinition.taskDefinitionArn' --output text)
echo "registered: $TD_ARN"

echo "== service =="
SERVICE_ARN="arn:aws:ecs:$REGION:$ACCOUNT:service/$CLUSTER/$SERVICE"
if aws ecs describe-express-gateway-service --region "$REGION" --service-arn "$SERVICE_ARN" >/dev/null 2>&1; then
  cat > /tmp/longcut-express.json <<EOF
{"serviceArn": "$SERVICE_ARN", "taskDefinitionArn": "$TD_ARN"}
EOF
  aws ecs update-express-gateway-service --region "$REGION" --cli-input-json file:///tmp/longcut-express.json >/dev/null
  echo "updated: $SERVICE"
else
  cat > /tmp/longcut-express.json <<EOF
{
  "serviceName": "$SERVICE",
  "infrastructureRoleArn": "arn:aws:iam::$ACCOUNT:role/$INFRA_ROLE",
  "taskDefinitionArn": "$TD_ARN",
  "healthCheckPath": "$HEALTH",
  "networkConfiguration": {"subnets": $SUBNETS_JSON},
  "scalingTarget": {"minTaskCount": $MIN_TASKS, "maxTaskCount": $MAX_TASKS}
}
EOF
  aws ecs create-express-gateway-service --region "$REGION" --cli-input-json file:///tmp/longcut-express.json >/dev/null
  echo "created: $SERVICE"
fi

echo "== waiting for healthy =="
URL=$(aws ecs describe-express-gateway-service --region "$REGION" --service-arn "$SERVICE_ARN" \
  | python3 -c "import json,sys,re; m=re.search(r'[a-z0-9-]+\.ecs\.$REGION\.on\.aws', json.dumps(json.load(sys.stdin))); print(m.group(0) if m else '')")
[ -n "$URL" ] || { echo "ERROR: could not extract service URL"; exit 1; }

# Health is judged via the ECS deployment state + ALB target-health API
# (control plane), NOT by curling the public URL: account-level firewall
# guardrails may restrict ingress to corporate networks, making the URL
# unreachable from the deploy host even though the service is healthy.
#
# The gate requires BOTH: (a) the rollout has converged — exactly one
# deployment, running the revision we just registered (an old task staying
# healthy while the new one crash-loops must NOT pass), and (b) that task
# is healthy behind the ALB.
DONE=""
for i in $(seq 1 30); do
  sleep 20
  read -r DEPLOY_COUNT PRIMARY_TD RUNNING <<< "$(aws ecs describe-services \
    --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
    --query 'services[0].[length(deployments), deployments[?status==`PRIMARY`].taskDefinition | [0], deployments[?status==`PRIMARY`].runningCount | [0]]' \
    --output text 2>/dev/null | tr '\t' ' ')"
  echo "  rollout $i: deployments=$DEPLOY_COUNT primary_running=$RUNNING"
  if [ "$DEPLOY_COUNT" = "1" ] && [ "$PRIMARY_TD" = "$TD_ARN" ] && [ "${RUNNING:-0}" -ge 1 ]; then
    DONE=yes
    break
  fi
done
[ "$DONE" = "yes" ] || { echo "ERROR: rollout did not converge to $TD_ARN"; exit 1; }

# Belt-and-suspenders: if the service exposes its target group via the
# classic loadBalancers attachment, verify a healthy target. Express Mode
# services manage the ALB out-of-band and report None here — in that case
# gate (a) stands alone, which is sound: with ALB-attached tasks, ECS kills
# tasks failing TG health checks, so a converged deployment with running>=1
# implies the health check is passing.
TG_ARN=$(aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --region "$REGION" \
  --query 'services[0].loadBalancers[0].targetGroupArn' --output text 2>/dev/null)
if [ -n "$TG_ARN" ] && [ "$TG_ARN" != "None" ]; then
  STATE=$(aws elbv2 describe-target-health --target-group-arn "$TG_ARN" --region "$REGION" \
    --query 'TargetHealthDescriptions[].TargetHealth.State' --output text 2>/dev/null | tr '\t' '\n' | sort -u | tr '\n' ' ')
  echo "  target states: ${STATE:-none}"
  case " $STATE" in
    *" healthy "*) ;;
    *) echo "ERROR: rollout converged but no target reports healthy"; exit 1 ;;
  esac
fi
echo "live: https://$URL"

CODE=$(curl -s -m 8 -o /dev/null -w "%{http_code}" "https://$URL$HEALTH" || true)
if [ "$CODE" != "200" ]; then
  echo "note: public URL not reachable from this host (HTTP $CODE) — if an"
  echo "account firewall guardrail restricts ingress (e.g. corp-only prefix"
  echo "list on the ALB security group), access it from an allowed network."
fi

echo "== Supabase auth back-fill =="
if [ -n "${SUPABASE_ACCESS_TOKEN:-}" ]; then
  curl -s -X PATCH "https://api.supabase.com/v1/projects/$REF/config/auth" \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" -H "Content-Type: application/json" \
    -d "{\"site_url\": \"https://$URL\", \"uri_allow_list\": \"https://$URL/**,http://localhost:3000/**\"}" >/dev/null
  echo "site_url -> https://$URL"
else
  echo "note: SUPABASE_ACCESS_TOKEN not set — update site_url/uri_allow_list manually"
fi

if [ -z "${NEXT_PUBLIC_APP_URL:-}" ]; then
  echo ""
  echo "NOTE: NEXT_PUBLIC_APP_URL was not baked into this image. For correct"
  echo "client-side URL resolution, rebuild and redeploy once with:"
  echo "  NEXT_PUBLIC_APP_URL=https://$URL ./scripts/deploy/03-build-push.sh"
  echo "  NEXT_PUBLIC_APP_URL=https://$URL ./scripts/deploy/04-deploy-service.sh"
fi
