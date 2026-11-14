// The community page: ride videos, then topics and replies. Server-rendered; the only
// script it needs is the site's own. Everything visitors type is escaped before it is shown.
import { config } from '../config.js';
import { esc, layout, ago, jsonLd, reqState, logo } from './ui.js';
import { COMMUNITY_CSS } from './community-assets.js';

const STYLE = `<style>${COMMUNITY_CSS}</style>`;

const RULES = [
  'Be friendly. This is for riders helping riders.',
  'Keep it clean: no foul language, no personal attacks.',
  'No phone numbers, emails or home addresses in posts. Swap details in person or by private message.',
  'Meeting up to ride? Meet in a public place, ride within your limits, wear your gear, and bring a buddy.',
  'No selling or advertising. For a unit, ask Byron.',
  'You must be 13 or older to post.',
];

const when = (iso) => `<time datetime="${esc(iso)}" title="${esc(new Date(iso).toLocaleString('en-US', { timeZone: 'America/Chicago', dateStyle: 'medium', timeStyle: 'short' }))} CT">${esc(ago(iso))}</time>`;
const badge = (p) => (p.staff ? ' <span class="c-staff">Byron · Shoals Outdoor Sports</span>' : '');
/** Line breaks kept; nothing else is ever turned into markup (links stay as plain text). */
const text = (s) => esc(s).replace(/\n/g, '<br>');

/**
 * Hidden anti-spam fields plus the "are you human" check. Forms tucked inside a fold (Start a
 * topic, each Reply) only load their check when opened, so a long thread doesn't load dozens.
 */
function guard(lazy = false) {
  const k = config.turnstile.siteKey;
  const check = !k ? '' : lazy ? `<div data-turnstile="${esc(k)}"></div>` : `<div class="cf-turnstile" data-sitekey="${esc(k)}" data-theme="dark" data-size="flexible"></div>`;
  return `<input type="hidden" name="_t" value="${reqState.formToken}"><div class="hp" aria-hidden="true"><label>Website<input name="company" tabindex="-1" autocomplete="off"></label></div>${check}`;
}
const turnstileScript = () => (config.turnstile.siteKey ? '<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script><script src="/community/c.js" defer></script>' : '');

function postForm({ parentId = null, name = '', values = {}, errors = {}, isTopic = false, staff = false, lazy = false }) {
  const e = (k) => (errors[k] ? `<span class="err">${esc(errors[k])}</span>` : '');
  return `<form class="form c-form" method="post" action="/community/post">
${guard(lazy && !Object.keys(errors).length)}${parentId ? `<input type="hidden" name="parent" value="${parentId}">` : ''}
${staff ? '<p class="small muted" style="margin:0">Posting as <b>Byron Green</b> (you are signed in to the admin).</p>' : `<label class="f">Name to post under<input name="author" maxlength="30" required autocomplete="nickname" value="${esc(values.author ?? name)}" placeholder="Trail name or first name">${e('author')}</label>`}
${isTopic ? `<label class="f">Topic title<input name="title" maxlength="100" required value="${esc(values.title)}" placeholder="Best trails near Florence?">${e('title')}</label>` : ''}
<label class="f">${isTopic ? 'What’s on your mind?' : 'Your reply'}<textarea name="body" maxlength="2000" required placeholder="${isTopic ? 'Places to ride, trip reports, questions about your machine…' : 'Write a reply…'}">${esc(values.body)}</textarea>${e('body')}</label>
${errors.form ? `<div class="err" role="alert">${esc(errors.form)}</div>` : ''}
<button class="btn btn-primary" type="submit">${isTopic ? 'Post topic' : 'Post reply'}</button>
</form>`;
}

function videoGrid(videos) {
  if (!videos.length) {
    return `<div class="c-empty"><h3>Your ride could be first</h3><p>Got a clip of you or your crew out on the trail, in the mud or on the water? Send it in and we’ll put it up here.</p><a class="btn btn-primary" href="#send">Send us your ride</a></div>`;
  }
  return `<div class="c-videos">${videos.map((v) => `<figure class="c-video"><div class="c-frame"><iframe src="https://www.youtube-nocookie.com/embed/${esc(v.youtube_id)}?rel=0" title="${esc(v.title || 'Community ride video')}" loading="lazy" allow="accelerometer; encrypted-media; gyroscope; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>${v.title || v.credit ? `<figcaption>${v.title ? `<b>${esc(v.title)}</b>` : ''}${v.credit ? `<span class="muted"> — ${esc(v.credit)}</span>` : ''}</figcaption>` : ''}</figure>`).join('')}</div>`;
}

