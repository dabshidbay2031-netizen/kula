import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * NOTE: Do NOT use module-level singletons here.
 * Next.js hot-reload keeps old module state when .env.local changes,
 * causing the old Supabase URL to persist until the process is killed.
 * We create clients lazily inside functions so they always read the
 * current env var values at call time.
 */

let _supabase: SupabaseClient | null = null;
let _supabaseAdmin: SupabaseClient | null = null;
let _cachedUrl = '';

/**
 * Most Supabase requests get a hard 8s budget. Without this, a paused or
 * unreachable project makes API routes hang indefinitely (the TCP connection
 * opens via Cloudflare but no response ever comes), which ties up the server
 * and leaves the UI stuck on skeletons.
 *
 * Storage requests (file upload/download) are the exception: a multi-megabyte
 * photo legitimately takes far longer than 8s on a phone connection, so they
 * get a much larger budget. Applying the 8s cap to uploads is what caused
 * chat image sends to fail with "signal timed out".
 */
// 8s was too tight for a mobile 3G token-refresh / query round-trip in the
// target market — legitimate-but-slow requests aborted with "signal timed out".
// 15s gives slow connections room while still failing fast enough to recover.
const SUPABASE_TIMEOUT_MS = 15000;
const STORAGE_TIMEOUT_MS   = 120000;

function reqUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return (input as Request).url ?? '';
}

const fetchWithTimeout: typeof fetch = (input, init) => {
  const ms = reqUrl(input).includes('/storage/v1/') ? STORAGE_TIMEOUT_MS : SUPABASE_TIMEOUT_MS;
  const timeout = AbortSignal.timeout(ms);
  const signal = init?.signal && typeof AbortSignal.any === 'function'
    ? AbortSignal.any([init.signal as AbortSignal, timeout])
    : timeout;
  return fetch(input, { ...init, signal });
};

/**
 * True while we've deliberately paused GoTrue's token auto-refresh after a
 * network failure. Tracked so we can turn it back ON — the pause used to be
 * lifted only by a window 'online' event, which never fires for a failure that
 * isn't a real offline transition (a dead dev server, a blocked request, a DNS
 * blip). Auto-refresh then stayed off for the rest of the session and sessions
 * silently stopped renewing until the user reloaded the page.
 */
let _refreshPaused = false;

function pauseRefresh() {
  if (_refreshPaused) return;
  _refreshPaused = true;
  try { _supabase?.auth.stopAutoRefresh(); } catch { /* noop */ }
}

function resumeRefresh() {
  if (!_refreshPaused) return;
  _refreshPaused = false;
  try { _supabase?.auth.startAutoRefresh(); } catch { /* noop */ }
}

/**
 * Browser fetch for Supabase. On a network failure (offline, connection
 * changed, DNS hiccup) hitting an /auth/ endpoint, pause GoTrue's token
 * auto-refresh — otherwise its periodic timer + every tab-focus keep retrying
 * and flood the console with identical "Failed to fetch" errors during a blip.
 *
 * Any auth request that COMPLETES resumes it: a round-trip is proof the
 * connection is back, whatever the HTTP status (a 400 "invalid credentials"
 * still means the network is fine).
 */
const browserFetch: typeof fetch = async (input, init) => {
  const isAuth = reqUrl(input).includes('/auth/v1/');
  try {
    const res = await fetchWithTimeout(input, init);
    if (isAuth) resumeRefresh();
    return res;
  } catch (err) {
    if (isAuth) pauseRefresh();
    throw err;
  }
};

let _connectivityHooked = false;
function hookConnectivity() {
  if (_connectivityHooked || typeof window === 'undefined') return;
  _connectivityHooked = true;
  // Connection lost → stop the refresh storm; restored → resume normally.
  window.addEventListener('offline', pauseRefresh);
  window.addEventListener('online',  resumeRefresh);
}

function resetIfUrlChanged() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
  if (_cachedUrl && _cachedUrl !== url) {
    // URL changed (e.g. new project) — drop cached clients
    _supabase      = null;
    _supabaseAdmin = null;
  }
  _cachedUrl = url;
}

/** Browser client — use in Client Components and pages */
export function getSupabase(): SupabaseClient {
  resetIfUrlChanged();
  if (!_supabase) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    if (!url || !key) throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY');
    _supabase = createClient(url, key, {
      auth: { persistSession: true, detectSessionInUrl: true },
      global: { fetch: browserFetch },
    });
    hookConnectivity();
  }
  return _supabase;
}

/** Server/admin client — call this inside API route handlers only */
export function getSupabaseAdmin(): SupabaseClient {
  resetIfUrlChanged();
  if (!_supabaseAdmin) {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;
    if (!url || !key) throw new Error('Missing Supabase environment variables');
    _supabaseAdmin = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: fetchWithTimeout },
    });
  }
  return _supabaseAdmin;
}
