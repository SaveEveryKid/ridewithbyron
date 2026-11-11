// The Florence gate: the only place that decides whether a unit may be shown publicly.

/** An anti-bot / WAF interstitial instead of real content. We never try to solve these. */
export function isChallengePage(status, body) {
  return /Azure WAF|JS Challenge|captcha-delivery|cf-challenge|Attention Required/i.test((body || '').slice(0, 4000)) ||
    ((status === 403 || status === 429) && !/showroom-search--config/i.test(body || ''));
}

/**
 * Returns one of:
 *  active          – verified Florence, in stock  -> may be shown
 *  other_location  – verified as belonging to another store -> never shown
 *  catalog         – manufacturer model entry, not a stocked unit -> never shown
 *  unavailable     – Florence unit that is no longer in stock -> hidden
 *  quarantined     – location could not be verified / evidence conflicts -> hidden, flagged in admin
 *
 * Evidence comes from the source system's own fields only: the dealership name on the record and the
 * dealership id embedded in the unit's private photo paths. URL slugs and page titles are never used
 * (the same unit appears as "Florence-AL" or "Tuscumbia-AL" depending on which site serves it).
 */
export function classifyUnit(unit, { florenceLocationName, florenceDealershipId }) {
  const ev = unit.evidence || {};
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const F = florenceDealershipId.toLowerCase();
  const nameIsFlorence = !!ev.locationName && norm(ev.locationName) === norm(florenceLocationName);
  const ids = ev.imageDealershipIds || [];
  const idsFlorence = ids.length > 0 && ids.every((id) => id === F);
  const idsOther = ids.length > 0 && ids.every((id) => id !== F);
  const inStock = /^in stock$/i.test(ev.availabilityText || '');

  if (!unit.guid) return { status: 'quarantined', reason: 'No stable source identifier' };
  if (!unit.stockNumber && !ev.availabilityText) return { status: 'catalog', reason: 'Catalog model entry (no stock number, no availability)' };
  if (!ev.locationName) return { status: 'quarantined', reason: 'Location field missing on source record' };
  if (!nameIsFlorence) {
    if (idsFlorence) return { status: 'quarantined', reason: `Conflict: record says "${ev.locationName}" but photos carry the Florence dealership id` };
    return { status: 'other_location', reason: `Source location: ${ev.locationName}` };
  }
  if (idsOther) return { status: 'quarantined', reason: 'Conflict: record says Florence but photos carry another dealership id' };
  if (ids.length > 1 && !idsFlorence) return { status: 'quarantined', reason: 'Conflict: photos carry mixed dealership ids' };
  if (!unit.stockNumber) return { status: 'quarantined', reason: 'Florence record without a stock number' };
  if (!unit.title || !unit.make) return { status: 'quarantined', reason: 'Missing title/manufacturer on source record' };
  if (!inStock) return { status: 'unavailable', reason: `Availability on source: ${ev.availabilityText || 'not stated'}` };
  return { status: 'active', reason: idsFlorence ? 'Location name + dealership id verified' : 'Location name verified (stock photos carry no dealership id)' };
}
