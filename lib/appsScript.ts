// This file is the ONLY place in the whole app that knows how to talk to Apps
// Script. Everything above it (API routes, components) works with clean
// TypeScript types and has no idea Google Sheets or Apps Script exist.
//
// That boundary matters: if you later swap the sheet for a real database, or
// add a caching layer, this is the only file that changes.

import { cache } from 'react';

export type DeliveryRow = {
  trackingId: string;
  orderName: string;
  customerName: string;
  items: string;
  totalPrice: string;
  deliveryStatus: string;
  statusDate: string;
  driveAccount: string;
  videoFileId: string;
  frontPhotoId: string;
  backPhotoId: string;
  labelPhotoId: string;
  youtubeUrl: string;
  createdDate: string;
  createdTime: string;
  filesDeleted: string;
  // Blank on rows written before the Folder ID column existed, and on rows
  // written via logDelivery/doPost, which never resolve a per-tracking-ID
  // Drive subfolder.
  folderId: string;
  hasMedia: boolean;
  /**
   * When the parcel was scanned out of the building, written to the main log
   * by logDispatch. Blank on rows that predate the column, which means
   * "unknown" — NOT "never dispatched". Only dispatchList can assert an audit
   * gap, so this renders as empty rather than as a warning.
   */
  dispatchedAt?: string;
};

export type DeliveriesResponse = {
  success: boolean;
  totalRows: number;
  /** Rows this query can page through — the match count when searching. */
  matchCount?: number;
  /** True when the server applied a search rather than returning a plain page. */
  searched?: boolean;
  /** True when the server applied a status/account/date filter. */
  filtered?: boolean;
  sort?: string;
  dir?: string;
  offset: number;
  limit: number;
  hasMore: boolean;
  rows: DeliveryRow[];
  error?: string;
};

export type QuotaResponse = {
  success: boolean;
  account: string;
  limitBytes: number;
  usedBytes: number;
  freeBytes: number;
  hasRoom: boolean;
  error?: string;
};

export type StorageAccountConfig = { label: string; url: string };

// Mirrors sheetStats_() in your existing Code.gs — no new endpoint needed,
// this hits ?action=admin&job=stats, which already exists.
export type StatsResponse = {
  success: boolean;
  totalRows: number;
  blankTracking: number;
  blankOrderName: number;
  blankCustomer: number;
  blankDriveAccount: number;
  blankDeliveryStatus: number;
  blankVideoId: number;
  delivered: number;
  deliveredNoStatusDate: number;
  deliveredNoDriveAccount: number;
  deliveredNoFileIds: number;
  alreadyPurged: number;
  purgeableNow: number;
  blankOrderNameRows: string[];
  error?: string;
};

function requireEnv(name: string): string {
  // Trimmed because a value pasted into a hosting dashboard often carries a
  // trailing newline or space, and an untrimmed URL or key silently corrupts
  // every request built from it — a 404 or 401 that looks like a broken
  // endpoint rather than a stray character.
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/** Reads DROPPY_STORAGE_ACCOUNTS once and validates its shape, so a malformed
 *  env var fails loudly at request time instead of silently returning []. */
export function getStorageAccounts(): StorageAccountConfig[] {
  const raw = process.env.DROPPY_STORAGE_ACCOUNTS;
  if (!raw) return [];

  // Pasting a 1.5KB JSON array into a hosting dashboard's env-var box goes
  // wrong in predictable ways, and a bare JSON.parse turns every one of them
  // into an unhandled SyntaxError that takes down the whole page render —
  // observed in production as "Unexpected non-whitespace character after JSON
  // at position 1480", i.e. the array parsed fine and something followed it on
  // a second line.
  //
  // Normalising first fixes the three common cases:
  //   * the textarea appended a newline, or the value was pasted with trailing
  //     commentary after it
  //   * the whole value got wrapped in quotes, the way it appears in a .env file
  //   * smart quotes, if it travelled through a document or chat app
  let text = raw.trim();

  // Strip wrapping quotes only when they enclose the entire value.
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }

  // Keep only the outermost array. Anything after the closing bracket is
  // paste debris, and anything before it is a stray prefix.
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start !== -1 && end > start) text = text.slice(start, end + 1);

  // Curly quotes are never valid JSON but survive a copy through a doc or chat.
  text = text.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'");

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    // A thrown SyntaxError here previously crashed the page. Report the
    // misconfiguration and let the dashboard render without storage cards —
    // the delivery table and sheet health do not depend on this value.
    console.error('DROPPY_STORAGE_ACCOUNTS is not valid JSON:', err);
    return [];
  }

  if (!Array.isArray(parsed)) {
    console.error('DROPPY_STORAGE_ACCOUNTS must be a JSON array; got', typeof parsed);
    return [];
  }

  // Drop entries missing the two fields every caller needs, rather than letting
  // an undefined url become the string "undefined" in a fetch.
  return parsed.filter(
    (a): a is StorageAccountConfig =>
      Boolean(a) && typeof a === 'object' && typeof (a as StorageAccountConfig).url === 'string'
  );
}

