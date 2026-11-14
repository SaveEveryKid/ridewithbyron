// Community page data: ride videos, topics and replies, reports, blocks, video submissions.
import { config } from '../config.js';
import { q, now, getSetting, setSetting, logError } from '../db.js';
import { screenPost, aiHoldReason } from './moderate.js';

export const PAGE_SIZE = 20;
const REPORTS_TO_HIDE = 3;
const MAX_DEPTH = 3;

const enc = new TextEncoder();
const sha = async (s) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
/** Who posted, without storing anything personal: a hash of their browser's token and of their address. */
export const visitorKey = (token) => sha(`rwb-visitor|${token}`);
export const ipKey = (ip) => sha(`rwb-ip|${config.adminPassword}|${ip}`);
export const newToken = () => [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(16).padStart(2, '0')).join('');

// ---------------- reading
export async function listVideos(all = false) {
  return q.all(`SELECT * FROM community_videos ${all ? '' : 'WHERE hidden=0'} ORDER BY id DESC LIMIT 60`);
}

export async function listTopics(page = 1) {
  const total = (await q.get("SELECT COUNT(*) n FROM community_posts WHERE parent_id IS NULL AND status='live'")).n;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const at = Math.min(Math.max(1, page), pages);
  const topics = await q.all(`SELECT p.*, (SELECT COUNT(*) FROM community_posts r WHERE r.topic_id=p.id AND r.parent_id IS NOT NULL AND r.status='live') replies
    FROM community_posts p WHERE p.parent_id IS NULL AND p.status='live' ORDER BY p.last_activity DESC LIMIT ? OFFSET ?`, [PAGE_SIZE, (at - 1) * PAGE_SIZE]);
  return { topics, total, page: at, pages };
}

/** A topic with its live replies as a tree (replies deeper than three levels sit at the third). */
export async function getTopic(id) {
  const topic = await q.get("SELECT * FROM community_posts WHERE id=? AND parent_id IS NULL AND status='live'", [id]);
  if (!topic) return null;
  const rows = await q.all("SELECT * FROM community_posts WHERE topic_id=? AND parent_id IS NOT NULL AND status='live' ORDER BY id ASC LIMIT 500", [id]);
  // Rows come oldest first, so a reply's parent is always placed before it.
  const byId = new Map();
  const top = [];
  for (const r of rows) {
    const node = { ...r, children: [], depth: 1, siblings: top };
    const parent = byId.get(r.parent_id);
    if (parent && parent.depth < MAX_DEPTH) { node.depth = parent.depth + 1; node.siblings = parent.children; }
    else if (parent) { node.depth = MAX_DEPTH; node.siblings = parent.siblings; node.replyingTo = parent.author; }
    node.siblings.push(node);
    byId.set(r.id, node);
  }
  return { topic, replies: top, count: rows.length };
}

export const liveTopicIds = () => q.all("SELECT id, last_activity FROM community_posts WHERE parent_id IS NULL AND status='live' ORDER BY last_activity DESC LIMIT 2000");

// ---------------- posting
export async function isBlocked(visitor, ipk) {
  return !!(await q.get('SELECT 1 ok FROM community_blocks WHERE who IN (?,?)', [visitor || '-', ipk || '-']));
}
/** Someone whose earlier post is on the page (so their posts no longer wait for approval). */
export async function knownPoster(visitor) {
  return !!visitor && !!(await q.get("SELECT 1 ok FROM community_posts WHERE visitor=? AND status='live' AND approved=1 LIMIT 1", [visitor]));
}

/**
 * Save a post after every check has run.
 * @returns {{ok:false, field?:string, message:string} | {ok:true, id:number, topicId:number, status:'live'|'held'}}
 */
