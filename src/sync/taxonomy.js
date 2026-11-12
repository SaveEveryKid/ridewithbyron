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
  // Looks at the category and the subtype together, so it works whichever field carries which.
  const both = `${u.category || ''} | ${u.modelType || ''}`.toLowerCase();
  const model = (u.model || '').toLowerCase();
  if (/pontoon|tritoon/.test(both) || /pontoon/.test(model)) return 'Pontoons';
  if (/\bengines?\b|outboard motors?\b/.test(both)) return 'Outboard Motors';
  if (/watercraft|pwc/.test(both)) return 'Personal Watercraft';
  if (/\batvs?\b/.test(both)) return 'ATVs';
  if (/utility vehicle|side.by.side|\butvs?\b/.test(both)) return 'Side-by-Sides';
  if (/boat/.test(both)) return 'Boats';
  if (/trailer/.test(both)) return 'Trailers';
  if (/mower|lawn|zero turn/.test(both)) return 'Mowers';
  if (/motorcycle|scooter|motocross/.test(both)) return 'Motorcycles';
  if (/golf/.test(both)) return 'Golf Carts';
  if (/snowmobile/.test(both)) return 'Snowmobiles';
  return 'Other';
}

function family(u) {
  if (/polaris/i.test(u.make || '')) {
    if (YOUTH.test(u.model || '') || /\byouth\b/i.test(u.modelType || '')) return 'Youth';
    for (const [name, re] of POLARIS_FAMILIES) if (re.test(u.model || '')) return name;
  }
  return null;
}

function unitSlug(u) {
  const base = slugify([u.year, u.make, u.model].filter(Boolean).join(' ')).slice(0, 80);
  return `${base}-${slugify(u.stockNumber || '') || u.guid.slice(0, 8)}-${u.guid.slice(0, 6)}`;
}

export { slugify, vehicleType, family, unitSlug };