/** Generic fetch-JSON-from-Apps-Script with a timeout and one retry.
 *
 *  Two things make Apps Script unreliable in a way a plain fetch handles badly:
 *
 *  1. COLD STARTS. A script that hasn't run recently can take well over 10s to
 *     respond at all. The old 10s ceiling turned every cold start into a hard
 *     failure ("This operation was aborted"), which is why storage cards and
 *     the whole sheet-health panel would vanish on an otherwise healthy load.
 *
 *  2. CONCURRENCY CONTENTION. Several accounts queried at once can make some
 *     of them 502 or hang, and the same request almost always succeeds moments
 *     later — the same behaviour the delivery table already compensates for
 *     with its own retry (see fetchDeliveriesWithRetry in DeliveryTable).
 *
 *  So: a realistic timeout, plus one retry with a short backoff. A retry costs
 *  a few seconds on a genuinely dead endpoint but rescues the common transient
 *  case, which is the right trade for a dashboard that's useless when blank.
 */
async function fetchJsonOnce<T>(url: string, timeoutMs: number, live = false): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // `next.revalidate` rather than `cache: 'no-store'`.
    //
    // no-store opts every request out of Next's data cache, which would make
    // the pages' `export const revalidate = 60` a no-op: the page shell would
    // be reused while every fetch underneath it still hit Apps Script. Handing
    // the window to the fetch itself is what actually collapses eleven calls
    // per visitor into eleven per minute.
    //
    // Writes do not come through here — assignOrder and dispatchBackfill use
    // their own POST routes — so nothing mutating can be served from cache.
    const res = await fetch(url, {
      signal: controller.signal,
      // `live` is for anything the operator just asked for by hand; everything
      // else shares the 60s window.
      ...(live ? { cache: 'no-store' as const } : { next: { revalidate: 60 } })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    // Read as text first, then parse.
    //
    // Apps Script does not always answer with JSON: a deployment that is
    // unavailable, still propagating, or hit while Google is rate-limiting
    // returns an HTML error page — observed live from one storage account,
    // where res.json() threw a bare SyntaxError that said nothing about the
    // endpoint or the response. Parsing ourselves lets the failure name what
    // actually arrived.
    const body = await res.text();
    try {
      return JSON.parse(body) as T;
    } catch {
      const looksLikeHtml = /^\s*<(!doctype|html)/i.test(body);
      throw new Error(
        looksLikeHtml
          ? 'Apps Script returned an HTML error page instead of JSON — the deployment may be unavailable or still propagating.'
          : `Apps Script returned a non-JSON response (${body.slice(0, 80).replace(/\s+/g, ' ')}…)`
      );
    }
  } catch (err) {
    // AbortError's own message ("This operation was aborted") says nothing
    // about WHY, and it was surfacing raw in the storage cards. Name the cause.
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson<T>(url: string, timeoutMs = 30_000, live = false): Promise<T> {
  try {
    return await fetchJsonOnce<T>(url, timeoutMs, live);
  } catch (err) {
    await new Promise((r) => setTimeout(r, 600));
    try {
      return await fetchJsonOnce<T>(url, timeoutMs, live);
    } catch {
      // Report the FIRST failure: it's the one that describes the normal
      // condition, while the retry's error can be noise from the backoff race.
      throw err;
    }
  }
}

export type DeliveryQuery = {
  q?: string;
  status?: string;
  account?: string;
  days?: number;
  sort?: string;
  dir?: 'asc' | 'desc';
};

export async function fetchDeliveries(
  offset: number,
  limit: number,
  opts: DeliveryQuery | string = {}
): Promise<DeliveriesResponse> {
  // A bare string stays valid so existing callers keep working.
  const o: DeliveryQuery = typeof opts === 'string' ? { q: opts } : opts;

  const base = requireEnv('DROPPY_MAIN_URL');
  const key = requireEnv('DROPPY_ADMIN_KEY');
  const url =
    `${base}?action=dashboardData&key=${encodeURIComponent(key)}&offset=${offset}&limit=${limit}` +
    (o.q ? `&q=${encodeURIComponent(o.q)}` : '') +
    (o.status ? `&status=${encodeURIComponent(o.status)}` : '') +
    (o.account ? `&account=${encodeURIComponent(o.account)}` : '') +
    (o.days ? `&days=${o.days}` : '') +
    (o.sort ? `&sort=${encodeURIComponent(o.sort)}&dir=${o.dir === 'asc' ? 'asc' : 'desc'}` : '');

  // Any query with a filter, sort or search is something the operator just
  // asked for, so it bypasses the cache. A plain unfiltered page 1 is the
  // common shared view and may come from the 60s window.
  const live = Boolean(o.q || o.status || o.account || o.days || o.sort);
  return fetchJson<DeliveriesResponse>(url, 30_000, live);
}

/** Whole-sheet summary.
 *
 *  Tries `action=dashboardStats` (see apps-script-additions/3-stats.gs) first,
 *  and falls back to the older `action=admin&job=stats` if that action isn't
 *  deployed yet, so the dashboard works before AND after that file is added.
 *
 *  Why the new action exists at all: the live deployment answers the admin
 *  route with `ReferenceError: handleAdmin is not defined` — route_() has a
 *  `case 'admin'` but the function was never deployed. Apps Script returns
 *  that as HTTP 200 with {success:false, error:...}, so it can't be detected
 *  as a transport failure; it has to be checked in the body.
 */
async function fetchStatsFrom(url: string): Promise<StatsResponse> {
  // Walks every row, so it's the slowest call in the app — the longest ceiling.
  return fetchJson<StatsResponse>(url, 55_000);
}

export const fetchStats = cache(_fetchStats);

/** Memoised per request — Overview and the Deliveries strip both ask for it. */
async function _fetchStats(): Promise<StatsResponse> {
  const base = requireEnv('DROPPY_MAIN_URL');
  const key = requireEnv('DROPPY_ADMIN_KEY');
  const k = encodeURIComponent(key);

  try {
    const fresh = await fetchStatsFrom(`${base}?action=dashboardStats&key=${k}`);
    if (fresh.success) return fresh;
  } catch {
    // fall through to the legacy endpoint
  }

  try {
    const legacy = await fetchStatsFrom(`${base}?action=admin&key=${k}&job=stats`);
    if (legacy.success) return legacy;
    return {
      ...legacy,
      success: false,
      error:
        legacy.error && legacy.error.includes('handleAdmin')
          ? 'The stats endpoint is not deployed — add apps-script-additions/3-stats.gs to your main Apps Script project and re-deploy.'
          : legacy.error
    };
  } catch (err) {
    return {
      ...(await Promise.resolve(emptyStats())),
      success: false,
      error: err instanceof Error ? err.message : 'Stats unavailable'
    };
  }
}

/** Zero-filled stats, so a failed fetch still returns a well-formed object
 *  instead of forcing every caller to null-check each field. */
function emptyStats(): StatsResponse {
  return {
    success: false,
    totalRows: 0,
    blankTracking: 0,
    blankOrderName: 0,
    blankCustomer: 0,
    blankDriveAccount: 0,
    blankDeliveryStatus: 0,
    blankVideoId: 0,
    delivered: 0,
    deliveredNoStatusDate: 0,
    deliveredNoDriveAccount: 0,
    deliveredNoFileIds: 0,
    alreadyPurged: 0,
    purgeableNow: 0,
    blankOrderNameRows: []
  };
}

/** One account's quota, never throwing — a failure becomes a well-formed
 *  unsuccessful QuotaResponse instead.
 *
 *  Exists so each storage card can be its own <Suspense> boundary and stream
 *  independently. Measured live: 9 of 10 accounts answer in ~2s while one can
 *  take 60s+ (Google-side, not ours — a single un-retried attempt). Fetching
 *  them as one batch meant every card waited on that outlier.
 *
 *  Note the shorter timeout and NO retry: an account that hasn't answered in
 *  20s isn't going to, and retrying it only doubles the wait for a card whose
 *  neighbours have long since rendered.
 */
export const fetchQuota = cache(_fetchQuota);

/**
 * Deduplicated per request by the `cache` wrapper above.
 *
 * Overview was making TWENTY Apps Script calls for ten accounts: the fleet
 * summary asks for all ten, and each of the ten cards then asks again for its
 * own. Measured against the live endpoint, a call costs the same whether it
 * returns 1 row or 200 — the sheet read dominates — so the only lever that
 * moves the number is the call COUNT, and this halves it.
 *
 * `cache` is scoped to a single request, so two components in one render share
 * an answer while the next page load still gets fresh data. That is memoisation,
 * not a cache layer: nothing outlives the request, and the sheet stays the
 * single source of truth.
 */
async function _fetchQuota(acct: StorageAccountConfig): Promise<QuotaResponse & { label: string }> {
  try {
    // 12s, down from 45s.
    //
    // Measured across the fleet: eight accounts answer in under 3.1s, one takes
    // ~10s, and two do not answer inside a minute at all. A 45s ceiling meant
    // those two held a spinner for 45 seconds before admitting defeat, and the
    // page was not usable until they did. Cutting at 12s costs nothing for the
    // eight that are fast, and turns a 45-second wait into a card that says
    // plainly that the account is not responding.
    //
    // Each card has its own Suspense boundary, so this bounds one card, never
    // the page.
    let data: QuotaResponse;
    try {
      // 25s under caching, not 12s.
      //
      // The 12s ceiling was right when every visitor paid the wait: cutting a
      // slow account loose kept the page usable. With a 60s cache that trade
      // inverts — a card that times out is now FROZEN as "unreachable" for the
      // whole window, so three slow accounts vanished from a cached page while
      // seven were fine. One visitor waiting longer once a minute is much
      // cheaper than a minute of wrong information.
      data = await fetchJsonOnce<QuotaResponse>(`${acct.url}?action=capacity`, 25_000);
    } catch (first) {
      // Google intermittently answers with an HTML error page; the same request
      // usually succeeds moments later. Reads are safe to retry — but a TIMEOUT
      // is not retried, because the second attempt would double the wait for an
      // account already known to be slow.
      if (first instanceof Error && /HTML error page|non-JSON/.test(first.message)) {
        await new Promise((r) => setTimeout(r, 800));
        data = await fetchJsonOnce<QuotaResponse>(`${acct.url}?action=capacity`, 25_000);
      } else {
        throw first;
      }
    }
    return { ...data, label: acct.label };
  } catch (err) {
    return {
      success: false,
      account: acct.label,
      label: acct.label,
      limitBytes: 0,
      usedBytes: 0,
      freeBytes: 0,
      hasRoom: false,
      error: err instanceof Error ? err.message : 'unreachable'
    };
  }
}

/** Queries every configured storage account IN PARALLEL, not one after another.
 *  Sequential awaits here would mean total load time = sum of every account's
 *  latency; Promise.allSettled means it's the SLOWEST single account instead.
 *  Uses allSettled (not all) so one dead account doesn't blank the whole card row.
 *
 *  Hits the storage script's EXISTING `capacity` action — no new endpoint, no
 *  key needed (capacity_() isn't gated by requireKey_, unlike meta/purge). */
export async function fetchAllQuotas(): Promise<Array<QuotaResponse & { label: string }>> {
  const accounts = getStorageAccounts();

  // Routed through the memoised fetchQuota rather than calling Apps Script
  // directly. Two things were wrong with doing its own fetch:
  //
  //   1. It bypassed the memoisation, so the fleet summary and the ten cards
  //      queried every account twice — twenty calls for ten accounts.
  //   2. It used fetchJson's 30s default plus a retry, so one unresponsive
  //      account could hold this for a minute, while the cards had already
  //      moved to a 12s ceiling. The live error text ("timed out after 30s")
  //      came from here, not from the card path.
  //
  // fetchQuota never throws, so allSettled is no longer needed to keep one bad
  // account from taking the rest with it.
  return Promise.all(accounts.map((acct) => fetchQuota(acct)));
}

export type AssignOrderResponse = {
  success: boolean;
  trackingId?: string;
  row?: number;
  orderName?: string;
  customerName?: string;
  written?: string[];
  error?: string;
  /** True when the order number was recorded without a Shopify lookup. */
  unverified?: boolean;
  /** Split-shipment tail, e.g. "-1-1". */
  parcel?: string;
  /** Human note explaining what an unverified save did and did not fill in. */
  note?: string;
};

/**
 * Attach an existing Shopify order to a delivery row that never got matched.
 *
 * Writes to the sheet, so it is deliberately not part of any page render path —
 * only the POST /api/assign-order route calls it.
 *
 * No retry: fetchJson's retry is safe for reads, but silently re-sending a
 * write after an ambiguous failure could double-apply it. One attempt, with a
 * long ceiling because this does a live Shopify lookup plus a sheet scan.
 */
export async function assignOrder(
  trackingId: string,
  orderName: string,
  force = false,
  /**
   * Record the order number WITHOUT asking Shopify. Only for when the token is
   * rejected: it writes Order Name alone and leaves customer/items/price blank
   * rather than guessing them.
   */
  unverified = false
): Promise<AssignOrderResponse> {
  const base = requireEnv('DROPPY_MAIN_URL');
  const key = requireEnv('DROPPY_ADMIN_KEY');
  const url =
    `${base}?action=assignOrder&key=${encodeURIComponent(key)}` +
    `&trackingId=${encodeURIComponent(trackingId)}` +
    `&orderName=${encodeURIComponent(orderName)}` +
    (force ? '&force=true' : '') +
    (unverified ? '&unverified=true' : '');

  const res = await fetchJsonOnce<AssignOrderResponse>(url, 45_000);

  // An undeployed endpoint falls through route_()'s default case, which returns
  // {status:'ok'} with no success field — that would otherwise read as a
  // silent no-op success.
  if (res && typeof res.success === 'undefined') {
    return {
      success: false,
      error:
        'The assignOrder endpoint is not deployed — add apps-script-additions/4-assignOrder.gs to your main Apps Script project and re-deploy.'
    };
  }
  if (!res.success && res.error && res.error.includes('is not defined')) {
    return {
      success: false,
      error:
        'The assignOrder endpoint is not deployed — add apps-script-additions/4-assignOrder.gs to your main Apps Script project and re-deploy.'
    };
  }
  return res;
}

export type ShopifyPingResponse = { success: boolean; shopifyOk?: boolean; shop?: string; reason?: string; error?: string };

/**
 * Is the Shopify credential alive?
 *
 * Worth its own call because a dead token breaks four things at once — order
 * matching on new deliveries, repairDeliveryRows(), dailyStatusRefresh() and
 * assignOrder — each failing in a different-looking way, so without this the
 * cause only surfaces when someone happens to try an assign.
 *
 * Never throws: a failure to even ask is reported as "not ok" with the reason,
 * since the banner is advisory and must never break a page render.
 */
export const fetchShopifyPing = cache(_fetchShopifyPing);

/** Memoised per request: the health banner and dispatch view both probe it. */
async function _fetchShopifyPing(): Promise<ShopifyPingResponse> {
  try {
    const base = requireEnv('DROPPY_MAIN_URL');
    const key = requireEnv('DROPPY_ADMIN_KEY');
    const res = await fetchJsonOnce<ShopifyPingResponse>(
      `${base}?action=shopifyPing&key=${encodeURIComponent(key)}`,
      20_000
    );
    // An undeployed endpoint falls through route_()'s default case and returns
    // {status:'ok'} with no shopifyOk — treat that as "unknown", not "broken",
    // so a stale deployment doesn't raise a false alarm about the token.
    if (typeof res.shopifyOk !== 'boolean') return { success: false };
    return res;
  } catch {
    return { success: false };
  }
}

// ---------------------------------------------------------------------------
// Dispatch — what actually left the warehouse
//
// Every parcel is now scanned at the door, which gives the dashboard something
// it could not show before. Previously a parcel only existed once it was
// DELIVERED, so "never loaded onto the van" and "loaded and lost" were
// indistinguishable — both simply absent. Joining dispatch scans against the
// delivery log on tracking ID separates them:
//
//   dispatched + delivered      the happy path
//   dispatched, not delivered   in flight, or lost — the queue worth chasing
//   delivered, not dispatched   the door scan was skipped — an audit gap
// ---------------------------------------------------------------------------

export type DispatchRow = {
  dispatchedAt: string;
  trackingId: string;
  batch: string;
  orderName: string;
  /** Parcel suffix stripped: "#Dropy-1642-1-1" -> "#Dropy-1642". */
  baseOrder: string;
  customerName: string;
  items: string;
  /** How the order was matched: shopify-tracking | app | unresolved. */
  resolvedVia: string;
  /** Shopify's own status, verbatim. */
  carrierStatus?: string;
  /**
   * Proof media exists — i.e. someone filmed it. Deliberately separate from
   * `delivered`: a proof row is created when the parcel is RECORDED, long
   * before it reaches anyone, so conflating the two would claim deliveries
   * that have not happened.
   */
  hasRecord?: boolean;
  /** Shipped per Shopify, not yet delivered. */
  inTransit?: boolean;
  /**
   * True when this parcel is one box of a multi-parcel order — and then `items`
   * describes only THAT box, never the whole order.
   */
  split?: boolean;
  /** How many parcels this order was split into. */
  parcelsInOrder?: number;
  /** When the parcel was packed — read back from the delivery log at scan time. */
  packedAt?: string;
  /** Hours between packing and dispatch: how long the parcel sat in the building. */
  hoursWaiting?: number | string;
  updatedAt: string;
  /** Computed live against the delivery log, never stored. */
  delivered: boolean;
  /** True when the parcel left the building and nothing knows its order. */
  unresolved: boolean;
};

export type DispatchSummary = {
  dispatched: number;
  /** Shopify says Delivered — NOT "we hold proof media". */
  delivered: number;
  /** Shipped per Shopify, not yet delivered. */
  inTransit?: number;
  outstanding: number;
  /**
   * We scanned it out, Shopify still says it has not shipped. The one
   * discrepancy our own scan can reveal that the carrier record cannot.
   */
  dispatchedNotShipped?: number;
  /**
   * Counted only from `auditSince`. A parcel delivered before anyone scanned
   * parcels out did not skip a step — the step did not exist yet.
   */
  deliveredNotDispatched: number;
  /** First day any parcel was scanned out; '' when nothing ever has been. */
  auditSince?: string;
  /** Mean hours packed -> dispatched. '' until something links. */
  avgHoursWaiting?: number | string;
  linkedToPacking?: number;
  splitParcels?: number;
};

export type DispatchListResponse = {
  success: boolean;
  summary: DispatchSummary;
  batch: string;
  status: string;
  searched: boolean;
  matchCount: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  rows: DispatchRow[];
  error?: string;
};

export type DispatchStatus = 'all' | 'outstanding' | 'delivered';

const EMPTY_DISPATCH_SUMMARY: DispatchSummary = {
  dispatched: 0,
  delivered: 0,
  outstanding: 0,
  deliveredNotDispatched: 0
};

/**
 * One page of dispatch scans.
 *
 * Never throws: the Dispatch tab is created by the Android app on first scan,
 * so an empty or absent sheet is a NORMAL first-run state, not a failure. It
 * resolves to an empty result the page can render as "nothing scanned out yet"
 * rather than an error banner.
 */
export async function fetchDispatchList(opts: {
  offset?: number;
  limit?: number;
  status?: DispatchStatus;
  q?: string;
  batch?: string;
} = {}): Promise<DispatchListResponse> {
  const { offset = 0, limit = 200, status = 'all', q = '', batch = '' } = opts;

  const empty: DispatchListResponse = {
    success: false,
    summary: EMPTY_DISPATCH_SUMMARY,
    batch,
    status,
    searched: Boolean(q),
    matchCount: 0,
    offset,
    limit,
    hasMore: false,
    rows: []
  };

  try {
    const base = requireEnv('DROPPY_MAIN_URL');
    const key = requireEnv('DROPPY_ADMIN_KEY');
    const url =
      `${base}?action=dispatchList&key=${encodeURIComponent(key)}` +
      `&offset=${offset}&limit=${limit}&status=${encodeURIComponent(status)}` +
      (q ? `&q=${encodeURIComponent(q)}` : '') +
      (batch ? `&batch=${encodeURIComponent(batch)}` : '');

    // Joins two sheets at request time, so it is closer to the stats scan in
    // cost than to a paged read.
    const res = await fetchJson<DispatchListResponse>(url, 55_000);

    // Apps Script answers HTTP 200 even for errors, so the body's success flag
    // is the only thing that can be trusted. An undeployed action falls through
    // route_()'s default and returns {status:'ok'} with no success field, which
    // would otherwise read as a silent empty result.
    if (typeof res.success !== 'boolean') {
      return {
        ...empty,
        error:
          'The dispatchList endpoint is not deployed — add Dispatch.gs to the main Apps Script project and re-deploy.'
      };
    }
    if (!res.success) return { ...empty, error: res.error ?? 'dispatchList failed' };

    return { ...res, summary: { ...EMPTY_DISPATCH_SUMMARY, ...(res.summary ?? {}) } };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : 'Could not reach Apps Script' };
  }
}

// ---------------------------------------------------------------------------
// Split orders — which products went into which box
//
// A multi-parcel order used to be unanswerable here: each parcel's dispatch row
// listed the WHOLE order's contents, so a three-way split read as the order
// shipping three times over, and the one record able to contradict a "my box
// was missing an item" claim was wrong in the customer's favour.
//
// splitList groups by order rather than listing parcels flat, and joins each
// parcel against both the delivery log and the dispatch log — so "has every
// piece of this order actually gone out" becomes answerable, which needs all
// three sheets at once.
// ---------------------------------------------------------------------------

export type SplitParcelItem = { title: string; sku?: string; qty?: number };

export type SplitParcel = {
  trackingId: string;
  folder?: string;
  recordedAt?: string;
  units?: number;
  /** Shopify says Delivered. */
  delivered?: boolean;
  /** Proof media exists — not the same claim as delivered. */
  hasRecord?: boolean;
  carrierStatus?: string;
  /** Our door scan, OR Shopify says it shipped. */
  dispatched?: boolean;
  items?: SplitParcelItem[];
};

export type SplitOrderRow = {
  baseOrder: string;
  parcelCount: number;
  units: number;
  lastRecordedAt?: string;
  /** Every parcel left the building. */
  allDispatched?: boolean;
  /** Every parcel Delivered per Shopify. */
  allDelivered?: boolean;

  // Present only when called with verify=1:
  verified?: boolean;
  /** What Shopify says the order contains. */
  unitsInOrder?: number;
  /**
   * Units no recorded box accounts for — either a parcel not yet shipped, or
   * one that shipped without being recorded. The direct answer to "the
   * customer says an item is missing". Negative is a data error, not a
   * missing parcel.
   */
  unitsUnaccounted?: number;
  shopifyStatus?: string;
  parcels?: SplitParcel[];
};

export type SplitSummary = {
  splitOrders: number;
  parcels: number;
  units: number;
  /** Orders cross-checked against Shopify this call. */
  verified?: number;
  /** True = hit the deadline; call again for the rest. */
  verifyStoppedEarly?: boolean;
};

export type SplitListResponse = {
  success: boolean;
  summary: SplitSummary;
  searched: boolean;
  matchCount: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  rows: SplitOrderRow[];
  error?: string;
};

export async function fetchSplitList(
  opts: { offset?: number; limit?: number; q?: string; baseOrder?: string; verify?: boolean } = {}
): Promise<SplitListResponse> {
  const { offset = 0, limit = 100, q = '', baseOrder = '', verify = false } = opts;

  const empty: SplitListResponse = {
    success: false,
    summary: { splitOrders: 0, parcels: 0, units: 0 },
    searched: Boolean(q),
    matchCount: 0,
    offset,
    limit,
    hasMore: false,
    rows: []
  };

  try {
    const base = requireEnv('DROPPY_MAIN_URL');
    const key = requireEnv('DROPPY_ADMIN_KEY');
    const url =
      `${base}?action=splitList&key=${encodeURIComponent(key)}&offset=${offset}&limit=${limit}` +
      (q ? `&q=${encodeURIComponent(q)}` : '') +
      (baseOrder ? `&baseOrder=${encodeURIComponent(baseOrder)}` : '') +
      (verify ? '&verify=1' : '');

    // verify=1 costs one Shopify call per order on the page, so it gets the
    // longest ceiling the platform allows rather than the default.
    const res = await fetchJson<SplitListResponse>(url, verify ? 110_000 : 55_000);

    // Apps Script answers 200 for everything, and an undeployed action returns
    // {status:'ok'} with no success field — which would read as an empty result.
    if (typeof res.success !== 'boolean') {
      return { ...empty, error: 'The splitList endpoint is not deployed yet.' };
    }
    if (!res.success) return { ...empty, error: res.error ?? 'splitList failed' };

    return { ...res, summary: { ...empty.summary, ...(res.summary ?? {}) } };
  } catch (err) {
    return { ...empty, error: err instanceof Error ? err.message : 'Could not reach Apps Script' };
  }
}

// ---------------------------------------------------------------------------
// §7 — Backfilling unresolved dispatch rows
//
// When Shopify is down, parcels still get scanned out and still get a row;
// they just land with no order against them. Once the credential is fixed,
// nothing would otherwise ever revisit those rows, so the unresolved count
// would stay wrong forever.
// ---------------------------------------------------------------------------

export type DispatchBackfillResponse = {
  success: boolean;
  examined?: number;
  filled?: number;
  stillUnresolved?: number;
  /** True = hit the deadline; run again for the rest. */
  stoppedEarly?: boolean;
  /** Set when nothing resolved — usually "the upstream credential is still down". */
  hint?: string;
  error?: string;
};

/**
 * Re-resolve dispatch rows that have no order.
 *
 * Bounded by both a row limit and a four-minute deadline on the Apps Script
 * side, so `stoppedEarly` is a normal outcome rather than a failure — the
 * caller re-runs while it is true.
 */
export async function runDispatchBackfill(limit = 20): Promise<DispatchBackfillResponse> {
  try {
    const base = requireEnv('DROPPY_MAIN_URL');
    const key = requireEnv('DROPPY_ADMIN_KEY');
    // No retry: this WRITES to the sheet, and a silently re-sent write after an
    // ambiguous failure could double-apply. The caller re-runs deliberately.
    const res = await fetchJsonOnce<DispatchBackfillResponse>(
      `${base}?action=dispatchBackfill&key=${encodeURIComponent(key)}&limit=${limit}`,
      110_000
    );
    if (typeof res.success !== 'boolean') {
      return { success: false, error: 'The dispatchBackfill endpoint is not deployed.' };
    }
    return res;
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Could not reach Apps Script' };
  }
}
