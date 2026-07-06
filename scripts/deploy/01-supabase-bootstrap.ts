#!/usr/bin/env tsx
/**
 * 01-supabase-bootstrap.ts — bring a Supabase project from fresh to ready.
 *
 * Idempotent: safe to re-run on an already-bootstrapped project.
 *
 * What it does, in order:
 *   1. Applies all migrations (with built-in repair for three known
 *      fresh-database failures — see notes inline)
 *   2. Fixes the profiles subscription-tier check constraint if the stale
 *      ('free','basic','premium') version survived (the phase1 migration's
 *      conditional replacement misses it on some paths)
 *   3. Disables signup (single-user mode)
 *   4. Creates the admin account (email pre-confirmed), inserts its profiles
 *      row (the auto-create trigger is commented out in the initial schema),
 *      and grants pro tier to 2099
 *
 * Usage:
 *   SUPABASE_ACCESS_TOKEN=sbp_... npx tsx scripts/deploy/01-supabase-bootstrap.ts [--password-file <path>]
 *
 * The admin password is read from --password-file if given (file is NOT
 * deleted; caller owns it). Without it, a random password is set and a note
 * printed — set the real password later via the app's Settings page or the
 * Admin API.
 */
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { randomBytes } from 'crypto';
import { resolve } from 'path';

const CONFIG_PATH = resolve(__dirname, 'deploy.config.json');
if (!existsSync(CONFIG_PATH)) {
  console.error(
    `ERROR: ${CONFIG_PATH} not found. Copy deploy.config.example.json to deploy.config.json and fill in your values.`
  );
  process.exit(1);
}
const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
const REF: string = CONFIG.supabase.projectRef;
const ADMIN_EMAIL: string = CONFIG.supabase.adminEmail;
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

// Values below are interpolated into raw SQL — reject anything that could
// break out of a string literal rather than attempting to escape it.
function assertSqlSafe(label: string, value: string) {
  if (!/^[A-Za-z0-9@._+-]+$/.test(value)) {
    throw new Error(`${label} contains characters unsafe for SQL interpolation: ${value}`);
  }
  return value;
}
assertSqlSafe('adminEmail', ADMIN_EMAIL);

if (!TOKEN) {
  console.error('ERROR: SUPABASE_ACCESS_TOKEN is required.');
  process.exit(1);
}

const MGMT = 'https://api.supabase.com/v1';

