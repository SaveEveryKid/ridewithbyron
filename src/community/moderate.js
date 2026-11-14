// Moderation for the community page. No accounts and no password, so every post is checked
// here before it is saved:
//   1. a word filter that refuses foul language outright (it sees through the usual disguises);
//   2. phone numbers and email addresses are hidden, so people arrange details privately;
//   3. posts with links are held for Byron;
//   4. an AI safety check (Cloudflare Workers AI) holds anything hostile the word list can't see.
// Nothing here is perfect on its own; the Report button and the admin tab are the backstop.

// Matched anywhere, even inside another word or split up with spaces and symbols.
const STRONG = ['fuck', 'fuk', 'fck', 'phuck', 'shit', 'sht', 'bitch', 'biatch', 'cunt', 'asshole', 'bastard', 'dickhead', 'motherf', 'bullshit', 'jackass', 'dumbass', 'douche',
  'pussy', 'whore', 'slut', 'wanker', 'twat', 'blowjob', 'handjob', 'jerkoff', 'cumshot', 'dildo', 'porn', 'nigger', 'nigga', 'faggot', 'retard', 'kike', 'chink', 'wetback', 'beaner', 'tranny', 'goddamn'];
// Only as a whole word, because they also sit inside ordinary words ("class", "cockpit", "Dickson").
const WHOLE = ['ass', 'arse', 'damn', 'dammit', 'crap', 'piss', 'pissed', 'dick', 'cock', 'tits', 'fag', 'spic', 'cum', 'hoe', 'stfu', 'wtf', 'gtfo', 'af', 'milf', 'thot', 'prick', 'skank', 'homo', 'dyke', 'coon', 'jizz', 'boner', 'horny'];
// Ordinary words that contain a STRONG string and must not be refused.
const SAFE = ['scunthorpe', 'shitake', 'shiitake', 'matsushita', 'cockpit', 'peacock', 'hancock', 'cocktail', 'bitchin'];

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', '@': 'a', $: 's', '!': 'i', '|': 'i', '+': 't', '€': 'e', '£': 'l' };

/** Lower-case, accents off, look-alike symbols turned back into letters. */
function fold(text) {
  return String(text || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[0134578@$!|+€£]/g, (c) => LEET[c] || c);
}

/**
 * The first foul word in the text, or null.
 * Two readings are checked: the words as written, and the text with everything but letters
 * removed (which catches "f u c k", "f.u.c.k" and "sh1t"). The second reading only looks for the
 * strong list, and only inside runs that were visibly split up or disguised, so that two clean
 * neighbours ("class hit") are never joined into a false match.
 */
export function foulWord(text) {
  const folded = fold(text);
  const words = folded.split(/[^a-z]+/).filter(Boolean);
  // Stretched letters are squeezed ("fuuuck", "shiiit"), keeping a doubled letter for words like "ass".
  const squeeze = (w, keep) => w.replace(/([a-z])\1+/g, keep === 2 ? '$1$1' : '$1');
  for (const w of words) {
    if (SAFE.some((s) => w.includes(s))) continue;
    for (const v of [w, squeeze(w, 2), squeeze(w, 1)]) {
      if (WHOLE.includes(v)) return v;
      // plural / -ed / -ing / -er forms of whole-word terms ("asses", "pissing", "dicks")
      const stem = v.replace(/(es|s|ed|ing|er|ers)$/, '');
      if (stem.length >= 3 && WHOLE.includes(stem)) return stem;
      const hit = STRONG.find((s) => v.includes(s));
      if (hit) return hit;
    }
  }
  // Split-up or disguised spellings: single letters or symbols strung together.
  const runs = folded.match(/(?:\b[a-z]\b[\s._\-*~,/\\]*){3,}|[a-z]*[^a-z\s][a-z]+(?:[^a-z\s]+[a-z]+)*/g) || [];
  for (const run of runs) {
    const letters = run.replace(/[^a-z]/g, '');
    if (SAFE.some((s) => letters.includes(s))) continue;
    for (const joined of [letters, squeeze(letters, 2), squeeze(letters, 1)]) {
      const hit = STRONG.find((s) => joined.includes(s));
      if (hit) return hit;
      if (WHOLE.includes(joined)) return joined;
    }
  }
  return null;
}

