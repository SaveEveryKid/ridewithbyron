'use strict';
// Authorized-feed adapter (preferred production source once the dealership/DX1 provides one).
//
// STATUS: NOT CONNECTED. No feed URL has been issued yet. This adapter is complete and tested
// against the contract below, and activates when INVENTORY_FEED_URL is set.
//
// Contract: HTTPS GET returns JSON — either an array of units or { "units": [...] } — where every
// unit carries the source system's own location fields. Field names are matched leniently
// (DX1 exports use PascalCase), but the two location fields are mandatory per unit:
//   id (ProductGuid/Id)            stable identifier
//   dealershipId (DealershipId)    must equal the Florence id to be shown
//   locationName (DealershipName)  must equal "Shoals Outdoor Sports - Florence"
// A unit missing either field, or where they disagree, is quarantined.
const config = require('../config');
const { classifyUnit } = require('./parse');

const pick = (o, ...keys) => { for (const k of keys) { const hit = Object.keys(o).find((x) => x.toLowerCase() === k.toLowerCase()); if (hit && o[hit] != null && o[hit] !== '') return o[hit]; } return null; };
const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[$,]/g, '')); return Number.isFinite(n) && n > 0 ? Math.round(n) : null; };

function mapFeedUnit(r) {
  const guid = String(pick(r, 'id', 'guid', 'productGuid', 'productId') || '').toLowerCase() || null;
  const year = parseInt(pick(r, 'year', 'modelYear'), 10) || null;
  const make = pick(r, 'make', 'manufacturer', 'brand');
  const model = pick(r, 'model', 'modelName', 'productName');
  const images = [].concat(pick(r, 'images', 'photos', 'imageUrls') || []).map((i) => (typeof i === 'string' ? i : i && (i.url || i.Url))).filter(Boolean);
  const sold = pick(r, 'dateSold', 'hasDateSold', 'sold');
  const avail = pick(r, 'availability', 'status');
  const dealershipId = String(pick(r, 'dealershipId', 'locationId') || '').toLowerCase();
  return {
    guid, sourceUrl: pick(r, 'url', 'detailUrl', 'productUrl') || `${config.source.baseUrl}/Model-Details/ProductGuid/${guid}`,
    title: pick(r, 'title', 'name') || [year, make, model].filter(Boolean).join(' ') || null,
    year, make, model,
    condition: /used|pre/i.test(String(pick(r, 'condition', 'usage') || '')) ? 'Used' : 'New',
    stockNumber: pick(r, 'stockNumber', 'stock', 'sku'), vin: pick(r, 'vin', 'hin'), vinLabel: pick(r, 'vin') ? 'VIN' : pick(r, 'hin') ? 'HIN' : null,
    category: pick(r, 'category', 'productType'), modelType: pick(r, 'modelType', 'subCategory', 'type'), modelCode: pick(r, 'modelCode', 'mpn'),
    color: pick(r, 'color', 'primaryColor'),
    price: num(pick(r, 'salePrice', 'price', 'advertisedPrice')), msrp: num(pick(r, 'msrp', 'retailPrice')),
    onSale: !!pick(r, 'onSale', 'isOnSale'), priceLabel: null, priceNote: pick(r, 'priceNote', 'additionalPriceText'), promoBanner: null, payment: null,
    headline: null, description: pick(r, 'description', 'comments'),
    specs: Array.isArray(pick(r, 'specs', 'specifications')) ? pick(r, 'specs', 'specifications') : [],
    features: Array.isArray(pick(r, 'features')) ? [{ group: 'Features', items: pick(r, 'features').map(String) }] : [],
    options: [].concat(pick(r, 'options', 'accessories') || []).map(String),
    images,
    keySpecs: { seats: parseInt(pick(r, 'seatingCapacity', 'seats'), 10) || null, horsepower: pick(r, 'horsepower'), engine: pick(r, 'engine'), displacement: pick(r, 'displacement'), towing: pick(r, 'towingCapacity'), payload: pick(r, 'payloadCapacity'), groundClearance: pick(r, 'groundClearance') },
    evidence: {
      locationName: pick(r, 'locationName', 'dealershipName', 'location'),
      // In a feed, the dealership id is an explicit field rather than something inferred from photo paths.
      imageDealershipIds: dealershipId ? [dealershipId] : [],
      availabilityText: sold && sold !== '0' && sold !== 0 && sold !== false ? 'Sold' : (avail ? String(avail) : 'In Stock'),
      feed: true,
    },
  };
}

/** Feed units must carry BOTH location fields; classifyUnit handles agreement/conflict. */
function classifyFeedUnit(unit) {
  if (!unit.evidence.imageDealershipIds.length) return { status: 'quarantined', reason: 'Feed record has no dealership id' };
  if (!unit.evidence.locationName) return { status: 'quarantined', reason: 'Feed record has no location name' };
  return classifyUnit(unit, config.source);
}

async function fetchFeed(fetchImpl = fetch) {
  const url = process.env.INVENTORY_FEED_URL;
  if (!url) throw new Error('INVENTORY_FEED_URL is not set — the authorized feed is not connected');
  const headers = { Accept: 'application/json', 'User-Agent': config.source.userAgent };
  if (process.env.INVENTORY_FEED_TOKEN) headers.Authorization = `Bearer ${process.env.INVENTORY_FEED_TOKEN}`;
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`Feed returned HTTP ${res.status}`);
  const json = await res.json();
  const list = Array.isArray(json) ? json : json.units || json.items || json.data;
  if (!Array.isArray(list)) throw new Error('Feed is not a JSON array of units');
  return list.map(mapFeedUnit);
}

module.exports = { mapFeedUnit, classifyFeedUnit, fetchFeed };