export async function createPost({ author, title, body, parentId, visitor, ipk, staff = false, ai = null }) {
  let parent = null;
  if (parentId) {
    parent = await q.get("SELECT id, topic_id, parent_id, locked, status FROM community_posts WHERE id=?", [parentId]);
    if (!parent || parent.status !== 'live') return { ok: false, message: 'That post is no longer here.' };
    const topic = parent.parent_id ? await q.get('SELECT locked, status FROM community_posts WHERE id=?', [parent.topic_id]) : parent;
    if (!topic || topic.status !== 'live') return { ok: false, message: 'That topic is no longer here.' };
    if (topic.locked) return { ok: false, message: 'This topic is closed to new replies.' };
  }
  const isTopic = !parent;
  let clean;
  let hold = null;
  if (staff) {
    clean = { author: 'Byron Green', title: isTopic ? String(title || '').trim().slice(0, 100) : null, body: String(body || '').trim().slice(0, 2000) };
    if (!clean.body || (isTopic && !clean.title)) return { ok: false, message: 'Add a title and a message.' };
  } else {
    if (await isBlocked(visitor, ipk)) return { ok: false, message: 'Posting is turned off for you on this page.' };
    const s = screenPost({ author, title, body, isTopic });
    if (!s.ok) return s;
    clean = s;
    hold = s.hold
      || (await aiHoldReason(ai, `${s.title ? s.title + '\n' : ''}${s.body}`))
      || ((await knownPoster(visitor)) ? null : 'First post from this person');
    // The same words posted twice in a row by the same person is a double-tap or spam.
    const last = await q.get('SELECT body FROM community_posts WHERE visitor=? ORDER BY id DESC LIMIT 1', [visitor]);
    if (last && last.body === clean.body) return { ok: false, message: 'You already posted that.' };
  }
  const t = now();
  const status = hold ? 'held' : 'live';
  const topicId = parent ? parent.topic_id : null;
  const r = await q.run(`INSERT INTO community_posts(topic_id,parent_id,title,author,body,created_at,status,hold_reason,visitor,ipk,staff,approved,last_activity)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`, [topicId, parent ? parent.id : null, clean.title, clean.author, clean.body, t, status, hold, visitor || null, ipk || null, staff ? 1 : 0, 0, t]);
  const id = r.lastId;
  if (isTopic) await q.run('UPDATE community_posts SET topic_id=? WHERE id=?', [id, id]);
  else if (status === 'live') await q.run('UPDATE community_posts SET last_activity=? WHERE id=?', [t, topicId]);
  if (status === 'held') await alertByron(`A community post is waiting for your OK (${hold.toLowerCase()}).`);
  return { ok: true, id, topicId: topicId || id, status, held: hold };
}

// ---------------- reporting
/** A visitor flags a post. A few different visitors hide it until Byron looks. */
export async function reportPost(postId, visitor) {
  const post = await q.get("SELECT id, staff, status FROM community_posts WHERE id=?", [postId]);
  if (!post || post.status !== 'live') return false;
  await q.run('INSERT OR IGNORE INTO community_reports(post_id, visitor, at) VALUES(?,?,?)', [postId, visitor, now()]);
  const n = (await q.get('SELECT COUNT(*) n FROM community_reports WHERE post_id=?', [postId])).n;
  await q.run('UPDATE community_posts SET reports=? WHERE id=?', [n, postId]);
  if (n >= REPORTS_TO_HIDE && !post.staff) {
    await q.run("UPDATE community_posts SET status='held', hold_reason=? WHERE id=? AND status='live'", [`Reported by ${n} people`, postId]);
    await alertByron(`A community post was reported by ${n} people and is hidden until you look.`);
  } else if (n === 1) await alertByron('A community post was reported. Have a look when you can.');
  return true;
}

