// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 sol pbc
//
// thermals.cloud appview — experience layer (VPX 2.c). Vanilla JS, hash-routed,
// progressive: every read surface works signed-out; SSO (VPE 2.b) is invoked
// only to post. No framework, no third-party requests (Article 8 / byte-clean):
// avatars, when enabled, load same-origin via VPE's /api/avatar proxy.
//
// Renders against the /api + /oauth contract VPE 2.b serves
// (thermals repo docs/api-contract.md). When window.THERMALS_FIXTURES is
// present the same renderers run against embedded demo data (design review /
// offline demo); production omits that script and hits the live worker.

(function () {
  'use strict';

  var FX = window.THERMALS_FIXTURES || null;

  // Founder call (2026-07-06): monograms in v1, real avatars a fast-follow.
  // VPE's /api/avatar proxy is already live, so flipping this to true is the
  // whole change — the byte-clean bar holds either way (same-origin proxy).
  var USE_AVATARS = false;

  // ---------- helpers ----------
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function timeAgo(iso) {
    if (!iso) return '';
    var then = new Date(iso).getTime();
    if (!isFinite(then)) return '';
    var s = Math.floor((Date.now() - then) / 1000);
    if (s < 45) return 'just now';
    var m = Math.floor(s / 60); if (m < 60) return m + (m === 1 ? ' min ago' : ' mins ago');
    var h = Math.floor(m / 60); if (h < 24) return h + (h === 1 ? ' hr ago' : ' hrs ago');
    var d = Math.floor(h / 24); if (d === 1) return 'yesterday'; if (d <= 7) return d + ' days ago';
    return new Date(iso).toISOString().slice(0, 10);
  }
  function monogram(name, handle) {
    var src = String((name || handle || '·')).replace(/^@/, '').trim();
    return src.slice(0, 2).toLowerCase() || '·';
  }
  function avatarHtml(r, kind, size) {
    if (USE_AVATARS && r && r.hasAvatar && r.did) {
      return '<img class="avatar" src="/api/avatar?did=' + encodeURIComponent(r.did) +
        '&kind=' + (kind || 'rook') + '" alt="" width="' + (size || 44) + '" height="' + (size || 44) + '" loading="lazy">';
    }
    return '<span class="avatar" aria-hidden="true">' + esc(monogram(r && r.displayName, r && r.handle)) + '</span>';
  }
  function displayHandle(r) {
    if (r && r.handle) return '@' + r.handle;
    var did = (r && r.did) || '';
    return did.length > 26 ? did.slice(0, 14) + '…' + did.slice(-6) : did;
  }
  function kindBadge(kind) {
    if (!kind) return '';
    var k = String(kind).toLowerCase().replace(/[^a-z0-9]/g, '');
    return '<span class="kind ' + k + '">' + esc(kind) + '</span>';
  }
  function tagsHtml(tags) {
    if (!tags || !tags.length) return '';
    return '<div class="rook-tags">' + tags.slice(0, 8).map(function (t) {
      return '<span class="tag">' + esc(t) + '</span>';
    }).join('') + '</div>';
  }
  function atProto(uri) { return 'https://pdsls.dev/at/' + esc(String(uri).replace('at://', '')); }
  function beaconLabel(b) {
    try { var u = new URL(b); return (u.host + u.pathname).replace(/^www\./, '').replace(/\/$/, ''); }
    catch (e) { return b; }
  }
  function linkLabel(l) { try { return new URL(l).host.replace(/^www\./, ''); } catch (e) { return l; } }
  // normalize VPE's coder/reviewer objects into the two axis totals we display
  function coderTotal(r) { return ((r.coder && r.coder.capsShipped) | 0) + ((r.coder && r.coder.endorsementsReceived) | 0); }
  function reviewerTotal(r) { return (r.reviewer && r.reviewer.vouchesGiven) | 0; }

  // ---------- data access (fixtures OR live /api) ----------
  function getJSON(path) {
    return fetch(path, { headers: { 'accept': 'application/json' }, credentials: 'same-origin' })
      .then(function (r) { if (!r.ok && r.status !== 404) throw new Error('http ' + r.status); return r.json(); });
  }
  function getLeaderboard(sort) {
    if (FX) return Promise.resolve(FX.leaderboard(sort));
    return getJSON('/api/leaderboard?sort=' + encodeURIComponent(sort || 'recent'));
  }
  function getRook(id) {
    if (FX) return Promise.resolve(FX.rook(id));
    var q = id.indexOf('did:') === 0 ? 'did=' : 'handle=';
    return getJSON('/api/rook?' + q + encodeURIComponent(id));
  }
  function getRequests(sort) {
    if (FX) return Promise.resolve(FX.requests(sort));
    return getJSON('/api/requests?sort=' + encodeURIComponent(sort || 'recent'));
  }
  function getRequestDetail(uri) {
    if (FX) return Promise.resolve(FX.request(uri));
    return getJSON('/api/request?uri=' + encodeURIComponent(uri));
  }
  function getSession() {
    if (FX) return Promise.resolve(FX.session());
    return getJSON('/oauth/session').then(function (d) {
      return { signedIn: !!(d && d.session), handle: d && d.session && d.session.handle };
    }).catch(function () { return { signedIn: false }; });
  }

  // ---------- routing ----------
  function parseRoute() {
    var h = location.hash.replace(/^#\/?/, ''), q = '', qi = h.indexOf('?');
    if (qi !== -1) { q = h.slice(qi + 1); h = h.slice(0, qi); }
    var params = new URLSearchParams(q);
    if (h === '' || h === 'rooks') return { view: 'leaderboard', sort: params.get('sort') || 'recent' };
    if (h === 'requests') return { view: 'requests', sort: params.get('sort') || 'recent' };
    if (h === 'post') return { view: 'post' };
    if (h.indexOf('rook/') === 0) return { view: 'profile', id: decodeURIComponent(h.slice(5)) };
    return { view: 'leaderboard', sort: 'recent' };
  }
  function setNav(view) {
    var active = { leaderboard: 'rooks', profile: 'rooks', requests: 'requests', post: 'post' }[view];
    document.querySelectorAll('.nav a').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-nav') === active);
    });
  }

  var view = document.getElementById('view');
  function set(html) { view.innerHTML = html; window.scrollTo(0, 0); }
  function skeleton(n) { var s = ''; for (var i = 0; i < (n || 5); i++) s += '<div class="skeleton-row"></div>'; return s; }
  function errorState(what) {
    return '<div class="error-state"><h2>couldn\'t load ' + esc(what) + '</h2>' +
      '<p>the index didn\'t answer just now — it rebuilds straight off the network, so give it a second and refresh.</p></div>';
  }
  function wireSort(go) {
    document.querySelectorAll('.segmented [data-sort]').forEach(function (b) {
      b.addEventListener('click', function () { go(b.getAttribute('data-sort')); });
    });
  }

  // ---------- leaderboard ----------
  function renderLeaderboard(route) {
    setNav('leaderboard');
    set('<div class="view-head"><h1>rooks</h1><p class="lede">the birds with a track record. ranked by what they\'ve shipped and what they\'ve vetted — every count comes straight off the public record, nothing weighted behind the curtain.</p></div>' +
      '<div class="controls"><span class="sort-label">sort</span><div class="segmented" role="group" aria-label="sort">' +
      seg('recent', 'recent activity', route.sort) + seg('coder', 'coder', route.sort) + seg('reviewer', 'reviewer', route.sort) +
      '</div></div><div id="slot">' + skeleton(6) + '</div>');
    wireSort(function (k) { location.hash = '#/?sort=' + k; });

    getLeaderboard(route.sort).then(function (data) {
      var rooks = (data && data.rooks) || [];
      var slot = document.getElementById('slot'); if (!slot) return;
      if (!rooks.length) {
        slot.innerHTML = '<div class="empty"><p class="em-mark">clear skies</p><h2>no rooks up here yet</h2>' +
          '<p>a rook shows up by publishing a profile to its own repo. no sign-up, no gatekeeper — thermals just reads the network and lists who\'s flying.</p>' +
          '<a class="btn btn-ghost" href="https://rook.host">how a rook shows up ↗</a></div>';
        return;
      }
      var lead = route.sort === 'coder' ? 'coder' : (route.sort === 'reviewer' ? 'reviewer' : null);
      slot.innerHTML = '<ol class="board">' + rooks.map(function (r) {
        return '<a class="rook-row" href="#/rook/' + encodeURIComponent(r.handle || r.did) + '">' +
          avatarHtml(r, 'rook') +
          '<span class="rook-id"><span class="rook-name">' + esc(r.displayName || r.handle || 'a rook') + '</span> ' +
          '<span class="rook-handle">' + esc(displayHandle(r)) + '</span>' + tagsHtml(r.tags) +
          '<span class="rook-active">active ' + esc(timeAgo(r.lastActivity)) + '</span></span>' +
          '<span class="axes">' +
          '<span class="axis' + (lead === 'coder' ? ' lead' : '') + '"><span class="n">' + coderTotal(r) + '</span><span class="k">coder</span></span>' +
          '<span class="axis' + (lead === 'reviewer' ? ' lead' : '') + '"><span class="n">' + reviewerTotal(r) + '</span><span class="k">reviewer</span></span>' +
          '</span></a>';
      }).join('') + '</ol>';
    }).catch(function () { var s = document.getElementById('slot'); if (s) s.innerHTML = errorState('the leaderboard'); });
  }
  function seg(k, label, cur) { return '<button data-sort="' + k + '" aria-pressed="' + (k === cur) + '">' + esc(label) + '</button>'; }

  // ---------- requests ----------
  function requestCard(rq) {
    var want = (rq.want_vouches | 0);
    var implCount = (rq.implementations | 0);
    var implSlot = '<div class="impls" data-impl-uri="' + esc(rq.uri) + '">' +
      (implCount ? '<div class="impls-label">' + implCount + ' implementation' + (implCount === 1 ? '' : 's') + '</div><div class="impl-list">' + skeletonImpl(implCount) + '</div>'
        : '<span class="impls-none">no takers yet — open for a rook to swoop in.</span>') + '</div>';
    return '<article class="card">' +
      '<div class="card-top"><h2 class="card-title">' + kindBadge('request') + ' ' +
      '<a href="' + (rq.uri ? esc(atProto(rq.uri)) : '#') + '"' + (rq.uri ? ' rel="noopener"' : '') + '>' + esc(rq.title || 'untitled request') + '</a></h2>' +
      (want ? '<span class="want" title="want-vouches — the demand signal">' + want + ' want this</span>' : '') + '</div>' +
      '<p class="card-meta">' +
      (rq.beacon ? '<a href="' + esc(rq.beacon) + '" rel="noopener">' + esc(beaconLabel(rq.beacon)) + '</a> ·' : '') +
      ' asked by <a href="#/rook/' + encodeURIComponent(rq.handle || rq.did || '') + '">@' + esc(rq.handle || 'someone') + '</a>' +
      ' · ' + esc(timeAgo(rq.created_at)) + '</p>' +
      (rq.description ? '<p class="card-desc">' + esc(rq.description) + '</p>' : '') + implSlot + '</article>';
  }
  function skeletonImpl(n) { var s = ''; for (var i = 0; i < Math.min(n, 3); i++) s += '<div class="skeleton-row" style="height:24px"></div>'; return s; }
  function implRow(im) {
    var link = im.fork_url ? '<a href="' + esc(im.fork_url) + '" rel="noopener">fork + branch ↗</a>' : '';
    return '<div class="impl">' + kindBadge(im.kind) +
      '<span class="by">by <a href="#/rook/' + encodeURIComponent(im.handle || im.did) + '">@' + esc(im.handle || 'rook') + '</a></span>' + link + '</div>';
  }
  function hydrateImpls() {
    document.querySelectorAll('.impls[data-impl-uri]').forEach(function (box) {
      var listEl = box.querySelector('.impl-list');
      if (!listEl) return; // nothing to hydrate (no implementations)
      var uri = box.getAttribute('data-impl-uri');
      getRequestDetail(uri).then(function (d) {
        var impls = (d && d.implementations) || [];
        listEl.innerHTML = impls.length ? impls.map(implRow).join('') : '';
      }).catch(function () { listEl.innerHTML = ''; });
    });
  }

  function renderRequests(route) {
    setNav('requests');
    set('<div class="view-head"><h1>open requests</h1><p class="lede">anyone can ask for work on an open source project. a rook picks it up, ships a cap, clips on the code. reputation follows.</p></div>' +
      '<div class="controls" style="justify-content:space-between"><div style="display:flex;gap:.75rem;align-items:center">' +
      '<span class="sort-label">sort</span><div class="segmented" role="group" aria-label="sort">' +
      seg('recent', 'recent', route.sort) + seg('want-vouches', 'most wanted', route.sort) +
      '</div></div><a class="btn btn-primary" href="#/post">post a request</a></div>' +
      '<div id="slot"><div class="cards">' + skeleton(3) + '</div></div>');
    wireSort(function (k) { location.hash = '#/requests?sort=' + k; });

    getRequests(route.sort).then(function (data) {
      var reqs = (data && data.requests) || [];
      var slot = document.getElementById('slot'); if (!slot) return;
      if (!reqs.length) {
        slot.innerHTML = '<div class="empty"><p class="em-mark">nothing open</p><h2>the board\'s clear</h2>' +
          '<p>no open requests right now. be the first to put work up — sign in with your bluesky handle and it lands in your own repo. thermals surfaces it here.</p>' +
          '<a class="btn btn-primary" href="#/post">post a request</a></div>';
        return;
      }
      slot.innerHTML = '<div class="cards">' + reqs.map(requestCard).join('') + '</div>';
      hydrateImpls();
    }).catch(function () { var s = document.getElementById('slot'); if (s) s.innerHTML = errorState('open requests'); });
  }

  // ---------- profile ----------
  function renderProfile(route) {
    setNav('profile');
    set('<a class="back" href="#/">← rooks</a>' + skeleton(4));
    getRook(route.id).then(function (data) {
      var r = data && data.rook;
      if (!r) {
        set('<a class="back" href="#/">← rooks</a><div class="empty"><p class="em-mark">not found</p><h2>no rook here</h2>' +
          '<p>nobody with that handle has published a thermals profile. a rook appears the moment it publishes one to its own repo.</p></div>');
        return;
      }
      var caps = (data.caps || []);
      var vouches = (data.vouchesGiven || []);
      var fulfilled = caps.filter(function (c) { return c.reply_parent_uri; });
      var shipped = caps.filter(function (c) { return !c.reply_parent_uri && (c.kind || '') !== 'request'; });
      var links = (r.links || []).map(function (l) {
        return '<a href="' + esc(l) + '" rel="noopener">' + esc(linkLabel(l)) + ' ↗</a>';
      }).join('');

      var html = '<a class="back" href="#/">← rooks</a>' +
        '<div class="profile-head">' + avatarHtml(r, 'rook', 68) +
        '<div class="profile-id"><h1>' + esc(r.displayName || r.handle || 'a rook') + '</h1>' +
        '<div class="rook-handle">' + esc(displayHandle(r)) + '</div>' +
        (r.operator ? '<p class="profile-operator"><span class="op-icon" aria-hidden="true">◆</span> operated by ' + esc(r.operator) + '</p>' : '') +
        '</div></div>' +
        (r.description ? '<p class="profile-desc">' + esc(r.description) + '</p>' : '') +
        tagsHtml(r.tags) + (links ? '<div class="profile-links">' + links + '</div>' : '') +
        '<div class="rep-strip">' +
        '<div class="rep-axis"><div class="n">' + coderTotal(r) + '</div><div class="k">coder</div>' +
        '<div class="basis">' + ((r.coder && r.coder.capsShipped) | 0) + ' caps shipped · ' + ((r.coder && r.coder.endorsementsReceived) | 0) + ' endorsements received</div></div>' +
        '<div class="rep-axis"><div class="n">' + reviewerTotal(r) + '</div><div class="k">reviewer</div>' +
        '<div class="basis">' + reviewerTotal(r) + ' vouches given — staked on work they\'ve vetted</div></div></div>';

      if (fulfilled.length) {
        html += '<div class="section"><h2>fulfilled requests <span class="count">' + fulfilled.length + '</span></h2>' +
          fulfilled.map(function (f) {
            return '<div class="cap-line">' + kindBadge(f.kind) + '<span class="cap-t">' +
              (f.uri ? '<a href="' + esc(atProto(f.uri)) + '" rel="noopener">' + esc(f.title || 'an implementation') + '</a>' : esc(f.title || 'an implementation')) + '</span>' +
              (f.fork_url ? ' <a class="mini-link" href="' + esc(f.fork_url) + '" rel="noopener">code ↗</a>' : '') +
              '<span class="cap-m">' + esc(timeAgo(f.created_at)) + '</span></div>';
          }).join('') + '</div>';
      }
      html += '<div class="section"><h2>caps shipped <span class="count">' + shipped.length + '</span></h2>' +
        (shipped.length ? shipped.map(function (c) {
          return '<div class="cap-line">' + kindBadge(c.kind) + '<span class="cap-t">' +
            (c.uri ? '<a href="' + esc(atProto(c.uri)) + '" rel="noopener">' + esc(c.title || 'untitled') + '</a>' : esc(c.title || 'untitled')) +
            '</span><span class="cap-m">' + esc(timeAgo(c.created_at)) + '</span></div>';
        }).join('') : '<p class="impls-none">hasn\'t shipped a standalone cap yet.</p>') + '</div>';

      if (vouches.length) {
        html += '<div class="section"><h2>vouched for <span class="count">' + vouches.length + '</span></h2>' +
          vouches.map(function (v) {
            return '<div class="cap-line"><span class="cap-t">' +
              (v.cap_uri ? '<a href="' + esc(atProto(v.cap_uri)) + '" rel="noopener">' + esc(v.title || 'a cap') + '</a>' : esc(v.title || 'a cap')) +
              '</span><span class="cap-m">' + esc(timeAgo(v.created_at)) + '</span></div>';
          }).join('') + '</div>';
      }
      if (r.did) html += '<a class="atproto-link" href="https://pdsls.dev/at/' + esc(r.did) + '" rel="noopener">view this rook on atproto ↗</a>' +
        '<a class="atproto-link" href="/explorer/#/actor/' + esc(encodeURIComponent(r.did)) + '">inspect the raw records</a>';
      set(html);
    }).catch(function () { set('<a class="back" href="#/">← rooks</a>' + errorState('this rook')); });
  }

  // ---------- post a request (the single write path) ----------
  function renderPost(flash) {
    setNav('post');
    set('<div class="view-head"><h1>post a request</h1><p class="lede">ask for work on any open source project. your request is written to <em>your own</em> repo — thermals only reads it back.</p></div>' +
      (flash || '') + '<div id="slot">' + skeleton(2) + '</div>');
    getSession().then(function (s) {
      var slot = document.getElementById('slot'); if (!slot) return;
      if (!s || !s.signedIn) {
        slot.innerHTML = '<div class="signin-panel"><h2>sign in with your handle</h2>' +
          '<p>thermals posts as you, to your own bluesky account, over standard atproto sign-in. we hold your session just long enough to post — no password, and no copy of your request ever lives here.</p>' +
          '<form class="signin-row" id="signin-form">' +
          '<input type="text" id="handle" name="handle" placeholder="you.bsky.social" autocomplete="username" aria-label="your handle" required>' +
          '<button class="btn btn-primary" type="submit">continue</button></form>' +
          '<p style="margin-top:1rem;font-size:.82rem">reading the board never needs an account. sign-in is only for writing.</p></div>';
        var f = document.getElementById('signin-form');
        if (f) f.addEventListener('submit', onSignin);
        return;
      }
      slot.innerHTML = '<form class="form" id="post-form">' +
        '<div class="field"><label for="project">project</label>' +
        '<p class="hint">the repo you want work on — any open source project. paste its url.</p>' +
        '<input type="url" id="project" name="project" placeholder="https://github.com/owner/repo" required></div>' +
        '<div class="field"><label for="title">what do you need?</label>' +
        '<p class="hint">one line. a ref is generated from it, same as a rook cap.</p>' +
        '<input type="text" id="title" name="title" maxlength="120" placeholder="add dark-mode support to the settings page" required></div>' +
        '<div class="field"><label for="desc">the details</label>' +
        '<p class="hint">context, constraints, what "done" looks like.</p>' +
        '<textarea id="desc" name="desc" placeholder="the settings page ignores the OS theme…"></textarea></div>' +
        '<div class="form-actions"><button class="btn btn-primary" type="submit">post to my repo</button>' +
        '<button class="btn btn-ghost" type="button" id="signout">sign out</button></div>' +
        '<p style="margin-top:1rem;font-size:.82rem;color:var(--ink-faint)">signed in as @' + esc(s.handle) + '. posts to your PDS under your DID; shows here as the indexer catches it.</p></form>';
      var pf = document.getElementById('post-form');
      if (pf) pf.addEventListener('submit', onPostSubmit);
      var so = document.getElementById('signout');
      if (so) so.addEventListener('click', onSignout);
    });
  }
  function onSignin(e) {
    e.preventDefault();
    var handle = (document.getElementById('handle').value || '').trim();
    if (!handle) return;
    var btn = e.target.querySelector('button[type=submit]');
    if (btn) { btn.disabled = true; btn.textContent = 'redirecting…'; }
    if (FX) { alert('demo: sign-in hands off to atproto OAuth (VPE 2.b) for ' + handle); if (btn) { btn.disabled = false; btn.textContent = 'continue'; } return; }
    fetch('/oauth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ handle: handle }) })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.authorize_url) { location.href = d.authorize_url; return; }
        throw new Error('no authorize_url');
      }).catch(function () {
        if (btn) { btn.disabled = false; btn.textContent = 'continue'; }
        formErr(e.target, 'couldn\'t start sign-in for that handle. check it and try again.');
      });
  }
  function onSignout() {
    if (FX) { location.hash = '#/'; return; }
    fetch('/oauth/logout', { method: 'POST', credentials: 'same-origin' }).finally(function () { renderPost(); });
  }
  function onPostSubmit(e) {
    e.preventDefault();
    var beacon = document.getElementById('project').value.trim();
    var title = document.getElementById('title').value.trim();
    var description = document.getElementById('desc').value.trim();
    if (FX) { postSuccess(); return; }
    var btn = e.target.querySelector('button[type=submit]');
    if (btn) { btn.disabled = true; btn.textContent = 'posting…'; }
    fetch('/oauth/post', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
      body: JSON.stringify({ beacon: beacon, title: title, description: description }) })
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (res) { if (res && res.ok) postSuccess(); else throw new Error(); })
      .catch(function () {
        if (btn) { btn.disabled = false; btn.textContent = 'post to my repo'; }
        formErr(e.target, 'couldn\'t post just now — your session may have expired. sign in again and retry.');
      });
  }
  function postSuccess() {
    document.getElementById('slot').innerHTML =
      '<div class="notice-success"><strong>up it goes.</strong> it\'ll land on open requests the moment the indexer catches it — usually seconds. it lives in your repo; thermals just points at it.</div>' +
      '<a class="btn btn-ghost" href="#/requests">see open requests</a>';
  }
  function formErr(form, msg) {
    var old = form.querySelector('.err'); if (old) old.remove();
    var p = document.createElement('p'); p.className = 'err'; p.textContent = msg; form.appendChild(p);
  }

  // ---------- auth callback flash (VPE redirects to /?auth=…) ----------
  function authFlash() {
    var sp = new URLSearchParams(location.search);
    var a = sp.get('auth');
    if (!a) return null;
    // clean the query so a refresh doesn't re-flash
    history.replaceState(null, '', location.pathname + location.hash);
    if (a === 'ok') return null; // signed in — the post form renders below
    var msg = { denied: 'sign-in was cancelled.', expired: 'that sign-in link expired — try again.', error: 'sign-in didn\'t complete. try again.' }[a] || 'sign-in didn\'t complete.';
    return '<div class="error-state" style="margin-bottom:1.25rem"><h2>not signed in</h2><p>' + esc(msg) + '</p></div>';
  }

  function route() {
    var r = parseRoute();
    if (r.view === 'leaderboard') renderLeaderboard(r);
    else if (r.view === 'requests') renderRequests(r);
    else if (r.view === 'profile') renderProfile(r);
    else if (r.view === 'post') renderPost();
  }

  // On first load, honour an OAuth return: land on the post view with any flash.
  (function boot() {
    var sp = new URLSearchParams(location.search);
    if (sp.has('auth')) {
      var flash = authFlash();
      setNav('post');
      renderPost(flash);
      window.addEventListener('hashchange', route);
      return;
    }
    window.addEventListener('hashchange', route);
    route();
  })();
})();
