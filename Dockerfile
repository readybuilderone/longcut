# LongCut container image (Next.js standalone output).
#
# NEXT_PUBLIC_* values are inlined into the client bundle at BUILD time —
# they must be passed as build args, not runtime env:
#
#   docker build \
#     --build-arg NEXT_PUBLIC_SUPABASE_URL=https://<ref>.supabase.co \
#     --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=<anon-key> \
#     --build-arg NEXT_PUBLIC_AI_PROVIDER=bedrock \
#     --build-arg NEXT_PUBLIC_APP_URL=<https-url-once-known> \
#     -t longcut .
#
# Server-side secrets (SUPABASE_SERVICE_ROLE_KEY, CSRF_SALT, provider keys)
# are RUNTIME env — inject via the orchestrator, never bake into the image.

FROM node:22-slim AS builder
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_AI_PROVIDER=bedrock
ARG NEXT_PUBLIC_APP_URL
ARG NEXT_PUBLIC_AI_MODEL
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL \
    NEXT_PUBLIC_SUPABASE_ANON_KEY=$NEXT_PUBLIC_SUPABASE_ANON_KEY \
    NEXT_PUBLIC_AI_PROVIDER=$NEXT_PUBLIC_AI_PROVIDER \
    NEXT_PUBLIC_APP_URL=$NEXT_PUBLIC_APP_URL \
    NEXT_PUBLIC_AI_MODEL=$NEXT_PUBLIC_AI_MODEL \
    NEXT_TELEMETRY_DISABLED=1

RUN npm run build

FROM node:22-slim AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1

RUN groupadd --system nextjs && useradd --system --gid nextjs nextjs

COPY --from=builder --chown=nextjs:nextjs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nextjs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nextjs /app/public ./public

USER nextjs
EXPOSE 3000

CMD ["node", "server.js"]