function flashBox(flash) {
  const M = {
    posted: ['ok', 'Posted. Thanks for adding to the conversation.'],
    held: ['info', 'Thanks! Your first post shows up as soon as Byron gives it a quick OK. After that, your posts go straight up.'],
    heldlink: ['info', 'Thanks! Posts with a link wait for Byron’s OK before they show.'],
    heldreview: ['info', 'Thanks! Your post is waiting for a quick review before it shows.'],
    reported: ['ok', 'Thanks for flagging that. Byron will take a look.'],
    sent: ['ok', 'Got it — thank you! Byron will take a look at your video.'],
  };
  const m = M[flash];
  return m ? `<div class="notice ${m[0]}" role="status">${m[1]}</div>` : '';
}

export function communityPage({ videos, list, name = '', flash = '', errors = {}, values = {}, staff = false, sendErrors = {}, sendValues = {} }) {
  const { topics, page, pages, total } = list;
  const se = (k) => (sendErrors[k] ? `<span class="err">${esc(sendErrors[k])}</span>` : '');
  const body = `
<div class="page-head"><div class="wrap"><span class="eyebrow">Riders around the Shoals</span><h1>Community</h1><p class="lede">Ride videos from folks around here, and a place to talk trails, machines and meeting up to ride.</p></div></div>
<div class="wrap">
${flashBox(flash)}
<section class="sec" style="padding-bottom:10px"><div class="sec-head"><div><h2>Ride <span>videos</span></h2><div class="slash"></div></div>${videos.length ? '<a href="#send">Send us yours →</a>' : ''}</div>
${videoGrid(videos)}</section>

<section class="sec" id="talk" style="padding-top:26px"><div class="sec-head"><div><h2>Trail <span>talk</span></h2><div class="slash"></div></div><span class="muted">${total} ${total === 1 ? 'topic' : 'topics'}</span></div>
<div class="c-layout">
<div>
<details class="block c-new" ${Object.keys(errors).length ? 'open' : ''} style="margin-top:0"><summary><span class="btn btn-primary">Start a topic</span></summary>${postForm({ isTopic: true, name, values, errors, staff, lazy: true })}</details>
${topics.length ? `<ul class="c-topics">${topics.map((t) => `<li><a class="c-topic" href="/community/t/${t.id}"><span class="c-title">${esc(t.title)}${t.locked ? ' <span class="tag">Closed</span>' : ''}</span><span class="c-excerpt">${esc(t.body.replace(/\s+/g, ' ').slice(0, 150))}${t.body.length > 150 ? '…' : ''}</span><span class="c-meta"><b>${esc(t.author)}</b> · ${t.replies} ${t.replies === 1 ? 'reply' : 'replies'} · active ${esc(ago(t.last_activity))}</span></a></li>`).join('')}</ul>`
    : '<div class="c-empty"><h3>No topics yet</h3><p>Be the first. Where do you like to ride around here?</p></div>'}
${pages > 1 ? `<nav class="pager" aria-label="Pages">${page > 1 ? `<a href="/community?page=${page - 1}#talk" rel="prev">‹ Newer</a>` : ''}<span aria-current="page">${page} / ${pages}</span>${page < pages ? `<a href="/community?page=${page + 1}#talk" rel="next">Older ›</a>` : ''}</nav>` : ''}
</div>
<aside>
<div class="block" style="margin-top:0"><h3>House rules</h3><ul class="c-rules">${RULES.map((r) => `<li>${esc(r)}</li>`).join('')}</ul><p class="small muted" style="margin:10px 0 0">No sign-up needed. Posts are checked automatically; see something off? Use <b>Report</b> on the post.</p></div>
<div class="block" id="send"><h3>Send us your ride</h3><p class="small muted">Upload your clip to YouTube (unlisted is fine) or anywhere you can share a link, then send the link.</p>
<form class="form" method="post" action="/community/video">${guard()}
<label class="f">Your name<input name="name" maxlength="60" required value="${esc(sendValues.name)}">${se('name')}</label>
<label class="f">Link to the video<input name="url" type="url" maxlength="300" required placeholder="https://youtu.be/…" value="${esc(sendValues.url)}">${se('url')}</label>
<label class="f">Phone or email <span style="text-transform:none;letter-spacing:0">(so Byron can reach you; never shown)</span><input name="contact" maxlength="120" required value="${esc(sendValues.contact)}">${se('contact')}</label>
<label class="f">Where was it? <span style="text-transform:none;letter-spacing:0">(optional)</span><input name="note" maxlength="200" value="${esc(sendValues.note)}"></label>
<label class="check"><input type="checkbox" name="consent" value="yes" required><span>This is my video, everyone in it is OK with it being shown (a parent or guardian for anyone under 18), and RideWithByron.com may post it.${se('consent') ? '<br>' + se('consent') : ''}</span></label>
<button class="btn btn-ghost btn-block" type="submit">Send video</button></form></div>
</aside>
</div></section></div>${turnstileScript()}`;
  return layout({
    path: '/community', canonical: '/community', noindex: page > 1,
    title: 'Rider Community — Trails, Rides & Videos Around the Shoals | Ride With Byron',
    description: 'Ride videos from local riders and an open discussion board for ATV and side-by-side owners around Florence and the Shoals: places to ride, machines, and meeting up.',
    head: STYLE,
    body,
  });
}

