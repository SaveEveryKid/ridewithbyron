'use strict';
// Shopping taxonomy derived from the source's own fields (category, model type, model name).
// Categories shown on the site are built from whatever Florence actually has in stock.

const slugify = (s) => (s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Model-family detection uses the leading words of the source's model name.
const POLARIS_FAMILIES = [
  ['XPEDITION', /^(polaris\s+)?xpedition\b/i],
  ['Ranger', /^ranger\b/i],
  ['RZR', /^rzr\b/i],
  ['GENERAL', /^general\b/i],
  ['Sportsman', /^sportsman\b/i],
  ['Scrambler', /^scrambler\b/i],
  ['Outlaw', /^outlaw\b/i],
];
const YOUTH = /\b(outlaw\s*(70|110)|sportsman\s*110|rzr\s*200|ranger\s*150|youth)\b/i;

function vehicleType(u) {
  const cat = (u.category || '').toLowerCase();
  const mt = (u.modelType || '').toLowerCase();
  const model = (u.model || '').toLowerCase();
  if (/pontoon|tritoon/.test(mt) || /pontoon/.test(cat) || /pontoon/.test(model)) return 'Pontoons';
  if (/boat/.test(cat)) return 'Boats';
  if (/watercraft|pwc/.test(cat)) return 'Personal Watercraft';
  if (/utility vehicle|side.by.side|utv/.test(cat)) return 'Side-by-Sides';
  if (/atv/.test(cat)) return 'ATVs';
  if (/trailer/.test(cat)) return 'Trailers';
  if (/mower|lawn/.test(cat)) return 'Mowers';
  if (/motorcycle|scooter/.test(cat)) return 'Motorcycles';
  if (/golf/.test(cat)) return 'Golf Carts';
  if (/engine|motor/.test(cat)) return 'Outboard Motors';
  return u.category || 'Other';
}

function family(u) {
  if (/polaris/i.test(u.make || '')) {
    if (YOUTH.test(u.model || '')) return 'Youth';
    for (const [name, re] of POLARIS_FAMILIES) if (re.test(u.model || '')) return name;
  }
  return null;
}

function unitSlug(u) {
  const base = slugify([u.year, u.make, u.model].filter(Boolean).join(' ')).slice(0, 80);
  return `${base}-${slugify(u.stockNumber || '') || u.guid.slice(0, 8)}-${u.guid.slice(0, 6)}`;
}

module.exports = { slugify, vehicleType, family, unitSlug };
