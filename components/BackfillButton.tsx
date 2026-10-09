'use client';

import { useState } from 'react';
import type { DispatchBackfillResponse } from '@/lib/appsScript';

// §7 — re-resolve dispatch rows that have no order.
//
// When Shopify is down, parcels still get scanned out and still get a row;
// they just land unresolved. Once the credential is fixed nothing would
// otherwise revisit them, so the count stays wrong forever. This sits next to
// the unresolved count rather than being a URL someone has to remember.
export function BackfillButton({ unresolvedCount }: { unresolvedCount: number }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DispatchBackfillResponse | null>(null);
  const [rounds, setRounds] = useState(0);

  async function run() {
    if (busy) return;
    setBusy(true);
    setResult(null);
    setRounds(0);

    try {
      let filled = 0;
      let examined = 0;
      let last: DispatchBackfillResponse | null = null;
      let passes = 0;

      // Apps Script bounds each call by a four-minute deadline, so stoppedEarly
      // is a normal outcome — keep going while it is true. Capped so a
      // permanently-stopping backend cannot spin forever.
      do {
        const res = await fetch('/api/dispatch-backfill', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ limit: 20 })
        });
        last = await res.json();
        if (!last?.success) break;

        filled += last.filled ?? 0;
        examined += last.examined ?? 0;
        passes += 1;
        setRounds(passes);
      } while (last?.stoppedEarly && passes < 10);

      setResult(last ? { ...last, filled, examined } : null);
    } catch {
      setResult({ success: false, error: 'Could not reach the dashboard server.' });
    } finally {
      setBusy(false);
    }
  }

  if (unresolvedCount === 0 && !result) return null;

  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        title="Re-resolve dispatch rows that have no order — useful once a dead Shopify credential has been fixed"
        className="rounded-lg border border-accent/30 bg-accent/10 px-2.5 py-1 text-[11px] text-accent transition-colors hover:bg-accent/20 disabled:opacity-40"
      >
        {busy ? `Re-resolving…${rounds > 1 ? ` (pass ${rounds})` : ''}` : 'Re-resolve unmatched'}
      </button>

      {result && (
        <span className="text-[11px]">
          {!result.success ? (
            <span className="text-red">{result.error ?? 'Backfill failed.'}</span>
          ) : (
            <>
              <span className={result.filled ? 'text-teal' : 'text-muted'}>
                {result.filled ?? 0} resolved
              </span>
              {typeof result.stillUnresolved === 'number' && (
                <span className="text-faint"> · {result.stillUnresolved} still unmatched</span>
              )}
              {/* The hint is the useful part when nothing resolved: it usually
                  says the upstream credential is still down. */}
              {result.hint && !result.filled && <span className="ml-1 text-amber">{result.hint}</span>}
            </>
          )}
        </span>
      )}
    </span>
  );
}