function postHtml(p, { name, staff, locked }) {
  return `<article class="c-post" id="p${p.id}">
<header><b>${esc(p.author)}</b>${badge(p)} <span class="muted">· ${when(p.created_at)}</span>${p.replyingTo ? ` <span class="muted small">· replying to ${esc(p.replyingTo)}</span>` : ''}</header>
<div class="c-body">${text(p.body)}</div>
<footer>${locked ? '' : `<details class="c-reply"><summary>Reply</summary>${postForm({ parentId: p.id, name, staff, lazy: true })}</details>`}
<form method="post" action="/community/report" class="c-report"><input type="hidden" name="_t" value="${reqState.formToken}"><input type="hidden" name="id" value="${p.id}"><button type="submit" title="Flag this post for Byron">Report</button></form></footer>
${p.children && p.children.length ? `<div class="c-children">${p.children.map((c) => postHtml(c, { name, staff, locked })).join('')}</div>` : ''}
</article>`;
}

export function topicPage({ topic, replies, count, name = '', flash = '', errors = {}, values = {}, staff = false }) {
  const ld = {
    '@context': 'https://schema.org', '@type': 'DiscussionForumPosting', headline: topic.title, text: topic.body.slice(0, 500),
    datePublished: topic.created_at, author: { '@type': 'Person', name: topic.author }, url: `${config.siteUrl}/community/t/${topic.id}`,
    interactionStatistic: { '@type': 'InteractionCounter', interactionType: 'https://schema.org/CommentAction', userInteractionCount: count },
  };
  const body = `<div class="wrap"><div class="crumbs" style="padding-top:16px"><a href="/">Home</a> / <a href="/community#talk">Community</a></div>
${flashBox(flash)}
<article class="c-post c-root" id="p${topic.id}">
<h1>${esc(topic.title)}</h1>
<header><b>${esc(topic.author)}</b>${badge(topic)} <span class="muted">· ${when(topic.created_at)} · ${count} ${count === 1 ? 'reply' : 'replies'}</span>${topic.locked ? ' <span class="tag">Closed</span>' : ''}</header>
<div class="c-body">${text(topic.body)}</div>
<footer><form method="post" action="/community/report" class="c-report"><input type="hidden" name="_t" value="${reqState.formToken}"><input type="hidden" name="id" value="${topic.id}"><button type="submit" title="Flag this topic for Byron">Report</button></form></footer>
</article>
<section class="c-thread">${replies.map((r) => postHtml(r, { name, staff, locked: !!topic.locked })).join('') || '<p class="muted" style="padding:10px 0">No replies yet. Jump in.</p>'}</section>
${topic.locked ? '<div class="notice">This topic is closed to new replies.</div>' : `<section class="block" id="reply"><h2>Add a reply</h2>${postForm({ parentId: topic.id, name, values, errors, staff })}</section>`}
<p style="margin:24px 0 50px"><a class="btn btn-ghost btn-sm" href="/community#talk">‹ All topics</a></p></div>${turnstileScript()}`;
  return layout({
    path: '/community', canonical: `/community/t/${topic.id}`, head: STYLE + jsonLd(ld),
    title: `${topic.title} | Rider Community — Ride With Byron`.slice(0, 110),
    description: topic.body.replace(/\s+/g, ' ').slice(0, 155),
    body,
  });
}

