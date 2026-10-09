import { fetchShopifyPing } from '@/lib/appsScript';

// Shopify is the one upstream credential this system depends on, and it fails
// silently: when the token dies, order matching, row repair, the daily status
// refresh and order assignment all stop, each surfacing as a different-looking
// symptom.
//
// It belongs on the dispatch view specifically because a dead token is the most
// likely cause of a sudden run of unresolved parcels — a parcel that physically
// left the building with nothing knowing its order. Connecting those two facts
// on one screen is the difference between a five-minute fix and an afternoon
// of debugging.
//
// Velocity (the AWB lookup for split parcels) was a second credential probed
// here; the integration has been removed, so a split parcel Shopify never saw
// now stays unresolved until someone assigns it by hand rather than being
// looked up automatically.
export async function UpstreamHealth() {
  const shopify = await fetchShopifyPing();
  const shopifyDown = shopify.success && shopify.shopifyOk === false;

  if (!shopifyDown) {
    // Healthy: one quiet line. A banner that is always present stops being read,
    // and the useful signal here is the exception, not the steady state.
    return (
      <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-faint">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 rounded-full bg-teal" aria-hidden />
          Shopify connected{shopify.shop ? ` · ${shopify.shop}` : ''}
        </span>
      </p>
    );
  }

  return (
    <div className="rounded-xl border border-red/30 bg-red/[0.05] px-3 py-2.5">
      <div className="text-xs font-semibold text-red">Shopify is not accepting the API token</div>
      <p className="mt-1 text-[11px] leading-snug text-muted">
        {shopify.reason} Order matching, row repair and status refresh are all stopped — this is the most likely
        reason parcels below show as <span className="font-medium">unresolved</span>.
      </p>
    </div>
  );
}