// ---------------- Byron's controls
export async function moderate(postId, action) {
  const post = await q.get('SELECT * FROM community_posts WHERE id=?', [postId]);
  if (!post) return;
  if (action === 'approve') {
    await q.batch([
      ["UPDATE community_posts SET status='live', hold_reason=NULL, approved=1, reports=0 WHERE id=?", [postId]],
      ['DELETE FROM community_reports WHERE post_id=?', [postId]],
      ['UPDATE community_posts SET last_activity=? WHERE id=?', [now(), post.topic_id || postId]],
    ]);
  } else if (action === 'remove') {
    // Removing a topic takes its replies with it; removing a reply takes the replies under it.
    await q.run(post.parent_id ? "UPDATE community_posts SET status='removed' WHERE id=? OR parent_id=?" : "UPDATE community_posts SET status='removed' WHERE id=? OR topic_id=?", [postId, postId]);
  } else if (action === 'lock' || action === 'unlock') {
    await q.run('UPDATE community_posts SET locked=? WHERE id=? AND parent_id IS NULL', [action === 'lock' ? 1 : 0, postId]);
  } else if (action === 'block') {
    const w = [];
    for (const who of [post.visitor, post.ipk]) if (who) w.push(['INSERT OR IGNORE INTO community_blocks(who, at, note) VALUES(?,?,?)', [who, now(), `Blocked from post #${postId} by ${post.author}`]]);
    // Everything that person posted comes down with them.
    w.push(["UPDATE community_posts SET status='removed' WHERE staff=0 AND (visitor=? OR ipk=?)", [post.visitor || '-', post.ipk || '-']]);
    await q.batch(w);
  }
}
/** A post that passed the filters and went straight up counts as approved once it has stood unreported. */
export async function settlePosts() {
  await q.run("UPDATE community_posts SET approved=1 WHERE approved=0 AND status='live' AND reports=0 AND created_at < ?", [new Date(Date.now() - 3600e3).toISOString()]);
}

export async function addVideo({ youtubeId, title, credit }) {
  await q.run('INSERT INTO community_videos(youtube_id,title,credit,created_at,hidden) VALUES(?,?,?,?,0)', [youtubeId, String(title || '').trim().slice(0, 100), String(credit || '').trim().slice(0, 60), now()]);
}
export const removeVideo = (id) => q.run('DELETE FROM community_videos WHERE id=?', [id]);

export async function addSubmission({ name, contact, url, note }) {
  await q.run("INSERT INTO community_submissions(created_at,name,contact,url,note,status) VALUES(?,?,?,?,?,'new')", [now(), name, contact, url, note]);
  await alertByron(`${name} sent in a ride video for the community page.`);
}

export async function adminData() {
  const [held, recent, videos, submissions, blocks, counts] = await Promise.all([
    q.all("SELECT * FROM community_posts WHERE status='held' ORDER BY id DESC LIMIT 100"),
    q.all("SELECT * FROM community_posts WHERE status='live' ORDER BY id DESC LIMIT 100"),
    listVideos(true),
    q.all('SELECT * FROM community_submissions ORDER BY id DESC LIMIT 60'),
    q.get('SELECT COUNT(*) n FROM community_blocks'),
    q.all('SELECT status, COUNT(*) n FROM community_posts GROUP BY status'),
  ]);
  return { held, recent, videos, submissions, blocks: blocks.n, counts: Object.fromEntries(counts.map((c) => [c.status, c.n])) };
}

// ---------------- telling Byron (a text through Torque, at most one every 15 minutes)
export async function alertByron(text, fetchImpl = fetch) {
  try {
    const base = config.torque.webhookUrl;
    if (!base || !config.torque.signingSecret) return false;
    const last = getSetting('community_last_alert', null);
    if (last && Date.now() - new Date(last).getTime() < 15 * 60000) return false;
    await setSetting('community_last_alert', now());
    const body = JSON.stringify({ text: `RideWithByron community: ${text}`.slice(0, 300) });
    const ts = Math.floor(Date.now() / 1000).toString();
    const key = await crypto.subtle.importKey('raw', enc.encode(config.torque.signingSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(`${ts}.${body}`)))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const res = await fetchImpl(base.replace(/\/leads\/intake\/?$/, '/leads/alert'), { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-RWB-Timestamp': ts, 'X-RWB-Signature': `sha256=${sig}` }, body, signal: AbortSignal.timeout(10000) });
    return res.ok;
  } catch (e) {
    await logError('community-alert', e);
    return false;
  }
}