async function mgmt(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${MGMT}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  if (!res.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${path} -> ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

async function sql(query: string): Promise<any> {
  return mgmt(`/projects/${REF}/database/query`, {
    method: 'POST',
    body: JSON.stringify({ query }),
  });
}

function sh(cmd: string): string {
  return execSync(cmd, { stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf-8' });
}

async function serviceRoleKey(): Promise<string> {
  const keys = await mgmt(`/projects/${REF}/api-keys?reveal=true`);
  return keys.find((k: any) => k.name === 'service_role').api_key;
}

async function step1_migrations() {
  console.log('== 1. migrations ==');
  sh(`npx supabase link --project-ref ${REF}`);

  // Known fresh-database repairs, applied preemptively (all no-ops when the
  // database is already in the right state):

  // (a) get_usage_breakdown return-type conflict: phase1 creates one shape,
  //     phase4 redefines with a different return type — Postgres refuses
  //     CREATE OR REPLACE across return types.
  await sql(
    `DROP FUNCTION IF EXISTS public.get_usage_breakdown(uuid, timestamptz, timestamptz);`
  );

  // (b) pg_cron: the welcome-email migration schedules jobs but never
  //     creates the extension.
  await sql(`CREATE EXTENSION IF NOT EXISTS pg_cron;`);

  // (c) Two migrations assume a pre-existing production schema and fail on
  //     fresh databases (backfill references columns that never existed in
  //     this schema lineage; analytics references uv.created_at). They are
  //     data backfills / reporting views with nothing to do on an empty
  //     database — mark them applied.
  for (const version of ['20251101120003', '20251202120000']) {
    try {
      sh(`npx supabase migration repair --status applied ${version} --linked`);
    } catch {
      /* already recorded */
    }
  }

  sh(`npx supabase db push --linked --include-all`);
  console.log('migrations applied');
}

async function step2_constraint() {
  console.log('== 2. subscription-tier constraint ==');
  const rows = await sql(
    `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'profiles_subscription_tier_check';`
  );
  const def: string = rows[0]?.def ?? '';
  if (def.includes("'pro'")) {
    console.log('constraint already allows pro — ok');
    return;
  }
  await sql(
    `ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_subscription_tier_check;
     ALTER TABLE public.profiles ADD CONSTRAINT profiles_subscription_tier_check
       CHECK (subscription_tier IN ('free', 'pro'));`
  );
  console.log("constraint fixed to ('free','pro')");
}

async function step3_disableSignup() {
  console.log('== 3. disable signup ==');
  await mgmt(`/projects/${REF}/config/auth`, {
    method: 'PATCH',
    body: JSON.stringify({ disable_signup: true }),
  });
  console.log('signups disabled');
}

async function step4_adminAccount() {
  console.log('== 4. admin account ==');
  const service = await serviceRoleKey();
  const authAdmin = async (path: string, init?: RequestInit) => {
    const res = await fetch(`https://${REF}.supabase.co/auth/v1${path}`, {
      ...init,
      headers: {
        apikey: service,
        Authorization: `Bearer ${service}`,
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    });
    return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) };
  };

  // Find or create the user
  const list = await authAdmin(`/admin/users?page=1&per_page=100`);
  let user = (list.body.users ?? []).find((u: any) => u.email === ADMIN_EMAIL);

  if (!user) {
    const pwFileFlag = process.argv.indexOf('--password-file');
    const password =
      pwFileFlag > -1
        ? readFileSync(process.argv[pwFileFlag + 1], 'utf-8').trim()
        : randomBytes(24).toString('base64');
    const created = await authAdmin(`/admin/users`, {
      method: 'POST',
      body: JSON.stringify({ email: ADMIN_EMAIL, password, email_confirm: true }),
    });
    if (!created.ok) throw new Error(`user creation failed: ${JSON.stringify(created.body)}`);
    user = created.body;
    console.log(`created user ${user.id}`);
    if (pwFileFlag === -1) {
      console.log('NOTE: random password set — change it via Settings or the Admin API.');
    }
  } else {
    console.log(`user exists: ${user.id}`);
  }

  const userId = assertSqlSafe('user.id', user.id);

  // Profile row: the on_auth_user_created trigger is commented out in the
  // initial schema, so first login does NOT create it.
  await sql(
    `INSERT INTO public.profiles (id, email) VALUES ('${userId}', '${ADMIN_EMAIL}') ON CONFLICT (id) DO NOTHING;`
  );

  // Pro to 2099 (mirrors scripts/grant-pro-access.ts semantics, including
  // clearing cancel_at_period_end left over from any prior subscription)
  await sql(
    `UPDATE public.profiles SET
       subscription_tier = 'pro',
       subscription_status = 'active',
       subscription_current_period_start = COALESCE(subscription_current_period_start, NOW()),
       subscription_current_period_end = '2099-12-31T00:00:00Z',
       cancel_at_period_end = false
     WHERE id = '${userId}';`
  );
  console.log('pro granted to 2099-12-31');
  console.log('');
  console.log(`UNLIMITED_VIDEO_USERS=${user.id}`);
  console.log('(export this before running 04-deploy-service.sh)');
}

async function main() {
  await step1_migrations();
  await step2_constraint();
  await step3_disableSignup();
  await step4_adminAccount();
  console.log('\nSupabase bootstrap complete.');
}

main().catch((err) => {
  console.error('FAILED:', err.message ?? err);
  process.exit(1);
});
