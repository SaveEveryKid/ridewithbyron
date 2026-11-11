'use strict';
// Parsers for the DX1 dealer website (sitemap + unit detail pages).
// Pure functions: HTML/XML in, plain objects out. Nothing here invents data —
// a field that is not on the page stays null/empty.
const cheerio = require('cheerio');

const GUID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const clean = (s) => (s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
const money = (s) => {
  const m = clean(s).match(/\$\s*([\d,]+(?:\.\d{1,2})?)/);
  return m ? Math.round(parseFloat(m[1].replace(/,/g, ''))) : null;
};

/** An anti-bot / WAF interstitial instead of real content. We never try to solve these. */
function isChallengePage(status, body) {
  return /Azure WAF|JS Challenge|captcha-delivery|cf-challenge|Attention Required/i.test((body || '').slice(0, 4000)) ||
    ((status === 403 || status === 429) && !/model-location|<urlset/i.test(body || ''));
}

/** Sitemap -> [{ guid, url, lastmod }] for unit detail pages only. */
function parseSitemap(xml) {
  if (!/<urlset[\s>]/.test(xml)) throw new Error('Sitemap response is not a <urlset> document');
  const out = new Map();
  for (const block of xml.match(/<url>[\s\S]*?<\/url>/g) || []) {
    const loc = (block.match(/<loc>([^<]+)<\/loc>/) || [])[1];
    if (!loc) continue;
    const url = loc.trim().replace(/&amp;/g, '&');
    const g = url.match(GUID);
    if (!g) continue;
    out.set(g[1].toLowerCase(), {
      guid: g[1].toLowerCase(), url,
      lastmod: (block.match(/<lastmod>([^<]+)<\/lastmod>/) || [])[1] || null,
    });
  }
  return [...out.values()];
}

function specText($, el) {
  const $el = $(el);
  const ps = $el.find('p');
  if (ps.length) return ps.map((i, p) => clean($(p).text())).get().filter(Boolean).join(' · ');
  return clean($el.text());
}

/**
 * Unit detail page -> normalized unit record, including the raw location evidence.
 * @param {string} html
 * @param {string} url the URL that was requested (stable GUID at the end)
 */
function parseUnitPage(html, url) {
  const $ = cheerio.load(html);
  const guid = ((url || '').match(GUID) || [])[1];
  const ld = (() => {
    let found = null;
    $('script[type="application/ld+json"]').each((i, s) => {
      try {
        const d = JSON.parse($(s).contents().text());
        for (const g of d['@graph'] || [d]) if (g && g['@type'] === 'Product') found = g;
      } catch (e) { /* ignore malformed blocks */ }
    });
    return found || {};
  })();

  // --- header detail rows (Condition / Stock Number / VIN / ...)
  const details = {};
  $('.details-specs > div').each((i, row) => {
    const k = clean($(row).find('.spec-title').first().text());
    const v = clean($(row).find('.spec-info').first().text());
    if (k && v) details[k] = v;
  });

  // --- location evidence (authoritative fields only)
  const locationName = clean($('.model-location .location').first().text()) || null;
  const availabilityText = clean($('.model-availability').first().text()).replace(/^Availability:\s*/i, '') || null;
  const imageDealershipIds = [...new Set(
    [...html.matchAll(/products-private\/prod\/[0-9a-f-]{36}\/([0-9a-f-]{36})\//gi)].map((m) => m[1].toLowerCase())
  )];

  // --- price
  const $price = $('.model-price').first();
  const priceLabel = clean($price.find('.advertised-price .replace-text').first().text()) || null;
  const priceShown = money($price.find('.advertised-price h3.price').first().text());
  const msrpBlock = clean($price.find('.msrp').first().text());
  const retailPrice = money(msrpBlock);
  const isMsrpOnly = /^msrp$/i.test(priceLabel || '');
  const price = isMsrpOnly ? null : priceShown;
  const msrp = isMsrpOnly ? priceShown : retailPrice;
  const onSale = /on sale/i.test(clean($price.find('.showroom-flag').first().text())) || /on sale/i.test(priceLabel || '');
  const priceNote = clean($price.find('.price-extras').first().text()) || null;
  const promoBanner = clean($price.find('.btn-promo-text').first().text()) || null;
  const payment = clean($price.find('.estimated-monthly-payment').first().text());
  const paymentTerms = clean($price.find('.monthly-payment-desc').first().text());

  // --- specs, features, options
  const specs = [];
  $('#specifications h3.group-title').each((i, h) => {
    const rows = [];
    $(h).nextAll('.csstable').first().find('.spec-title').each((j, t) => {
      const k = clean($(t).text());
      const v = specText($, $(t).closest('.th').next('.td').find('.spec-info').first());
      if (k && v) rows.push([k, v]);
    });
    if (rows.length) specs.push({ group: clean($(h).text()), rows });
  });
  const features = [];
  $('#features h3.feature-title').each((i, h) => {
    const items = $(h).nextAll('ul.features-list').first().find('li').map((j, li) => clean($(li).text())).get().filter(Boolean);
    if (items.length) features.push({ group: clean($(h).text()), items });
  });
  if (!features.length) {
    const items = $('#features ul.features-list li').map((j, li) => clean($(li).text())).get().filter(Boolean);
    if (items.length) features.push({ group: 'Features', items });
  }
  const options = [];
  $('#options').find('li, .spec-title').each((i, el) => {
    const $el = $(el);
    const k = clean($el.text());
    const v = $el.is('.spec-title') ? specText($, $el.closest('.th').next('.td').find('.spec-info').first()) : '';
    if (k) options.push(v ? `${k}: ${v}` : k);
  });

  // --- photos (full size first; thumbnails derive from the same path)
  const images = [];
  const pushImg = (src) => {
    if (!src || !/\.(jpe?g|png|webp)(\?|$)/i.test(src)) return;
    let u = src.startsWith('//') ? 'https:' + src : src;
    u = u.replace(/_\d+px(\.\w+)$/, '$1');
    if (/cdpcdn\.dx1app\.com\/products/.test(u) && !images.includes(u)) images.push(u);
  };
  $('#slideshow-detail img, #modelphotos img').each((i, img) => pushImg($(img).attr('data-src') || $(img).attr('src')));
  if (!images.length && ld.image) pushImg(ld.image);

  // --- description
  const headline = clean($('.model-description h3, .model-description h2, .model-description .title').first().text()) || null;
  const descHtml = $('.model-description .description').first();
  const description = descHtml.length
    ? descHtml.text().split('\n').map(clean).filter(Boolean).join('\n')
    : (clean(ld.description) || null);

  const h1 = clean($('h1').first().text()).replace(/\s+for Sale$/i, '');
  const title = clean(ld.name) || h1 || null;
  const year = parseInt(ld.productionDate || (title || '').slice(0, 4), 10) || null;
  const make = clean(ld.brand && ld.brand.name) || null;
  const model = clean(ld.model) || null;
  const conditionRaw = details['Condition'] || (/UsedCondition/.test(JSON.stringify(ld.offers || {})) ? 'Used' : null);

  // pull the well-known spec values customers filter on (verbatim strings, never computed)
  const flat = specs.flatMap((g) => g.rows);
  const findSpec = (re) => { const r = flat.find(([k]) => re.test(k)); return r ? r[1] : null; };
  const seatingText = findSpec(/^(seating capacity|person capacity|passenger capacity|maximum capacity|seating)$/i) || findSpec(/person capacity|seating capacity/i);
  const seats = seatingText && (seatingText.match(/\b(\d{1,2})\b/) || [])[1] ? parseInt(seatingText.match(/\b(\d{1,2})\b/)[1], 10) : null;

  return {
    guid: guid ? guid.toLowerCase() : null,
    sourceUrl: url,
    title, year, make, model,
    condition: conditionRaw ? (/used|pre-?owned/i.test(conditionRaw) ? 'Used' : 'New') : null,
    stockNumber: details['Stock Number'] || clean(ld.sku) || null,
    vin: details['VIN'] || details['HIN'] || null,
    vinLabel: details['VIN'] ? 'VIN' : details['HIN'] ? 'HIN' : null,
    category: details['Category'] || clean(ld.category) || null,
    modelType: details['Model Type'] || null,
    modelCode: details['Model Code'] || clean(ld.mpn) || null,
    color: details['Color'] || clean(ld.color) || null,
    price, msrp, onSale, priceLabel, priceNote, promoBanner,
    payment: payment ? `${payment}${paymentTerms ? ' · ' + paymentTerms : ''}` : null,
    headline, description, specs, features, options, images,
    keySpecs: {
      engine: findSpec(/^engine type$/i) || findSpec(/^engine$/i),
      displacement: findSpec(/displacement/i),
      horsepower: findSpec(/horsepower|^hp$/i),
      seating: seatingText, seats,
      groundClearance: findSpec(/ground clearance/i),
      towing: findSpec(/tow(ing)? (capacity|rating)|hitch towing/i),
      payload: findSpec(/payload/i),
      bedCapacity: findSpec(/(box|bed) capacity/i),
      length: findSpec(/^length$/i), width: findSpec(/^width$/i), height: findSpec(/^height$/i),
      weight: findSpec(/^weight$|dry weight/i),
      drive: findSpec(/drive (system|type)|driveline/i),
      fuelCapacity: findSpec(/fuel capacity/i),
    },
    evidence: { locationName, availabilityText, imageDealershipIds },
  };
}

/**
 * The Florence gate. Returns one of:
 *  active          – verified Florence, in stock  -> may be shown
 *  other_location  – verified as belonging to another store -> never shown
 *  catalog         – manufacturer model page, not a stocked unit -> never shown
 *  unavailable     – Florence unit page that no longer says In Stock -> hidden
 *  quarantined     – location could not be verified / evidence conflicts -> hidden, flagged in admin
 */
function classifyUnit(unit, { florenceLocationName, florenceDealershipId }) {
  const ev = unit.evidence || {};
  const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const nameIsFlorence = !!ev.locationName && norm(ev.locationName) === norm(florenceLocationName);
  const ids = ev.imageDealershipIds || [];
  const idsFlorence = ids.length > 0 && ids.every((id) => id === florenceDealershipId.toLowerCase());
  const idsOther = ids.length > 0 && ids.every((id) => id !== florenceDealershipId.toLowerCase());
  const inStock = /^in stock$/i.test(ev.availabilityText || '');

  if (!unit.guid) return { status: 'quarantined', reason: 'No stable source identifier in URL' };
  // A manufacturer catalog page: no stock number and no availability line.
  if (!unit.stockNumber && !ev.availabilityText) return { status: 'catalog', reason: 'Catalog model page (no stock number, no availability)' };
  if (!ev.locationName) return { status: 'quarantined', reason: 'Location field missing on source page' };
  if (!nameIsFlorence) {
    if (idsFlorence) return { status: 'quarantined', reason: `Conflict: page says "${ev.locationName}" but photos carry the Florence dealership id` };
    return { status: 'other_location', reason: `Source location: ${ev.locationName}` };
  }
  // Name says Florence from here on.
  if (idsOther) return { status: 'quarantined', reason: 'Conflict: page says Florence but photos carry another dealership id' };
  if (ids.length > 1 && !idsFlorence) return { status: 'quarantined', reason: 'Conflict: photos carry mixed dealership ids' };
  if (!unit.stockNumber) return { status: 'quarantined', reason: 'Florence page without a stock number' };
  if (!unit.title || !unit.make) return { status: 'quarantined', reason: 'Missing title/manufacturer on source page' };
  if (!inStock) return { status: 'unavailable', reason: `Availability on source: ${ev.availabilityText || 'not stated'}` };
  return { status: 'active', reason: idsFlorence ? 'Location name + dealership id verified' : 'Location name verified (stock photos carry no dealership id)' };
}

module.exports = { parseSitemap, parseUnitPage, classifyUnit, isChallengePage, GUID };
