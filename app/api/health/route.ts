import { NextResponse } from 'next/server';

// Load-balancer health check. Deliberately touches nothing (no Supabase, no
// providers) — it answers "is the Next.js server up", not "are dependencies
// healthy", so a dependency blip doesn't get tasks killed and recycled.
export const dynamic = 'force-dynamic';

export function GET() {
  return NextResponse.json({ status: 'ok' });
}