const PHONE = /(?:\+?1[\s.\-]?)?(?:\(\s*\d{3}\s*\)|\d{3})[\s.\-]{0,2}\d{3}[\s.\-]{0,2}\d{4}\b/g;
const EMAIL = /[a-z0-9._%+\-]+\s?(?:@|\(at\)|\[at\])\s?[a-z0-9.\-]+\.[a-z]{2,}/gi;
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9\-]+\.(?:com|net|org|io|co|us|info|biz|xyz|ly|me|tv|gg|shop|store|link|site|online)\b(?:\/\S*)?/i;

/** Phone numbers and email addresses are hidden so nobody's contact details sit on a public page. */
export function hideContacts(text) {
  return String(text || '').replace(EMAIL, '[email hidden]').replace(PHONE, '[phone hidden]');
}
export const hasLink = (text) => URL_RE.test(String(text || ''));

const tidy = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f​-‏‪-‮⁦-⁩]/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);

// Names nobody but Byron may post under.
const RESERVED = /\b(byron|admin|administrator|moderator|mod|staff|shoals\s*outdoor|ride\s*with\s*byron|official)\b/i;

/**
 * Check a post before it is saved.
 * @returns {{ok:false, field:string, message:string} | {ok:true, author:string, title:string|null, body:string, hold:string|null}}
 */
export function screenPost({ author, title, body, isTopic }) {
  const name = tidy(author, 30).replace(/\s+/g, ' ');
  const head = isTopic ? tidy(title, 100).replace(/\s+/g, ' ') : null;
  const text = tidy(body, 2000);
  if (name.length < 2) return { ok: false, field: 'author', message: 'Add a name to post under (2 letters or more).' };
  if (RESERVED.test(name)) return { ok: false, field: 'author', message: 'Please pick a different name; that one is reserved.' };
  if (isTopic && head.length < 4) return { ok: false, field: 'title', message: 'Give your topic a short title.' };
  if (text.length < 2) return { ok: false, field: 'body', message: 'Write something to post.' };
  if (/(.)\1{14,}/.test(text) || (text.length > 40 && text === text.toUpperCase() && /[A-Z]{20,}/.test(text.replace(/[^A-Z]/g, '')))) {
    return { ok: false, field: 'body', message: 'Please write it normally (no all-caps or repeated characters).' };
  }
  for (const [field, value] of [['author', name], ['title', head], ['body', text]]) {
    if (value && foulWord(value)) return { ok: false, field, message: 'Keep it clean, please. Take out the foul language and post again.' };
  }
  if (hasLink(name) || (head && hasLink(head))) return { ok: false, field: 'title', message: 'No links in names or titles, please.' };
  return {
    ok: true, author: name, title: head, body: text, // contact details are left as written: it's the poster's choice
    hold: hasLink(text) ? 'Contains a link' : null,
  };
}

/**
 * AI safety check (Cloudflare Workers AI, Llama Guard). Returns a reason to hold the post, or
 * null. If the AI is not set up or fails, the post is not blocked by it: the word filter has
 * already run and the Report button remains.
 */
export async function aiHoldReason(ai, text) {
  if (!ai || typeof ai.run !== 'function') return null;
  try {
    const out = await ai.run('@cf/meta/llama-guard-3-8b', { messages: [{ role: 'user', content: String(text).slice(0, 2500) }], max_tokens: 30, temperature: 0 });
    const r = out && typeof out === 'object' && 'response' in out ? out.response : out;
    if (r && typeof r === 'object') return r.safe === false ? `AI flagged it${Array.isArray(r.categories) && r.categories.length ? ` (${r.categories.join(', ')})` : ''}` : null;
    const s = String(r || '').trim().toLowerCase();
    if (/^unsafe\b/.test(s)) return `AI flagged it${s.replace(/^unsafe\s*/, '').trim() ? ` (${s.replace(/^unsafe\s*/, '').trim().slice(0, 30)})` : ''}`;
    return null;
  } catch {
    return null;
  }
}

/** A YouTube link (watch, share, shorts, embed or live) → its 11-character video id, or null. */
export function youtubeId(url) {
  const m = String(url || '').trim().match(/(?:youtube\.com\/(?:watch\?(?:.*&)?v=|shorts\/|embed\/|live\/)|youtu\.be\/)([A-Za-z0-9_-]{11})(?![A-Za-z0-9_-])/);
  return m ? m[1] : null;
}