// ---------------- admin
export function communityAdmin(csrf, d, flash, shell) {
  const act = (id, action, label, cls = '') => `<form method="post" action="/admin/community/post/${id}" style="display:inline"><input type="hidden" name="_csrf" value="${csrf}"><button class="mini ${cls}" name="action" value="${action}">${label}</button></form>`;
  const row = (p, held) => `<tr><td style="white-space:nowrap">${esc(ago(p.created_at))}</td><td><b>${esc(p.author)}</b>${p.staff ? ' (you)' : ''}</td>
<td style="max-width:420px">${p.title ? `<b>${esc(p.title)}</b><br>` : `<span class="small muted">reply in <a href="/community/t/${p.topic_id}" target="_blank">topic #${p.topic_id}</a></span><br>`}${text(p.body.slice(0, 500))}</td>
<td>${held ? `<span class="pill warn">${esc(p.hold_reason || 'held')}</span>` : `${p.reports ? `<span class="pill warn">${p.reports} report${p.reports === 1 ? '' : 's'}</span> ` : ''}${p.locked ? '<span class="pill">closed</span>' : ''}`}</td>
<td style="white-space:nowrap">${held ? act(p.id, 'approve', 'Approve', 'on') : ''}${act(p.id, 'remove', 'Remove', 'danger')}${!p.parent_id && !held ? act(p.id, p.locked ? 'unlock' : 'lock', p.locked ? 'Reopen' : 'Close') : ''}${p.staff ? '' : act(p.id, 'block', 'Remove + block poster', 'danger')}</td></tr>`;
  return shell('Community', '/admin/community', csrf, `
${flash ? `<div class="notice ok">${esc(flash)}</div>` : ''}
<div class="stats"><div class="stat"><b style="color:${d.held.length ? 'var(--warn)' : 'inherit'}">${d.held.length}</b><span>Waiting for your OK</span></div><div class="stat"><b>${d.counts.live || 0}</b><span>Posts on the page</span></div><div class="stat"><b>${d.videos.length}</b><span>Videos</span></div><div class="stat"><b>${d.blocks}</b><span>Blocked posters</span></div></div>
<p class="muted small">Automatic checks on every post: ${['foul-language filter', 'phone numbers and emails hidden', 'links held for you', d.ai ? 'AI safety check ON' : 'AI safety check off (no AI binding)', d.turnstile ? '“are you human” check ON' : '“are you human” check off (add TURNSTILE keys)', 'a person’s first post held'].map(esc).join(' · ')}.</p>

<h2>Waiting for your OK</h2>
${d.held.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Name</th><th>Post</th><th>Why held</th><th></th></tr></thead><tbody>${d.held.map((p) => row(p, true)).join('')}</tbody></table></div>` : '<p class="muted">Nothing waiting.</p>'}

<h2>Ride videos</h2>
<form class="inline" method="post" action="/admin/community/video"><input type="hidden" name="_csrf" value="${csrf}"><input type="text" name="url" placeholder="YouTube link" style="width:260px" required><input type="text" name="title" placeholder="Title (optional)" style="width:200px" maxlength="100"><input type="text" name="credit" placeholder="Rider’s name (optional)" style="width:170px" maxlength="60"><button class="mini on">Add video</button></form>
${d.videos.length ? `<div class="tbl-wrap"><table class="tbl" style="min-width:420px"><tbody>${d.videos.map((v) => `<tr><td><a href="https://youtu.be/${esc(v.youtube_id)}" target="_blank" rel="noopener">${esc(v.title || v.youtube_id)}</a></td><td>${esc(v.credit || '')}</td><td>${esc(ago(v.created_at))}</td><td><form method="post" action="/admin/community/video/${v.id}"><input type="hidden" name="_csrf" value="${csrf}"><button class="mini danger">Remove</button></form></td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">No videos yet. Paste a YouTube link above to add the first one.</p>'}

<h2>Videos people sent in</h2>
${d.submissions.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>From</th><th>Contact</th><th>Link</th><th>Note</th><th></th></tr></thead><tbody>${d.submissions.map((s) => `<tr style="${s.status === 'done' ? 'opacity:.5' : ''}"><td>${esc(ago(s.created_at))}</td><td>${esc(s.name)}</td><td>${esc(s.contact)}</td><td style="max-width:260px;overflow-wrap:anywhere">${esc(s.url)}</td><td>${esc(s.note || '')}</td><td><form method="post" action="/admin/community/submission/${s.id}"><input type="hidden" name="_csrf" value="${csrf}"><button class="mini">${s.status === 'done' ? 'Reopen' : 'Done'}</button></form></td></tr>`).join('')}</tbody></table></div><p class="small muted">Links are shown as text on purpose: copy one into a new tab only if it looks right.</p>` : '<p class="muted">None yet.</p>'}

<h2>On the page now</h2>
${d.recent.length ? `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>When</th><th>Name</th><th>Post</th><th></th><th></th></tr></thead><tbody>${d.recent.map((p) => row(p, false)).join('')}</tbody></table></div>` : '<p class="muted">No posts yet.</p>'}`);
}

export { RULES, logo };
