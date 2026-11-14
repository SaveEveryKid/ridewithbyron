/* RideWithByron.com — small, dependency-free client script */
(function () {
  'use strict';
  var cfg = {};
  try { cfg = JSON.parse(document.getElementById('rwb-config').textContent); } catch (e) {}
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  // ---------- first-touch attribution (kept for the whole customer journey)
  var KEY = 'rwb_attr';
  var FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid'];
  function readAttr() { try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function captureAttr() {
    var q = new URLSearchParams(location.search), now = {}, has = false;
    FIELDS.forEach(function (f) { if (q.get(f)) { now[f] = q.get(f).slice(0, 300); has = true; } });
    var ref = document.referrer && document.referrer.indexOf(location.host) === -1 ? document.referrer.slice(0, 300) : '';
    var saved = readAttr();
    // Keep the original source; replace it only when a new tagged ad click arrives after 30 days.
    if (!saved || (has && Date.now() - new Date(saved.first_seen).getTime() > 30 * 864e5)) {
      saved = now; saved.referrer = ref; saved.landing_page = location.pathname + location.search; saved.first_seen = new Date().toISOString();
      try { localStorage.setItem(KEY, JSON.stringify(saved)); } catch (e) {}
    }
    return saved;
  }
  var attr = captureAttr();

  function beacon(type, extra) {
    try {
      var data = JSON.stringify(Object.assign({ type: type, path: location.pathname, attribution: attr }, extra || {}));
      if (navigator.sendBeacon) navigator.sendBeacon('/api/event', new Blob([data], { type: 'application/json' }));
    } catch (e) {}
  }
  var unitGuid = (document.querySelector('[data-guid]') && /^\/inventory\/.+/.test(location.pathname)) ? ($('.buy [data-guid]') || {}).getAttribute && $('.buy [data-guid]').getAttribute('data-guid') : null;
  beacon('view', { guid: unitGuid });

  // ---------- consent-gated measurement tags
  var consent = null; try { consent = localStorage.getItem('rwb_consent'); } catch (e) {}
  var tagsLoaded = false;
  function loadTags() {
    if (tagsLoaded) return; tagsLoaded = true;
    var gid = cfg.ga4 || cfg.ads;
    if (gid) {
      var s = document.createElement('script'); s.async = true; s.src = 'https://www.googletagmanager.com/gtag/js?id=' + encodeURIComponent(gid); document.head.appendChild(s);
      window.dataLayer = window.dataLayer || []; window.gtag = function () { window.dataLayer.push(arguments); };
      window.gtag('js', new Date()); if (cfg.ga4) window.gtag('config', cfg.ga4); if (cfg.ads) window.gtag('config', cfg.ads);
    }
    if (cfg.pixel) {
      var n = window.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); }; n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
      var f = document.createElement('script'); f.async = true; f.src = 'https://connect.facebook.net/en_US/fbevents.js'; document.head.appendChild(f);
      window.fbq('init', cfg.pixel); window.fbq('track', 'PageView');
    }
  }
  function conversion(kind, detail) {
    if (!tagsLoaded) return;
    if (window.gtag) {
      window.gtag('event', kind === 'lead' ? 'generate_lead' : 'contact', detail || {});
      if (kind === 'lead' && cfg.ads && cfg.adsLead) window.gtag('event', 'conversion', { send_to: cfg.ads + '/' + cfg.adsLead });
    }
    if (window.fbq) window.fbq('track', kind === 'lead' ? 'Lead' : 'Contact', detail || {});
  }
  var banner = $('[data-consent]');
  if (banner) {
    if (consent === 'yes') loadTags(); else if (consent !== 'no') banner.classList.add('show');
    var set = function (v) { try { localStorage.setItem('rwb_consent', v); } catch (e) {} banner.classList.remove('show'); if (v === 'yes') loadTags(); };
    $('[data-consent-yes]', banner).addEventListener('click', function () { set('yes'); });
    $('[data-consent-no]', banner).addEventListener('click', function () { set('no'); });
    $$('[data-consent-open]').forEach(function (a) { a.addEventListener('click', function (e) { e.preventDefault(); banner.classList.add('show'); }); });
  }

  // ---------- nav
  var mb = $('[data-menu]'), mn = $('[data-mnav]');
  if (mb && mn) mb.addEventListener('click', function () { var o = mn.classList.toggle('open'); mb.setAttribute('aria-expanded', o); });

  // ---------- broken photo fallback
  document.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t.tagName === 'IMG' && t.hasAttribute('data-ph')) {
      var s = document.createElement('span'); s.className = 'noimg'; s.textContent = 'Photo unavailable — ask Byron for pictures';
      if (t.parentNode.classList.contains('gal-track')) { t.remove(); } else { t.replaceWith(s); }
    }
  }, true);

  // ---------- filters: collapsed on mobile, auto-submit sort
  var fw = $('[data-filters]');
  if (fw && window.matchMedia('(max-width: 999px)').matches) fw.removeAttribute('open');
  $$('[data-autosubmit] select').forEach(function (s) { s.addEventListener('change', function () { s.form.submit(); }); });

  // ---------- call / text tracking
  $$('[data-track]').forEach(function (a) {
    a.addEventListener('click', function () { beacon(a.getAttribute('data-track'), { guid: unitGuid }); conversion('contact', { method: a.getAttribute('data-track') }); });
  });

  // ---------- lead dialog + forms
  var dlg = $('[data-dialog]');
  function prepForm(form) {
    form.attribution.value = JSON.stringify(attr || {});
    form.page_url.value = location.pathname + location.search;
    var when = $('[data-when]', form);
    var sync = function () { if (when) when.hidden = form.intent.value !== 'visit'; };
    form.intent.addEventListener('change', sync); sync();
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var err = $('[data-form-error]', form), btn = $('button[type=submit]', form);
      err.textContent = '';
      if (!form.name.value.trim() || form.phone.value.replace(/\D/g, '').length < 10) { err.textContent = 'Please add your name and a 10-digit phone number.'; return; }
      if (!form.consent.checked) { err.textContent = 'Please check the box so Byron can contact you.'; return; }
      btn.disabled = true; btn.textContent = 'Sending…';
      var body = {}; new FormData(form).forEach(function (v, k) { body[k] = v; });
      fetch('/lead', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) })
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
          if (!res.ok) { err.textContent = (res.j && (res.j.message || Object.values(res.j.errors || {})[0])) || 'Something went wrong. Please call or text Byron instead.'; btn.disabled = false; btn.textContent = 'Send to Byron'; return; }
          conversion('lead', { lead_type: body.intent });
          var d = document.createElement('div'); d.className = 'done'; d.setAttribute('role', 'status');
          d.innerHTML = '<h3>Message sent</h3><p>It went straight to Byron. He’ll reach out personally, usually the same business day.</p>';
          form.replaceWith(d);
        })
        .catch(function () { err.textContent = 'Couldn’t send — check your connection and try again.'; btn.disabled = false; btn.textContent = 'Send to Byron'; });
    });
  }
  $$('[data-leadform]').forEach(prepForm);
  var pristine = dlg ? $('[data-dlg-body]', dlg).innerHTML : '';

  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-lead]') : null;
    if (!b || !dlg || !dlg.showModal) return; // no <dialog> support: follow the link to /contact
    e.preventDefault();
    var body = $('[data-dlg-body]', dlg);
    if (!$('form', body)) { body.innerHTML = pristine; prepForm($('form', body)); }
    var form = $('form', body), intent = b.getAttribute('data-lead');
    form.intent.value = intent; form.intent.dispatchEvent(new Event('change'));
    $('[data-dlg-title]', dlg).textContent = b.getAttribute('data-title') || (cfg.intents && cfg.intents[intent]) || 'Ask Byron';
    var veh = $('[data-veh]', form), guid = b.getAttribute('data-guid') || '';
    form.unit.value = guid; veh.hidden = !guid;
    if (guid) { $('[data-veh-name]', form).textContent = b.getAttribute('data-vehicle'); $('[data-veh-stock]', form).textContent = b.getAttribute('data-stock'); }
    dlg.showModal(); beacon('lead_open', { guid: guid || null, intent: intent });
    setTimeout(function () { form.name.focus(); }, 50);
  });
  if (dlg) {
    $('[data-close]', dlg).addEventListener('click', function () { dlg.close(); });
    dlg.addEventListener('click', function (e) { if (e.target === dlg) dlg.close(); });
  }

  // ---------- community: load the "are you human" check for a folded form when it is opened
  document.addEventListener('toggle', function (e) {
    var d = e.target;
    if (!d || !d.open || !d.querySelectorAll) return;
    var tries = 0;
    (function render() {
      var slots = $$('[data-turnstile]', d).filter(function (s) { return !s.getAttribute('data-done'); });
      if (!slots.length) return;
      if (!window.turnstile) { if (++tries < 40) setTimeout(render, 250); return; }
      slots.forEach(function (s) { s.setAttribute('data-done', '1'); window.turnstile.render(s, { sitekey: s.getAttribute('data-turnstile'), theme: 'dark', size: 'flexible' }); });
    })();
  }, true);

  // ---------- gallery
  $$('[data-gallery]').forEach(function (g) {
    var track = $('[data-track]', g), imgs = $$('img', track), idx = $('[data-idx]', g), thumbs = $$('[data-go]', g), cur = 0;
    function full(i) { [i, i + 1].forEach(function (n) { var im = imgs[n]; if (im && im.dataset.full) { im.src = im.dataset.full; delete im.dataset.full; } }); }
    function go(i) { i = Math.max(0, Math.min(imgs.length - 1, i)); full(i); track.scrollTo({ left: track.clientWidth * i, behavior: 'smooth' }); }
    var t; track.addEventListener('scroll', function () {
      clearTimeout(t); t = setTimeout(function () {
        cur = Math.round(track.scrollLeft / Math.max(1, track.clientWidth)); full(cur);
        if (idx) idx.textContent = cur + 1;
        thumbs.forEach(function (b, n) { if (n === cur) { b.setAttribute('aria-current', 'true'); } else b.removeAttribute('aria-current'); });
      }, 60);
    });
    var p = $('[data-prev]', g), n = $('[data-next]', g);
    if (p) p.addEventListener('click', function () { go(cur - 1); });
    if (n) n.addEventListener('click', function () { go(cur + 1); });
    thumbs.forEach(function (b) { b.addEventListener('click', function () { go(+b.getAttribute('data-go')); }); });
    track.addEventListener('keydown', function (e) { if (e.key === 'ArrowRight') go(cur + 1); if (e.key === 'ArrowLeft') go(cur - 1); });
  });
})();
