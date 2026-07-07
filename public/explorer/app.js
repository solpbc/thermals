// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 sol pbc

(function () {
  'use strict';

  var CAP = 'org.v-it.cap';
  var VOUCH = 'org.v-it.vouch';
  var PROFILE = 'cloud.thermals.actor.profile';
  var COLLECTION_LABELS = {};
  COLLECTION_LABELS[CAP] = 'caps';
  COLLECTION_LABELS[VOUCH] = 'vouches';
  COLLECTION_LABELS[PROFILE] = 'profiles';

  var view = document.getElementById('view');
  var pdslsBase = 'https:' + '//pdsls.dev/at/';
  var pageState = { records: [], cursor: null };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function append(parent) {
    for (var i = 1; i < arguments.length; i++) {
      if (arguments[i]) parent.appendChild(arguments[i]);
    }
    return parent;
  }

  function link(href, text, className) {
    var a = el('a', className, text);
    a.href = href;
    return a;
  }

  function getJSON(path) {
    return fetch(path, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) {
            var err = new Error(data && data.error ? data.error : 'http ' + res.status);
            err.status = res.status;
            throw err;
          }
          return data;
        });
      });
  }

  function api(path, params) {
    var url = new URL(path, location.origin);
    Object.keys(params || {}).forEach(function (k) {
      if (params[k] != null && params[k] !== '') url.searchParams.set(k, params[k]);
    });
    return getJSON(url.pathname + url.search);
  }

  function parseRoute() {
    var raw = location.hash.replace(/^#\/?/, '');
    var q = '';
    var qi = raw.indexOf('?');
    if (qi !== -1) {
      q = raw.slice(qi + 1);
      raw = raw.slice(0, qi);
    }
    var parts = raw.split('/').filter(Boolean);
    var params = new URLSearchParams(q);
    if (parts.length === 0) return { view: 'home' };
    if (parts[0] === 'records') return { view: 'records', collection: decodeURIComponent(parts[1] || ''), params: params };
    if (parts[0] === 'record') return { view: 'record', uri: decodeURIComponent(parts.slice(1).join('/')) };
    if (parts[0] === 'actor') return { view: 'actor', id: decodeURIComponent(parts.slice(1).join('/')) };
    return { view: 'home' };
  }

  function setNav(route) {
    document.querySelectorAll('.nav a').forEach(function (a) {
      var nav = a.getAttribute('data-nav');
      var active = route.view === 'home' && nav === 'home';
      active = active || (route.collection === CAP && nav === 'caps');
      active = active || (route.collection === VOUCH && nav === 'vouches');
      active = active || (route.collection === PROFILE && nav === 'profiles');
      a.classList.toggle('active', active);
    });
  }

  function head(title, lede) {
    var wrap = el('div', 'view-head');
    append(wrap, el('h1', null, title), el('p', 'lede', lede));
    return wrap;
  }

  function renderError(message) {
    clear(view);
    var box = el('div', 'error-state');
    append(box, el('h2', null, 'could not load'), el('p', null, message || 'the explorer did not answer.'));
    view.appendChild(box);
  }

  function renderHome() {
    setNav({ view: 'home' });
    clear(view);
    append(view, head('record explorer', 'browse the thermals index directly. every row is a disposable view of public atproto records.'));
    var grid = el('div', 'explorer-grid');
    view.appendChild(grid);
    getJSON('/api/explorer/summary').then(function (data) {
      clear(grid);
      addSummaryTile(grid, 'caps shipped', data.capsShipped, '#/records/' + encodeURIComponent(CAP));
      addSummaryTile(grid, 'requests', data.requests, '#/records/' + encodeURIComponent(CAP) + '?kind=request');
      addSummaryTile(grid, 'vouches', data.vouches, '#/records/' + encodeURIComponent(VOUCH));
      addSummaryTile(grid, 'profiles', data.profiles, '#/records/' + encodeURIComponent(PROFILE));
    }).catch(function (err) { renderError(err.message); });
  }

  function addSummaryTile(grid, label, data, href) {
    var a = link(href, '', 'summary-tile');
    append(a, el('span', 'n', String((data && data.count) || 0)), el('span', 'k', label));
    a.appendChild(el('span', 'fresh', data && data.latestIndexedAt ? 'latest ' + data.latestIndexedAt : 'no indexed rows'));
    grid.appendChild(a);
  }

  function renderRecords(route) {
    setNav(route);
    var collection = route.collection;
    var params = route.params || new URLSearchParams();
    clear(view);
    append(view, head(COLLECTION_LABELS[collection] || 'records', 'newest indexed rows from the D1 cache, with raw record values one click away.'));
    var form = buildFilters(collection, params);
    var list = el('div', 'record-list');
    var more = el('button', 'btn btn-ghost load-more', 'load more');
    more.type = 'button';
    more.hidden = true;
    append(view, form, list, more);

    pageState = { records: [], cursor: null };
    loadRecordPage(collection, params, list, more, false);
    more.addEventListener('click', function () {
      loadRecordPage(collection, params, list, more, true);
    });
  }

  function buildFilters(collection, params) {
    var form = el('form', 'filter-bar');
    var didLabel = el('label', null, 'did');
    var didInput = el('input');
    didInput.name = 'did';
    didInput.value = params.get('did') || '';
    didInput.placeholder = 'did:plc:...';
    didLabel.appendChild(didInput);
    form.appendChild(didLabel);

    if (collection === CAP || collection === VOUCH) {
      var kindLabel = el('label', null, 'kind');
      var kindInput = el('input');
      kindInput.name = 'kind';
      kindInput.value = params.get('kind') || '';
      kindInput.placeholder = collection === CAP ? 'request, feat, fix' : 'endorse, want';
      kindLabel.appendChild(kindInput);
      form.appendChild(kindLabel);
    } else {
      form.appendChild(el('span'));
    }

    var actions = el('div', 'filter-actions');
    var apply = el('button', 'btn btn-primary', 'apply');
    apply.type = 'submit';
    var reset = el('a', 'btn btn-ghost', 'clear');
    reset.href = '#/records/' + encodeURIComponent(collection);
    append(actions, apply, reset);
    form.appendChild(actions);
    form.addEventListener('submit', function (event) {
      event.preventDefault();
      var next = new URLSearchParams();
      if (didInput.value.trim()) next.set('did', didInput.value.trim());
      var kind = form.elements.kind;
      if (kind && kind.value.trim()) next.set('kind', kind.value.trim());
      var suffix = next.toString() ? '?' + next.toString() : '';
      location.hash = '#/records/' + encodeURIComponent(collection) + suffix;
    });
    return form;
  }

  function loadRecordPage(collection, params, list, more, appendRows) {
    var q = {
      collection: collection,
      did: params.get('did'),
      kind: params.get('kind'),
      limit: '25',
      cursor: appendRows ? pageState.cursor : null,
    };
    more.disabled = true;
    api('/api/explorer/records', q).then(function (data) {
      if (!appendRows) clear(list);
      pageState.records = appendRows ? pageState.records.concat(data.records || []) : (data.records || []);
      (data.records || []).forEach(function (row) { list.appendChild(recordRow(row, collection)); });
      pageState.cursor = data.cursor || null;
      more.hidden = !pageState.cursor;
      more.disabled = false;
      if (!pageState.records.length) list.appendChild(emptyLine('no rows match those filters.'));
    }).catch(function (err) { renderError(err.message); });
  }

  function recordRow(row, collection) {
    var wrap = el('article', 'record-row');
    var title = el('div', 'record-title');
    title.appendChild(link('#/record/' + encodeURIComponent(row.uri), row.title || row.display_name || row.ref || row.uri));
    if (row.kind) title.appendChild(el('span', 'kind ' + safeKind(row.kind), row.kind));
    wrap.appendChild(title);
    wrap.appendChild(el('div', 'uri-line', row.uri));
    var meta = el('div', 'meta-line');
    var actor = row.handle || row.did || '';
    append(meta, document.createTextNode(COLLECTION_LABELS[collection] || collection));
    if (actor) {
      meta.appendChild(document.createTextNode(' by '));
      meta.appendChild(link('#/actor/' + encodeURIComponent(row.did || row.handle), actor, 'actor-link'));
    }
    if (row.indexed_at) meta.appendChild(document.createTextNode(' indexed ' + row.indexed_at));
    wrap.appendChild(meta);
    return wrap;
  }

  function renderRecord(route) {
    clear(view);
    append(view, link('#/', '< summary', 'back'));
    api('/api/explorer/record', { uri: route.uri }).then(function (data) {
      append(view, head('record detail', data.collection));
      view.appendChild(detailPanel(data.record));
      view.appendChild(contextPanel(data));
    }).catch(function (err) { renderError(err.message); });
  }

  function detailPanel(record) {
    var panel = el('section', 'detail-panel');
    append(panel, el('h2', null, 'indexed row'));
    var grid = el('div', 'detail-grid');
    Object.keys(record).forEach(function (key) {
      if (key === 'record_json' || key === 'value') return;
      append(grid, el('div', 'field-name', key), valueNode(record[key]));
    });
    panel.appendChild(grid);
    if (record.did) panel.appendChild(link('#/actor/' + encodeURIComponent(record.did), 'actor trace', 'atproto-link'));
    if (record.uri) panel.appendChild(link(pdslsBase + encodeURI(record.uri.replace(/^at:\/\//, '')), 'view on pdsls', 'atproto-link'));
    append(panel, el('h2', null, 'raw record'));
    var pre = el('pre', 'raw-json');
    pre.textContent = JSON.stringify(record.value, null, 2);
    panel.appendChild(pre);
    return panel;
  }

  function contextPanel(data) {
    var panel = el('section', 'detail-panel');
    append(panel, el('h2', null, 'context'));
    var list = el('div', 'context-list');
    if (data.collection === CAP) {
      var vouches = data.context && data.context.vouches || [];
      if (!vouches.length) list.appendChild(emptyLine('no indexed vouches for this cap.'));
      vouches.forEach(function (v) { list.appendChild(recordRow(v, VOUCH)); });
    } else if (data.collection === VOUCH) {
      var subject = data.context && data.context.subject;
      if (subject && subject.title) list.appendChild(recordRow(subject, CAP));
      else list.appendChild(el('div', 'uri-line', subject && subject.uri ? subject.uri : 'subject cap is not indexed'));
    } else {
      list.appendChild(el('div', 'meta-line', data.context && data.context.handle ? data.context.handle : 'no cached handle'));
    }
    panel.appendChild(list);
    return panel;
  }

  function renderActor(route) {
    clear(view);
    append(view, link('#/', '< summary', 'back'));
    var id = route.id || '';
    var params = id.indexOf('did:') === 0 ? { did: id } : { handle: id.replace(/^@/, '') };
    api('/api/explorer/actor', params).then(function (data) {
      append(view, head('actor trace', data.handle || data.did));
      view.appendChild(actorProfile(data));
      view.appendChild(axisStrip(data));
      actorSection('caps shipped', 'capsShipped', CAP, data);
      actorSection('endorsements received', 'endorsementsReceived', VOUCH, data);
      actorSection('vouches given', 'vouchesGiven', VOUCH, data);
    }).catch(function (err) { renderError(err.message); });
  }

  function actorProfile(data) {
    var panel = el('section', 'detail-panel');
    var profile = data.profile;
    if (!profile) {
      append(panel, el('h2', null, 'no thermals profile'), el('p', 'meta-line', 'this did has indexed records but has not published cloud.thermals.actor.profile.'));
      return panel;
    }
    append(panel, el('h2', null, profile.displayName || profile.handle || data.did));
    if (profile.description) panel.appendChild(el('p', null, profile.description));
    panel.appendChild(el('div', 'meta-line', profile.handle || data.did));
    return panel;
  }

  function axisStrip(data) {
    var strip = el('div', 'trace-strip');
    addAxis(strip, 'caps shipped', data.counts.capsShipped, data.records.capsShipped.length);
    addAxis(strip, 'endorsements received', data.counts.endorsementsReceived, data.records.endorsementsReceived.length);
    addAxis(strip, 'vouches given', data.counts.vouchesGiven, data.records.vouchesGiven.length);
    return strip;
  }

  function addAxis(strip, label, count, length) {
    var box = el('div', 'trace-axis');
    append(box, el('span', 'n', String(count)), el('span', 'k', label), el('div', 'trace-count', 'list length ' + length));
    strip.appendChild(box);
  }

  function actorSection(title, key, collection, data) {
    var section = el('section', 'trace-section');
    append(section, el('h2', null, title + ' '));
    section.querySelector('h2').appendChild(el('span', 'trace-count', String(data.records[key].length)));
    var list = el('div', 'record-list');
    if (!data.records[key].length) list.appendChild(emptyLine('none indexed.'));
    data.records[key].forEach(function (row) { list.appendChild(recordRow(row, collection)); });
    append(section, list);
    view.appendChild(section);
  }

  function valueNode(value) {
    var node = el('div', 'field-value');
    if (value == null) node.textContent = '';
    else if (typeof value === 'object') node.textContent = JSON.stringify(value);
    else node.textContent = String(value);
    return node;
  }

  function emptyLine(text) {
    return el('p', 'impls-none', text);
  }

  function safeKind(kind) {
    return String(kind).toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function route() {
    var r = parseRoute();
    if (r.view === 'home') renderHome();
    else if (r.view === 'records') renderRecords(r);
    else if (r.view === 'record') renderRecord(r);
    else if (r.view === 'actor') renderActor(r);
    else renderHome();
  }

  window.addEventListener('hashchange', route);
  route();
})();
