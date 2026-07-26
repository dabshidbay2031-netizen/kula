import { NextResponse } from 'next/server';
import { getSupabaseAdmin } from '@/lib/supabase';
import { errMsg, isUUIDError, isMissingColumnError } from '@/lib/apiHelpers';
import { normalizeGender, normalizeBirthYear, ageFromBirthYear, ageBracket } from '@/lib/demographics';

function mapProfile(p: Record<string, unknown>) {
  const birthYear = p.birth_year != null ? Number(p.birth_year) : null;
  return {
    id:        p.id,
    fullName:  p.full_name  ?? '',
    phone:     p.phone      ?? '',
    avatar:    p.avatar     ?? '👤',
    avatarUrl: p.avatar_url ?? null,
    bio:       p.bio        ?? '',
    verified:  p.verified   ?? false,
    createdAt: p.created_at ?? '',
    /* Demographics — optional, '' / null means the shopper declined. Age is
       DERIVED from birth year on every read, so it can never go stale. */
    gender:    normalizeGender(p.gender),
    birthYear,
    age:        ageFromBirthYear(birthYear),
    ageBracket: ageBracket(birthYear),
  };
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const userId = searchParams.get('userId');
  if (!userId) return NextResponse.json({ error: 'userId required' }, { status: 400 });

  const { data, error } = await getSupabaseAdmin()
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();

  if (error || !data) return NextResponse.json(null);
  return NextResponse.json(mapProfile(data as Record<string, unknown>));
}

export async function POST(req: Request) {
  const body = await req.json();
  const { id, fullName, phone, avatar, avatarUrl, bio, gender, birthYear } = body;
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 });

  const payload: Record<string, unknown> = {
    id,
    full_name:  fullName  ?? '',
    phone:      phone     ?? '',
    avatar:     avatar    ?? '👤',
    avatar_url: avatarUrl ?? null,
    bio:        bio       ?? '',
  };

  // Demographics are optional and validated server-side: an out-of-range birth
  // year (typo, bot, someone under 13) is stored as "declined" rather than
  // skewing an age bracket. Only written when the client actually sent them,
  // so a partial profile update can't silently blank an existing answer.
  if (gender    !== undefined) payload.gender     = normalizeGender(gender);
  if (birthYear !== undefined) payload.birth_year = normalizeBirthYear(birthYear);

  let { data, error } = await getSupabaseAdmin()
    .from('profiles')
    .upsert(payload)
    .select()
    .single();

  // Pre-v3.1 DB without avatar_url/bio columns — retry without them so the
  // app still works against an un-migrated schema. Same for the v4.5
  // demographics columns.
  if (error && isMissingColumnError(error)) {
    delete payload.avatar_url;
    delete payload.bio;
    delete payload.gender;
    delete payload.birth_year;
    ({ data, error } = await getSupabaseAdmin()
      .from('profiles')
      .upsert(payload)
      .select()
      .single());
  }

  if (error) {
    // UUID type error = schema not migrated yet — return a helpful message
    if (isUUIDError(error)) {
      return NextResponse.json({
        error: 'Schema not migrated: profiles.id must be TEXT. Run supabase/migration.sql in your Supabase SQL editor.',
        needsMigration: true,
      }, { status: 500 });
    }
    return NextResponse.json({ error: errMsg(error) }, { status: 500 });
  }
  return NextResponse.json(mapProfile(data as Record<string, unknown>), { status: 201 });
}
