# Deploying LongCut (AWS ECS Express Mode + Supabase)

Single-user deployment: Claude on AWS Bedrock for text generation, Supabase
for auth/data, ECS Express Mode for hosting. From a fresh clone to a live
HTTPS URL in four scripted steps.

## Prerequisites

- Docker, AWS CLI **≥ 2.35** (older versions lack `taskDefinitionArn` on
  `create-express-gateway-service`), Node 22+, `npx`, `python3` (used by the
  shell scripts to parse `deploy.config.json`)
- The scripts invoke `sudo docker` by default; override with
  `DOCKER=docker` if your user is in the docker group
- AWS credentials with admin-ish access (IAM, ECR, ECS, SSM, Logs) — an
  instance role works; no static keys needed
- A Supabase project (note its ref) and a personal access token (`sbp_...`)
- Bedrock **model access enabled** in your target region for the model in
  `lib/ai-providers/provider-config.ts` (`anthropic.claude-sonnet-5`).
  The Mantle endpoint accepts only bare `anthropic.`-prefixed model IDs —
  `us.`/`global.` inference profiles and `-v1:0` versioned IDs 404.
- Optional but strongly recommended: a [Supadata](https://supadata.ai) API
  key. Datacenter IPs (ECS included) routinely hit YouTube's bot wall on all
  client identities; without this fallback, transcript fetching will fail
  for many videos.

## Configuration

Copy the template and fill in your values (the real config is gitignored —
it contains your account/subnet/project identifiers):

```sh
cp scripts/deploy/deploy.config.example.json scripts/deploy/deploy.config.json
```

Edit `scripts/deploy/deploy.config.json`: AWS account/region, service name,
**public subnets** (Express Mode needs explicit subnets when the account has
no default VPC), CPU architecture (**must match your build host** — see
pitfalls), Supabase ref, admin email.

Secrets are never stored in the repo. Each script reads them from env vars
or files at runtime.

## Steps

```sh
# 1. Supabase: migrations (with fresh-DB repairs), disable signup,
#    admin account + pro grant. Prints the UNLIMITED_VIDEO_USERS id.
SUPABASE_ACCESS_TOKEN=sbp_... npx tsx scripts/deploy/01-supabase-bootstrap.ts \
  [--password-file /tmp/.pw]

# 2. AWS: ECR repo, IAM roles (execution/infrastructure/task), SSM secrets
#    GEMINI_API_KEY is only needed if you use image generation.
SUPABASE_SERVICE_ROLE_KEY=... [SUPADATA_API_KEY=...] [GEMINI_API_KEY=...] \
  ./scripts/deploy/02-aws-bootstrap.sh

# 3. Build & push the image (NEXT_PUBLIC_* bake in at build time)
NEXT_PUBLIC_SUPABASE_ANON_KEY=... ./scripts/deploy/03-build-push.sh

# 4. Register task definition, create/update the service, wait for healthy,
#    back-fill Supabase site_url with the assigned domain
NEXT_PUBLIC_SUPABASE_ANON_KEY=... SUPABASE_ACCESS_TOKEN=sbp_... \
  UNLIMITED_VIDEO_USERS=<id-from-step-1> \
  ./scripts/deploy/04-deploy-service.sh
```

First deploy prints the service URL and a note: rebuild once with
`NEXT_PUBLIC_APP_URL=https://<url>` (steps 3 → 4 again) so the client bundle
knows its own origin.

## Redeploying after code changes

Steps 3 → 4 only. Step 4 registers a new task-definition revision and rolls
the service; the old task drains (takes a few minutes — requests may hit the
old task until the PRIMARY deployment is the only one).

## Known pitfalls

| Symptom | Cause / fix |
|---|---|
| Task crash-loops with `exec format error` | Image architecture ≠ task `runtimePlatform`. Set `cpuArchitecture` in config to match the build host (`uname -m`: aarch64 → ARM64). Express Mode's simple `--primary-container` path defaults to x86 — that's why the scripts use an explicit task definition. |
| `Task definition must have a container named Main` | Express Mode validation. The template already complies; don't rename. |
| `Unable to Start a service that is still Draining` | A deleted service's name is stuck draining. Wait (can take 30+ min) or pick a new service name. |
| `No default VPC` on create | Provide explicit public subnets in config. |
| Transcript fails: "No transcript available" for videos that have captions | YouTube bot wall on datacenter IPs. Configure `SUPADATA_API_KEY` (step 2) — the app falls back automatically. |
| Migrations fail on a fresh database | Handled by step 1's built-in repairs (function return-type conflict, data-assuming backfill/analytics migrations, pg_cron). If a *new* migration fails, fix forward — don't add to the repair list without understanding why. |
| Bedrock 404 "model does not exist" | Model access not enabled in the region, or a non-bare model ID. See prerequisites. |
| Login redirects to localhost | Step 4's back-fill didn't run (no `SUPABASE_ACCESS_TOKEN`). Patch `site_url` + `uri_allow_list` in Supabase auth config manually. |
| Image generation returns 500 | `GEMINI_API_KEY` not provided in step 2 (text generation is unaffected — it uses Bedrock). |
| Public URL unreachable but deploy says healthy | Health is judged via the ECS/ALB control plane. Account firewall guardrails may restrict ALB ingress (e.g. a corp-only prefix list on the security group) — access from an allowed network. |

## What is intentionally NOT here

- **Stripe**: single-user mode skips payments entirely (admin account has
  pro tier to 2099). To enable payments, see CLAUDE.md and configure the
  five `STRIPE_*` env vars + webhook endpoint.
- **Custom domain**: the AWS-provided `*.ecs.<region>.on.aws` domain works
  out of the box. Route 53 + ACM + ALB listener rule if you want a real one.
- **Multi-environment**: this is a one-environment setup. If you outgrow it,
  port the scripts to CDK (Express Mode has CloudFormation support).
