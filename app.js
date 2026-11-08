/* GlucoBreath app v1
   - Accounts and readings live in this browser (localStorage). Passwords are salted and hashed with PBKDF2.
   - The device link uses Web Bluetooth. A demo device is included for trying the app without hardware.
*/
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  /* ---------- BLE protocol (matches GlucoBreath_v4.ino) ---------- */
  var SVC = 'a7c10001-6b3e-4f6a-9d5c-0a1b2c3d4e5f';
  var C_DATA = 'a7c10002-6b3e-4f6a-9d5c-0a1b2c3d4e5f';
  var C_PAIR = 'a7c10003-6b3e-4f6a-9d5c-0a1b2c3d4e5f';
  var C_STAT = 'a7c10004-6b3e-4f6a-9d5c-0a1b2c3d4e5f';
  var C_CMD  = 'a7c10005-6b3e-4f6a-9d5c-0a1b2c3d4e5f';
  var STAGES = ['Standby', 'Get ready', 'Blow', 'Analyzing', 'Result'];

  /* ---------- storage ---------- */
  var mem = {};
  function sget(k) { try { return localStorage.getItem(k); } catch (e) { return mem[k] || null; } }
  function sset(k, v) { try { localStorage.setItem(k, v); } catch (e) { mem[k] = v; } }
  function jget(k, d) { try { var v = sget(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function jset(k, v) { sset(k, JSON.stringify(v)); }

  /* ---------- state ---------- */
  var S = {
    user: null, data: null,
    link: 'off',            // off | searching | pairing | paired
    dev: null, code: '', pairStep: 1,
    live: { stage: 0, prog: 0, g: 0, ace: 0, eth: 0, T: null, H: null },
    stageAt: performance.now(), blow: [],
    ctx: 'Fasting', range: 7, view: 'dashboard', pairTimer: null
  };

  /* ---------- helpers ---------- */
  var F = 18.016;
  function unit() { return S.data && S.data.unit === 'mgdl' ? 'mg/dL' : 'mmol/L'; }
  function conv(g) { return S.data && S.data.unit === 'mgdl' ? g * F : g; }
  function fmt(g) { return S.data && S.data.unit === 'mgdl' ? String(Math.round(g * F)) : g.toFixed(1); }
  function band(g) {
    if (g < 3.9) return { t: 'Low', c: 'low' };
    if (g <= 7.8) return { t: 'Normal', c: 'ok' };
    if (g <= 11.0) return { t: 'High', c: 'warn' };
    return { t: 'Very high', c: 'crit' };
  }
  function chip(el, g) { var b = band(g); el.textContent = b.t; el.className = 'chip ' + b.c; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmtDate(ts, long) {
    var d = new Date(ts);
    return long ? d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
                : d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }
  var toastT;
  function toast(msg) {
    var t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toastT);
    toastT = setTimeout(function () { t.hidden = true; }, 3800);
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function rand6() {
    var a = new Uint32Array(1); (window.crypto || {}).getRandomValues ? crypto.getRandomValues(a) : (a[0] = Math.floor(Math.random() * 4e9));
    return String(a[0] % 1000000).padStart(6, '0');
  }
  function grp(c) { return c.slice(0, 3) + ' ' + c.slice(3); }

  /* ---------- theme ---------- */
  var root = document.documentElement;
  function sysTheme() { return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'; }
  function curTheme() { return root.getAttribute('data-theme') || sysTheme(); }
  function markTheme() {
    var t = curTheme();
    $('#t-light').setAttribute('aria-pressed', t === 'light'); $('#t-dark').setAttribute('aria-pressed', t === 'dark');
    var mt = $('#menu-theme'); if (mt) mt.textContent = t === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  }
  function setTheme(t) { root.setAttribute('data-theme', t); sset('gb.theme', t); markTheme(); redrawAll(); }
  (function () { var t = sget('gb.theme'); if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t); })();

  /* ---------- auth ---------- */
  function b64(buf) { var s = ''; new Uint8Array(buf).forEach(function (b) { s += String.fromCharCode(b); }); return btoa(s); }
  function unb64(s) { var b = atob(s), a = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) a[i] = b.charCodeAt(i); return a; }
  function hashPw(pw, salt) {
    if (!(window.crypto && crypto.subtle)) return Promise.reject(new Error('Secure storage is not available in this browser context.'));
    return crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']).then(function (k) {
      return crypto.subtle.deriveBits({ name: 'PBKDF2', salt: salt, iterations: 150000, hash: 'SHA-256' }, k, 256);
    }).then(b64);
  }
  function users() { return jget('gb.users', {}); }
  function authErr(m) { $('#auth-err').textContent = m || ''; }
  function authTab(up) {
    $('#form-in').hidden = up; $('#form-up').hidden = !up;
    $('#tab-in').setAttribute('aria-selected', !up); $('#tab-in').setAttribute('aria-pressed', !up);
    $('#tab-up').setAttribute('aria-selected', up); $('#tab-up').setAttribute('aria-pressed', up);
    authErr('');
  }
  function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e); }

  function signUp(ev) {
    ev.preventDefault(); authErr('');
    var name = $('#up-name').value.trim(), email = $('#up-email').value.trim().toLowerCase(), pw = $('#up-pass').value;
    if (!name) return authErr('Enter your name.');
    if (!validEmail(email)) return authErr('Enter a valid email address.');
    if (pw.length < 8) return authErr('Use a password with at least 8 characters.');
    var u = users(); if (u[email]) return authErr('An account with this email already exists. Sign in instead.');
    var salt = crypto.getRandomValues(new Uint8Array(16));
    hashPw(pw, salt).then(function (h) {
      u[email] = { name: name, salt: b64(salt), hash: h, created: Date.now() }; jset('gb.users', u);
      sset('gb.session', email); enter(email);
    }, function (e) { authErr(e.message); });
  }
  function signIn(ev) {
    ev.preventDefault(); authErr('');
    var email = $('#in-email').value.trim().toLowerCase(), pw = $('#in-pass').value, u = users()[email];
    if (!u) return authErr('No account found for this email.');
    hashPw(pw, unb64(u.salt)).then(function (h) {
      if (h !== u.hash) return authErr('That password is not correct.');
      sset('gb.session', email); enter(email);
    }, function (e) { authErr(e.message); });
  }
  function signOut() {
    disconnect(true); sset('gb.session', ''); S.user = null; S.data = null;
    $('#app').hidden = true; $('#auth').hidden = false; $('#in-pass').value = ''; $('#acct-menu').hidden = true; authTab(false); startAuthArt();
  }

  /* ---------- data ---------- */
  function loadData(email) { S.data = jget('gb.data.' + email, { readings: [], unit: 'mmol' }); }
  function saveData() { jset('gb.data.' + S.user.email, S.data); }
  function mulberry(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; var t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function sampleReadings() {
    var r = mulberry(7), out = [], now = Date.now();
    for (var d = 14; d >= 0; d--) {
      var base = new Date(now - d * 864e5);
      [['Fasting', 7, 5.3, 0.7], ['After meal', 13, 7.4, 1.1]].forEach(function (c) {
        var ts = new Date(base.getFullYear(), base.getMonth(), base.getDate(), c[1], Math.floor(r() * 40)).getTime();
        if (ts > now) return;
        var g = Math.max(3.9, c[2] + (r() - .5) * 2 * c[3] + (d % 5 === 0 ? 0.8 : 0));
        out.push({ id: uid() + out.length, ts: ts, g: +g.toFixed(2), ace: +((g - 4.5) / 1.9).toFixed(2), eth: +(0.05 + r() * 0.2).toFixed(2), T: +(23 + r() * 4).toFixed(1), H: +(40 + r() * 15).toFixed(1), ctx: c[0], sample: true });
      });
    }
    return out;
  }
  function addReading(rd) { S.data.readings.push(rd); S.data.readings.sort(function (a, b) { return a.ts - b.ts; }); saveData(); }

  /* ---------- routing ---------- */
  var VIEWS = ['dashboard', 'test', 'history', 'guide', 'device'];
  function route() {
    if (!S.user) return;
    var v = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('/')[0];
    if (VIEWS.indexOf(v) < 0) v = 'dashboard';
    S.view = v;
    VIEWS.forEach(function (n) { $('#v-' + n).hidden = n !== v; });
    $$('#nav a').forEach(function (a) { if (a.getAttribute('data-v') === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
    window.scrollTo(0, 0);
    redrawAll();
  }
  function redrawAll() {
    if (!S.user) return;
    if (S.view === 'dashboard') renderDashboard();
    if (S.view === 'test') renderTest();
    if (S.view === 'history') renderHistory();
    if (S.view === 'device') renderDevice();
    markTheme();
  }

  /* ---------- dashboard ---------- */
  function filtered() {
    var rs = S.data.readings.slice();
    if (S.range) { var from = Date.now() - S.range * 864e5; rs = rs.filter(function (r) { return r.ts >= from; }); }
    return rs;
  }
  function renderDashboard() {
    var all = S.data.readings, has = all.length > 0, h = new Date().getHours();
    $('#dash-hello').textContent = (h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening') + ', ' + S.user.name.split(' ')[0];
    $('#dash-date').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
    $('#dash-empty').hidden = has; $('#dash-main').hidden = !has;
    $('#unit-mmol').setAttribute('aria-pressed', S.data.unit !== 'mgdl'); $('#unit-mgdl').setAttribute('aria-pressed', S.data.unit === 'mgdl');
    $$('.rng').forEach(function (b) { b.setAttribute('aria-pressed', +b.getAttribute('data-r') === S.range); });
    if (!has) return;

    var last = all[all.length - 1], prev = all[all.length - 2];
    $('#latest-val').textContent = fmt(last.g); $('#latest-unit').textContent = unit();
    chip($('#latest-chip'), last.g);
    $('#latest-when').textContent = fmtDate(last.ts, true) + (last.sample ? ' (sample)' : '') + (last.demo ? ' (demo)' : '');
    $('#latest-ctx').textContent = last.ctx || '--';
    if (prev) { var d = conv(last.g) - conv(prev.g), mg = S.data.unit === 'mgdl'; $('#latest-delta').textContent = (d > 0 ? '+' : d < 0 ? '-' : '') + (mg ? Math.abs(Math.round(d)) : Math.abs(d).toFixed(1)) + ' ' + unit(); } else $('#latest-delta').textContent = 'First reading';
    $('#latest-room').textContent = last.T != null ? last.T.toFixed(1) + ' C, ' + Math.round(last.H) + '%' : '--';

    var rs = filtered(), n = rs.length;
    $('#stats-label').textContent = S.range ? 'Last ' + S.range + ' days' : 'All time';
    if (n) {
      var vals = rs.map(function (r) { return r.g; }), sum = vals.reduce(function (a, b) { return a + b; }, 0);
      $('#st-avg').textContent = fmt(sum / n) + ' ' + unit();
      $('#st-min').textContent = fmt(Math.min.apply(null, vals)) + ' ' + unit();
      $('#st-max').textContent = fmt(Math.max.apply(null, vals)) + ' ' + unit();
      $('#st-range').textContent = Math.round(100 * vals.filter(function (v) { return v >= 3.9 && v <= 7.8; }).length / n) + '%';
    } else { ['#st-avg', '#st-min', '#st-max', '#st-range'].forEach(function (i) { $(i).textContent = '--'; }); }
    $('#st-n').textContent = n;
    drawChart($('#chart'), rs);
    gauge($('#gauge-latest'), last.g, { noValue: true }); renderTir(rs); ctxChart($('#ctxchart'), rs); dayChart($('#daychart'), rs);

    var ul = $('#recent'); ul.innerHTML = '';
    all.slice(-5).reverse().forEach(function (r) {
      var b = band(r.g), li = document.createElement('li');
      li.innerHTML = '<div class="when"><b>' + esc(fmtDate(r.ts, true)) + '</b>' + esc(r.ctx || '') + (r.sample ? ' - sample' : '') + (r.demo ? ' - demo' : '') + '</div><div class="val">' + fmt(r.g) + ' <span class="unit">' + unit() + '</span></div><span class="chip ' + b.c + '">' + b.t + '</span>';
      ul.appendChild(li);
    });
  }

  function drawChart(el, rows) {
    var tip = $('#chart-tip'); tip.hidden = true;
    if (!rows.length) { el.innerHTML = '<p class="body">No readings in this range.</p>'; return; }
    var W = Math.max(300, el.clientWidth), Hh = Math.round(Math.min(320, Math.max(230, W * 0.4)));
    var m = { l: 46, r: 18, t: 16, b: 30 }, iw = W - m.l - m.r, ih = Hh - m.t - m.b;
    var mg = S.data.unit === 'mgdl', f = mg ? F : 1, step = mg ? 40 : 2;
    var vals = rows.map(function (r) { return r.g * f; });
    var lo = Math.min.apply(null, vals.concat([mg ? 54 : 3.0])), hi = Math.max.apply(null, vals.concat([mg ? 200 : 11]));
    var y0 = Math.floor(lo / step) * step, y1 = Math.ceil(hi / step) * step;
    var t0 = rows[0].ts, t1 = rows[rows.length - 1].ts; if (t1 === t0) { t0 -= 432e5; t1 += 432e5; }
    function X(ts) { return m.l + (ts - t0) / (t1 - t0) * iw; }
    function Y(v) { return m.t + (1 - (v - y0) / (y1 - y0)) * ih; }
    var s = '<svg viewBox="0 0 ' + W + ' ' + Hh + '" width="' + W + '" height="' + Hh + '" role="img" aria-label="Glucose trend of ' + rows.length + ' readings, latest ' + fmt(rows[rows.length - 1].g) + ' ' + unit() + '">';
    var bt = Y(7.8 * f), bb = Y(3.9 * f);
    s += '<rect class="band" x="' + m.l + '" y="' + bt + '" width="' + iw + '" height="' + (bb - bt) + '"/>';
    s += '<text class="bandlab" x="' + (W - m.r - 8) + '" y="' + (bb - 8) + '" text-anchor="end">NORMAL</text>';
    for (var v = y0; v <= y1 + 0.001; v += step) {
      s += '<line class="grid" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + Y(v) + '" y2="' + Y(v) + '"/><text class="axis" x="' + (m.l - 8) + '" y="' + (Y(v) + 4) + '" text-anchor="end">' + Math.round(v) + '</text>';
    }
    var nt = W < 520 ? 3 : 5;
    for (var i = 0; i < nt; i++) {
      var ts = t0 + (t1 - t0) * i / (nt - 1), d = new Date(ts);
      s += '<text class="axis" x="' + X(ts) + '" y="' + (Hh - 8) + '" text-anchor="' + (i === 0 ? 'start' : i === nt - 1 ? 'end' : 'middle') + '">' + d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + '</text>';
    }
    var pts = rows.map(function (r) { return X(r.ts).toFixed(1) + ',' + Y(r.g * f).toFixed(1); });
    if (rows.length > 1) s += '<polyline class="ln" points="' + pts.join(' ') + '"/>';
    rows.forEach(function (r, i) {
      s += '<circle class="pt' + (i === rows.length - 1 ? ' last' : '') + '" cx="' + X(r.ts).toFixed(1) + '" cy="' + Y(r.g * f).toFixed(1) + '" r="' + (i === rows.length - 1 ? 5 : rows.length > 40 ? 2.5 : 3.5) + '"/>';
    });
    s += '<line class="cross" id="xh" x1="0" x2="0" y1="' + m.t + '" y2="' + (m.t + ih) + '" style="display:none"/>';
    s += '<rect class="hit" x="' + m.l + '" y="' + m.t + '" width="' + iw + '" height="' + ih + '"/></svg>';
    el.innerHTML = s;
    var svg = el.firstChild, hit = $('.hit', svg), xh = $('#xh', svg);
    function move(e) {
      var rect = svg.getBoundingClientRect(), px = (e.clientX - rect.left) * (W / rect.width), best = 0, bd = 1e9;
      rows.forEach(function (r, i) { var dd = Math.abs(X(r.ts) - px); if (dd < bd) { bd = dd; best = i; } });
      var r = rows[best], cx = X(r.ts), cy = Y(r.g * f), card = el.parentNode.getBoundingClientRect(), k = rect.width / W;
      xh.setAttribute('x1', cx); xh.setAttribute('x2', cx); xh.style.display = '';
      tip.innerHTML = '<b>' + fmt(r.g) + ' ' + unit() + '</b> ' + band(r.g).t + '<br>' + esc(fmtDate(r.ts, true)) + (r.ctx ? ' - ' + esc(r.ctx) : '');
      tip.hidden = false;
      tip.style.left = (rect.left - card.left + cx * k) + 'px'; tip.style.top = (rect.top - card.top + cy * k) + 'px';
    }
    hit.addEventListener('pointermove', move); hit.addEventListener('pointerdown', move);
    hit.addEventListener('pointerleave', function () { tip.hidden = true; xh.style.display = 'none'; });
  }


  /* ---------- gauge, time in range, context bars, daily range ---------- */
  function gauge(el, g, opts) {
    opts = opts || {};
    var mg = S.data && S.data.unit === 'mgdl', min = 2, max = 14, W = 280, H = 206, cx = 140, cy = 132, r = 104;
    function ang(v) { v = Math.max(min, Math.min(max, v)); return Math.PI * (1 - (v - min) / (max - min)); }
    function pt(v, rad) { var a = ang(v); return [cx + rad * Math.cos(a), cy - rad * Math.sin(a)]; }
    function arc(a, b, cls) {
      var p1 = pt(a, r), p2 = pt(b, r);
      return '<path class="gz ' + cls + '" d="M' + p1[0].toFixed(1) + ' ' + p1[1].toFixed(1) + ' A' + r + ' ' + r + ' 0 0 1 ' + p2[0].toFixed(1) + ' ' + p2[1].toFixed(1) + '"/>';
    }
    var has = g != null && g > 0;
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Glucose gauge' + (has ? ', ' + fmt(g) + ' ' + unit() + ', ' + band(g).t : ', no reading') + '">';
    s += arc(min, 3.85, 'low') + arc(3.95, 7.75, 'ok') + arc(7.85, 10.95, 'warn') + arc(11.05, max, 'crit');
    [[3.9, 3.9], [7.8, 7.8], [11, 11]].forEach(function (t) {
      var p = pt(t[0], r + 20); s += '<text class="gtick" x="' + p[0].toFixed(1) + '" y="' + (p[1] + 3).toFixed(1) + '">' + (mg ? Math.round(t[1] * F) : t[1]) + '</text>';
    });
    [['LOW', 2.95], ['NORMAL', 5.85], ['HIGH', 9.4], ['V.HIGH', 12.5]].forEach(function (n) {
      var p = pt(n[1], r - 24); s += '<text class="gname" x="' + p[0].toFixed(1) + '" y="' + (p[1] + 3).toFixed(1) + '">' + n[0] + '</text>';
    });
    if (has) {
      var n = pt(g, r - 34), m = pt(g, r);
      s += '<line class="gneedle" x1="' + cx + '" y1="' + cy + '" x2="' + n[0].toFixed(1) + '" y2="' + n[1].toFixed(1) + '"/>';
      s += '<circle class="gmark" cx="' + m[0].toFixed(1) + '" cy="' + m[1].toFixed(1) + '" r="8"/>';
    }
    s += '<circle class="ghub" cx="' + cx + '" cy="' + cy + '" r="8"/>';
    if (opts.noValue) { el.innerHTML = s.replace(/viewBox="0 0 280 206"/, 'viewBox="0 0 280 156"') + '</svg>'; return; }
    s += '<text class="gval" x="' + cx + '" y="' + (cy + 44) + '">' + (has ? fmt(g) : '--') + '</text><text class="gunit" x="' + cx + '" y="' + (cy + 62) + '">' + unit() + '</text></svg>';
    el.innerHTML = s;
  }

  function renderTir(rs) {
    var el = $('#tir'), n = rs.length;
    if (!n) { el.innerHTML = '<p class="fine">No readings in this range.</p>'; return; }
    var seg = [['low', 'Low', 0], ['ok', 'Normal', 0], ['warn', 'High', 0], ['crit', 'Very high', 0]];
    rs.forEach(function (r) { var g = r.g; seg[g < 3.9 ? 0 : g <= 7.8 ? 1 : g <= 11 ? 2 : 3][2]++; });
    var bar = '<div class="tir" role="img" aria-label="Time in range: ' + seg.map(function (x) { return x[1] + ' ' + Math.round(100 * x[2] / n) + '%'; }).join(', ') + '">';
    seg.forEach(function (x) { if (x[2]) bar += '<i class="' + x[0] + '" style="flex:' + x[2] + '"></i>'; });
    bar += '</div><ul class="tir-key">';
    seg.forEach(function (x) { bar += '<li><i class="' + x[0] + '"></i>' + x[1] + ' <b>' + Math.round(100 * x[2] / n) + '%</b></li>'; });
    el.innerHTML = bar + '</ul>';
  }

  function ctxChart(el, rs) {
    var W = Math.max(280, el.clientWidth), ctxs = ['Fasting', 'Before meal', 'After meal', 'Other'], rowH = 46, m = { l: 96, r: 64, t: 6, b: 26 }, H = m.t + rowH * ctxs.length + m.b, iw = W - m.l - m.r;
    var mg = S.data.unit === 'mgdl', f = mg ? F : 1, mx = mg ? 200 : 11;
    rs.forEach(function (r) { if (r.g * f > mx) mx = r.g * f; }); mx = Math.ceil(mx / (mg ? 40 : 2)) * (mg ? 40 : 2);
    function X(v) { return m.l + v / mx * iw; }
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="Average glucose by context">';
    s += '<rect class="band" x="' + X(3.9 * f) + '" y="' + m.t + '" width="' + (X(7.8 * f) - X(3.9 * f)) + '" height="' + (rowH * ctxs.length) + '"/>';
    var step = mg ? 40 : 2; for (var v = 0; v <= mx + .001; v += step) s += '<line class="grid" x1="' + X(v) + '" x2="' + X(v) + '" y1="' + m.t + '" y2="' + (m.t + rowH * ctxs.length) + '"/><text class="axis" x="' + X(v) + '" y="' + (H - 8) + '" text-anchor="middle">' + Math.round(v) + '</text>';
    ctxs.forEach(function (c, i) {
      var list = rs.filter(function (r) { return r.ctx === c; }), y = m.t + i * rowH;
      s += '<text class="lab" x="0" y="' + (y + rowH / 2 + 4) + '">' + c + '</text>';
      if (!list.length) { s += '<text class="none" x="' + m.l + '" y="' + (y + rowH / 2 + 4) + '">No data</text>'; return; }
      var avg = list.reduce(function (a, r) { return a + r.g; }, 0) / list.length;
      s += '<rect class="bar" x="' + m.l + '" y="' + (y + 11) + '" width="' + Math.max(2, X(avg * f) - m.l) + '" height="24" rx="3"/>';
      s += '<text class="lab" x="' + (X(avg * f) + 8) + '" y="' + (y + rowH / 2 + 4) + '">' + fmt(avg) + '</text>';
    });
    el.innerHTML = s + '</svg>';
  }

  function dayChart(el, rs) {
    if (!rs.length) { el.innerHTML = '<p class="fine">No readings in this range.</p>'; return; }
    var days = {}; rs.forEach(function (r) { var d = new Date(r.ts); var k = d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); (days[k] = days[k] || { ts: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), v: [] }).v.push(r.g); });
    var list = Object.keys(days).map(function (k) { return days[k]; }).sort(function (a, b) { return a.ts - b.ts; }).slice(-30);
    var W = Math.max(280, el.clientWidth), H = 230, m = { l: 40, r: 8, t: 10, b: 28 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
    var mg = S.data.unit === 'mgdl', f = mg ? F : 1, step = mg ? 40 : 2, all = [];
    list.forEach(function (d) { all.push(Math.min.apply(null, d.v) * f, Math.max.apply(null, d.v) * f); });
    var y0 = Math.floor(Math.min.apply(null, all.concat([mg ? 54 : 3])) / step) * step, y1 = Math.ceil(Math.max.apply(null, all.concat([mg ? 200 : 11])) / step) * step;
    function Y(v) { return m.t + (1 - (v - y0) / (y1 - y0)) * ih; }
    var cw = iw / list.length, bw = Math.max(4, Math.min(22, cw * 0.55));
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="Daily lowest, highest and average glucose">';
    s += '<rect class="band" x="' + m.l + '" y="' + Y(7.8 * f) + '" width="' + iw + '" height="' + (Y(3.9 * f) - Y(7.8 * f)) + '"/>';
    for (var v = y0; v <= y1 + .001; v += step) s += '<line class="grid" x1="' + m.l + '" x2="' + (W - m.r) + '" y1="' + Y(v) + '" y2="' + Y(v) + '"/><text class="axis" x="' + (m.l - 6) + '" y="' + (Y(v) + 4) + '" text-anchor="end">' + Math.round(v) + '</text>';
    list.forEach(function (d, i) {
      var lo = Math.min.apply(null, d.v) * f, hi = Math.max.apply(null, d.v) * f, av = d.v.reduce(function (a, b) { return a + b; }, 0) / d.v.length * f, x = m.l + cw * i + cw / 2;
      var top = Y(hi), h = Math.max(4, Y(lo) - Y(hi));
      s += '<rect class="rng" x="' + (x - bw / 2) + '" y="' + top + '" width="' + bw + '" height="' + h + '" rx="3"><title>' + new Date(d.ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ': ' + Math.round(lo * (mg ? 1 : 10)) / (mg ? 1 : 10) + ' to ' + Math.round(hi * (mg ? 1 : 10)) / (mg ? 1 : 10) + '</title></rect>';
      s += '<circle class="avg" cx="' + x + '" cy="' + Y(av) + '" r="3.5"/>';
    });
    [0, Math.floor((list.length - 1) / 2), list.length - 1].filter(function (v, i, a) { return a.indexOf(v) === i; }).forEach(function (i, k, arr) {
      var x = m.l + cw * i + cw / 2; s += '<text class="axis" x="' + x + '" y="' + (H - 8) + '" text-anchor="' + (i === 0 && arr.length > 1 ? 'start' : i === list.length - 1 && arr.length > 1 ? 'end' : 'middle') + '">' + new Date(list[i].ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + '</text>';
    });
    el.innerHTML = s + '</svg>';
  }

  /* ---------- history ---------- */
  function renderHistory() {
    var flt = $('#hist-filter').value, rs = S.data.readings.slice().reverse();
    if (flt) rs = rs.filter(function (r) { return r.ctx === flt; });
    $('#hist-empty').hidden = rs.length > 0; $('#hist-wrap').hidden = rs.length === 0;
    $('#btn-clear-sample').hidden = !S.data.readings.some(function (r) { return r.sample; });
    var tb = $('#hist-body'); tb.innerHTML = '';
    rs.forEach(function (r) {
      var b = band(r.g), tr = document.createElement('tr');
      tr.innerHTML = '<td>' + esc(fmtDate(r.ts, true)) + (r.sample ? '<span class="tag">sample</span>' : '') + (r.demo ? '<span class="tag">demo</span>' : '') + '</td>' +
        '<td class="n g">' + fmt(r.g) + ' <span class="unit">' + unit() + '</span></td><td><span class="chip ' + b.c + '">' + b.t + '</span></td>' +
        '<td>' + esc(r.ctx || '--') + '</td><td class="n">' + (r.ace != null ? r.ace.toFixed(2) + ' ppm' : '--') + '</td>' +
        '<td class="n">' + (r.T != null ? r.T.toFixed(1) + ' C, ' + Math.round(r.H) + '%' : '--') + '</td>' +
        '<td class="n"><button type="button" class="del" data-id="' + r.id + '">Delete</button></td>';
      tb.appendChild(tr);
    });
  }
  function exportCsv() {
    var rows = [['timestamp', 'glucose_mmol_L', 'glucose_mg_dL', 'acetone_ppm', 'ethanol_ppm', 'temperature_C', 'humidity_pct', 'context', 'source']];
    S.data.readings.forEach(function (r) {
      rows.push([new Date(r.ts).toISOString(), r.g.toFixed(2), Math.round(r.g * F), r.ace != null ? r.ace : '', r.eth != null ? r.eth : '', r.T != null ? r.T : '', r.H != null ? r.H : '', r.ctx || '', r.sample ? 'sample' : r.demo ? 'demo' : 'device']);
    });
    var csv = rows.map(function (r) { return r.map(function (c) { c = String(c); return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c; }).join(','); }).join('\n');
    var a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'glucobreath-readings.csv';
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
  }

  /* ---------- test view ---------- */
  var hints = [
    'Standby. Press the button on the device or press Start test.',
    'Get ready. Bring the inlet to about 2 cm from your mouth.',
    'Blow steadily until the countdown ends.',
    'Analyzing your breath.',
    'Result received and saved.'
  ];
  function renderTest() {
    var on = S.link === 'paired';
    $('#btn-start').disabled = !(on && (S.live.stage === 0 || S.live.stage === 4));
    $('#start-note').textContent = on ? 'You can also press the button on the device.' : 'Connect and pair a device first.';
    $('#test-hint').innerHTML = on ? esc(hints[S.live.stage]) : 'Not connected. <a class="link" href="#/device">Connect your device</a> to begin.';
    $('#mirror-link').textContent = on ? 'Linked' : 'Not connected';
    $('#mirror-name').textContent = S.dev ? S.dev.name : 'GlucoBreath';
    $$('.ctx').forEach(function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-c') === S.ctx); });
    var lbl = ['Live estimate', 'Get ready', 'During breath', 'Analyzing', 'Result'][S.live.stage] || 'Live estimate';
    $('#gauge-live-label').textContent = on ? lbl : 'Live estimate';
    gauge($('#gauge-live'), on && S.live.g > 0 ? S.live.g : null);
    drawBlow();
  }
  function drawBlow() {
    var el = $('#blow-chart'), W = Math.max(260, el.clientWidth), H = 150, m = { l: 34, r: 8, t: 8, b: 22 }, iw = W - m.l - m.r, ih = H - m.t - m.b;
    var mx = Math.max(2, Math.max.apply(null, S.blow.map(function (p) { return p.y; }).concat([0])) * 1.25);
    function X(x) { return m.l + x / 5 * iw; } function Y(y) { return m.t + (1 - y / mx) * ih; }
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="Acetone concentration during the five second breath">';
    for (var i = 0; i <= 5; i++) s += '<line class="grid" x1="' + X(i) + '" x2="' + X(i) + '" y1="' + m.t + '" y2="' + (m.t + ih) + '"/><text class="axis" x="' + X(i) + '" y="' + (H - 6) + '" text-anchor="middle">' + i + ' s</text>';
    [0, mx / 2, mx].forEach(function (v) { s += '<text class="axis" x="' + (m.l - 6) + '" y="' + (Y(v) + 3) + '" text-anchor="end">' + v.toFixed(1) + '</text>'; });
    if (S.blow.length > 1) {
      var pts = S.blow.map(function (p) { return X(p.x).toFixed(1) + ',' + Y(p.y).toFixed(1); }).join(' ');
      s += '<polygon class="fillp" points="' + X(S.blow[0].x) + ',' + Y(0) + ' ' + pts + ' ' + X(S.blow[S.blow.length - 1].x) + ',' + Y(0) + '"/><polyline class="ln" points="' + pts + '"/>';
    }
    el.innerHTML = s + '</svg>';
  }

  /* ---------- device view ---------- */
  function renderDevice() {
    var sup = !!navigator.bluetooth; $('#dev-support').hidden = sup; $('#btn-ble').disabled = !sup;
    var L = S.link;
    $('#dev-idle').hidden = L !== 'off'; $('#dev-searching').hidden = L !== 'searching'; $('#dev-pairing').hidden = L !== 'pairing'; $('#dev-linked').hidden = L !== 'paired';
    $('#demo-device').hidden = !(S.dev && S.dev.kind === 'demo' && L !== 'off');
    if (L === 'pairing') {
      $('#pair-code').textContent = grp(S.code);
      $('#ps-1').className = 'done'; $('#ps-2').className = S.pairStep >= 2 ? 'done' : 'now'; $('#ps-3').className = S.pairStep >= 2 ? 'now' : '';
      $('#pair-msg').textContent = S.pairStep >= 2 ? 'Check that your device shows the same code, then press its button to confirm.' : 'Sending the code to your device.';
    }
    if (L === 'paired') {
      $('#linked-name').textContent = S.dev.name;
      $('#linked-t').textContent = S.live.T != null ? S.live.T.toFixed(1) + ' C' : '--';
      $('#linked-h').textContent = S.live.H != null ? Math.round(S.live.H) + '%' : '--';
      $('#linked-stage').textContent = STAGES[S.live.stage] || '--';
    }
  }
  function devErr(m) { $('#dev-err').textContent = m || ''; }
  function updatePill() {
    var p = $('#linkpill'), t = $('#linkpill-t');
    p.className = 'pill' + (S.link === 'paired' ? ' on' : S.link === 'off' ? '' : ' wait');
    t.textContent = S.link === 'paired' ? S.dev.name : S.link === 'off' ? 'Not connected' : S.link === 'searching' ? 'Searching' : 'Pairing';
  }

  /* ---------- links ---------- */
  function parsePacket(dv) {
    return { type: dv.getUint8(0), stage: dv.getUint8(1), prog: dv.getUint8(2),
      g: dv.getInt16(4, true) / 100, ace: dv.getInt16(6, true) / 100, eth: dv.getInt16(8, true) / 100,
      T: dv.getInt16(10, true) / 10, H: dv.getInt16(12, true) / 10 };
  }

  function BleLink(h) { this.h = h; this.dev = null; }
  BleLink.prototype.connect = function () {
    var self = this; this.step = 'choosing a device';
    return navigator.bluetooth.requestDevice({ filters: [{ namePrefix: 'GlucoBreath' }], optionalServices: [SVC] }).then(function (d) {
      self.dev = d; d.addEventListener('gattserverdisconnected', function () { self.h.closed(); });
      self.step = 'opening the Bluetooth connection'; return d.gatt.connect();
    }).then(function (srv) { self.step = 'finding the GlucoBreath service (flash firmware v6 or newer)'; return srv.getPrimaryService(SVC); }).then(function (svc) {
      self.step = 'reading the service characteristics';
      return Promise.all([svc.getCharacteristic(C_DATA), svc.getCharacteristic(C_PAIR), svc.getCharacteristic(C_STAT), svc.getCharacteristic(C_CMD)]);
    }).then(function (c) {
      self.cData = c[0]; self.cPair = c[1]; self.cStat = c[2]; self.cCmd = c[3];
      self.cStat.addEventListener('characteristicvaluechanged', function (e) { self.h.status(e.target.value.getUint8(0)); });
      self.step = 'subscribing to status updates (needs firmware v6 or newer)'; return self.cStat.startNotifications();
    }).then(function () { return self.dev.name || 'GlucoBreath'; });
  };
  BleLink.prototype.sendPair = function (code) { this.step = 'sending the pairing code'; return this.cPair.writeValue(new TextEncoder().encode(code)); };
  BleLink.prototype.startData = function () {
    var self = this;
    this.cData.addEventListener('characteristicvaluechanged', function (e) { self.h.packet(parsePacket(e.target.value)); });
    this.step = 'subscribing to live data (needs firmware v6 or newer)'; return this.cData.startNotifications();
  };
  BleLink.prototype.cmd = function (ch) { return this.cCmd.writeValue(new TextEncoder().encode(ch)); };
  BleLink.prototype.close = function () { try { if (this.dev && this.dev.gatt.connected) this.dev.gatt.disconnect(); } catch (e) { } };

  /* Demo device: behaves like the firmware, including Delhi-like room conditions. */
  function delhi(ms) {
    var m = ms / 60000;
    return { T: Math.round((25.2 + 1.6 * Math.sin(m * 0.35) + 0.5 * Math.sin(m * 1.7)) * 10) / 10, H: Math.round((47 + 6 * Math.sin(m * 0.23 + 1.3) + 2 * Math.sin(m * 1.1)) * 10) / 10 };
  }
  function DemoLink(h) { this.h = h; this.timers = []; this.t0 = performance.now(); this.stage = 0; this.paired = false; this.code = null; }
  DemoLink.prototype.later = function (fn, ms) { var t = setTimeout(fn, ms); this.timers.push(t); return t; };
  DemoLink.prototype.emit = function (type, stage, prog, g, ace, eth) {
    var w = delhi(performance.now() - this.t0 + 3 * 60000 * 1);
    this.stage = stage; this.h.packet({ type: type, stage: stage, prog: prog, g: g, ace: ace, eth: eth, T: w.T, H: w.H });
  };
  DemoLink.prototype.connect = function () { return new Promise(function (res) { setTimeout(function () { res('GlucoBreath-DEMO'); }, 500); }); };
  DemoLink.prototype.sendPair = function (code) {
    var self = this; this.code = code; GBOled.setData({ code: code });
    return new Promise(function (res) { setTimeout(function () { self.h.status(1); res(); }, 600); });
  };
  DemoLink.prototype.touch = function () {
    if (!this.code) return;
    if (!this.paired) { this.paired = true; this.h.status(2); this.startLive(); }
    else if (this.stage === 0 || this.stage === 4) this.cmd('S');
  };
  DemoLink.prototype.startLive = function () {
    var self = this; this.live = setInterval(function () {
      if (self.stage !== 0) return; var a = 0.3 + Math.random() * 0.12; self.emit(1, 0, 0, 4.5 + 1.9 * a, a, 0.05 + Math.random() * 0.05);
    }, 1000);
    setTimeout(function () { self.emit(1, 0, 0, 4.5 + 1.9 * 0.32, 0.32, 0.06); }, 150);
  };
  DemoLink.prototype.startData = function () { return Promise.resolve(); };
  DemoLink.prototype.cmd = function (ch) {
    var self = this;
    if (ch === 'X') { return Promise.resolve(); }
    if (ch !== 'S' || !this.paired || (this.stage !== 0 && this.stage !== 4)) return Promise.resolve();
    var peak = 0.5 + Math.random() * 1.9, t = 0;
    this.emit(2, 1, 0, 4.5, 0.3, 0.06);
    this.later(function () {
      self.emit(2, 2, 0, 4.5, 0.3, 0.06);
      var iv = setInterval(function () {
        t += 250; var a = peak * (1 - Math.exp(-t / 1500)) * (0.95 + Math.random() * 0.1);
        self.emit(2, 2, Math.min(100, t / 50), 4.5 + 1.9 * a, a, 0.06 + a * 0.04);
        if (t >= 5000) { clearInterval(iv); self.finish(peak); }
      }, 250); self.timers.push(iv);
    }, 2200);
    return Promise.resolve();
  };
  DemoLink.prototype.finish = function (peak) {
    var self = this, g = 4.5 + 1.9 * peak;
    this.emit(2, 3, 100, g, peak, 0.12);
    this.later(function () { self.emit(3, 4, 100, g, peak, 0.12); self.later(function () { self.emit(1, 0, 0, 4.5 + 1.9 * 0.32, 0.32, 0.06); }, 14000); }, 3000);
  };
  DemoLink.prototype.close = function () { this.timers.forEach(function (t) { clearTimeout(t); clearInterval(t); }); clearInterval(this.live); };

  var handlers = {
    status: function (code) {
      if (code === 1) { S.pairStep = 2; renderDevice(); }
      else if (code === 2) {
        clearTimeout(S.pairTimer);
        var l = S.dev.link;
        Promise.resolve(l.startData()).then(function () {
          S.link = 'paired'; S.live = { stage: 0, prog: 0, g: 0, ace: 0, eth: 0, T: null, H: null }; S.stageAt = performance.now(); S.blow = [];
          GBOled.setData({ linked: true }); devErr(''); updatePill(); redrawAll(); toast('Paired with ' + S.dev.name);
        }, function (e) { failPair('Paired, but live data could not start (' + ((l && l.step) || 'live data') + '): ' + (e && e.name ? e.name + ': ' : '') + e.message); });
      }
      else if (code === 3) failPair('Pairing was cancelled or timed out on the device.');
      else if (code === 4) failPair('The device is busy, warming up or running a test. Try again in a moment.');
    },
    packet: onPacket,
    closed: function () { if (S.link !== 'off') { var was = S.link === 'paired'; resetLink(); if (was) toast('Device disconnected'); else devErr('The device disconnected.'); } }
  };

  function resetLink() {
    clearTimeout(S.pairTimer); S.link = 'off'; S.dev = null; S.code = ''; S.pairStep = 1; S.blow = [];
    S.live = { stage: 0, prog: 0, g: 0, ace: 0, eth: 0, T: null, H: null }; GBOled.setData({ linked: false });
    updatePill(); redrawAll();
  }
  function failPair(msg) { var l = S.dev && S.dev.link; if (l) l.close(); resetLink(); devErr(msg); }
  function disconnect(silent) { var l = S.dev && S.dev.link; if (l) l.close(); if (S.link !== 'off') resetLink(); if (!silent) toast('Disconnected'); }

  function beginLink(kind) {
    if (S.link !== 'off') return; devErr('');
    var link = kind === 'demo' ? new DemoLink(handlers) : new BleLink(handlers);
    S.link = 'searching'; S.dev = { kind: kind, link: link, name: '' }; updatePill(); renderDevice();
    link.connect().then(function (name) {
      S.dev.name = name; S.link = 'pairing'; S.pairStep = 1; S.code = rand6(); GBOled.setData({ code: S.code });
      updatePill(); renderDevice();
      S.pairTimer = setTimeout(function () { if (S.link === 'pairing') failPair('The device did not confirm in time.'); }, 50000);
      return link.sendPair(S.code);
    }).catch(function (e) {
      var msg = e && e.name === 'NotFoundError' && link.step === 'choosing a device' ? 'No device was selected.' : 'Could not connect while ' + (link.step || 'starting') + '. ' + (e && e.name ? e.name + ': ' : '') + (e && e.message ? e.message : e) + '. Turn the device off and on, forget it in your phone Bluetooth settings, reload this page and try again.';
      if (S.link !== 'off') { try { link.close(); } catch (x) { } resetLink(); } devErr(msg);
    });
  }

  function onPacket(p) {
    var L = S.live, changed = p.stage !== L.stage;
    if (changed) { S.stageAt = performance.now(); if (p.stage === 2) S.blow = []; }
    S.live = { stage: p.stage, prog: p.prog, g: p.g, ace: p.ace, eth: p.eth, T: p.T, H: p.H };
    GBOled.setData({ g: p.g, ace: p.ace, eth: p.eth, t: p.T, h: p.H });
    if (p.type === 2 && p.stage === 2) { S.blow.push({ x: p.prog / 100 * 5, y: p.ace }); }
    if (p.type === 3) {
      var rd = { id: uid(), ts: Date.now(), g: p.g, ace: p.ace, eth: p.eth, T: p.T, H: p.H, ctx: S.ctx };
      if (S.dev && S.dev.kind === 'demo') rd.demo = true;
      addReading(rd);
      $('#last-result').hidden = false; $('#lr-val').textContent = fmt(p.g) + ' ' + unit(); chip($('#lr-chip'), p.g);
      toast('Reading saved: ' + fmt(p.g) + ' ' + unit());
    }
    if (S.view === 'test') { renderTest(); }
    else if (S.view === 'device') renderDevice();
    else if (S.view === 'dashboard' && p.type === 3) renderDashboard();
  }

  /* ---------- mirror / demo canvases ---------- */
  var lastFrame = 0, art = { t0: performance.now() };
  function frame(now) {
    requestAnimationFrame(frame);
    if (document.hidden || now - lastFrame < 50) return; lastFrame = now;
    if (!$('#auth').hidden) { var ac = $('#auth-canvas'); GBOled.render(ac, 'resA', ((now - art.t0) % 9000), null, 5, 1); return; }
    if (S.view === 'test') {
      var mc = $('#mirror'), name = 'off', t = now - S.stageAt;
      if (S.link === 'paired') { name = ['home', 'ready', 'blow', 'analyze', (t % 9000 < 5500 ? 'resA' : 'resB')][S.live.stage]; }
      if (name === 'resB') t = t % 9000 - 5500;
      if (name === 'resA') t = t % 9000;
      GBOled.render(mc, name, t, null, 5, 1);
    }
    if (S.view === 'device' && S.dev && S.dev.kind === 'demo' && S.link !== 'off') {
      var dc = $('#demo-canvas'), nm = S.link === 'pairing' && S.pairStep >= 2 ? 'pair' : S.link === 'paired' ? ['home', 'ready', 'blow', 'analyze', 'resA'][S.live.stage] : 'warm';
      GBOled.render(dc, nm, now - S.stageAt, { frac: .5 }, 5, 1);
    }
  }
  function startAuthArt() { art.t0 = performance.now(); }

  /* ---------- boot ---------- */
  function enter(email) {
    var u = users()[email]; if (!u) { sset('gb.session', ''); return; }
    S.user = { email: email, name: u.name }; loadData(email);
    $('#auth').hidden = true; $('#app').hidden = false; authErr('');
    $('#acct-initial').textContent = u.name.trim().charAt(0).toUpperCase(); $('#acct-name').textContent = u.name; $('#acct-email').textContent = email;
    ['#in-email', '#in-pass', '#up-name', '#up-email', '#up-pass'].forEach(function (i) { $(i).value = ''; });
    updatePill();
    if (!location.hash) location.hash = '#/dashboard'; route();
  }

  function bind() {
    $('#tab-in').addEventListener('click', function () { authTab(false); }); $('#tab-up').addEventListener('click', function () { authTab(true); });
    $('#form-in').addEventListener('submit', signIn); $('#form-up').addEventListener('submit', signUp);
    $('#t-light').addEventListener('click', function () { setTheme('light'); }); $('#t-dark').addEventListener('click', function () { setTheme('dark'); });
    $('#menu-theme').addEventListener('click', function () { setTheme(curTheme() === 'dark' ? 'light' : 'dark'); });
    $('#acct-btn').addEventListener('click', function (e) { e.stopPropagation(); var m = $('#acct-menu'); m.hidden = !m.hidden; this.setAttribute('aria-expanded', !m.hidden); });
    document.addEventListener('click', function (e) { if (!e.target.closest('.acct')) { $('#acct-menu').hidden = true; $('#acct-btn').setAttribute('aria-expanded', 'false'); } });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') $('#acct-menu').hidden = true; });
    $('#signout').addEventListener('click', signOut);
    window.addEventListener('hashchange', route);
    var rz; window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(redrawAll, 120); });

    $('#unit-mmol').addEventListener('click', function () { S.data.unit = 'mmol'; saveData(); redrawAll(); });
    $('#unit-mgdl').addEventListener('click', function () { S.data.unit = 'mgdl'; saveData(); redrawAll(); });
    $$('.rng').forEach(function (b) { b.addEventListener('click', function () { S.range = +b.getAttribute('data-r'); renderDashboard(); }); });
    $('#btn-sample').addEventListener('click', function () { S.data.readings = S.data.readings.concat(sampleReadings()).sort(function (a, b) { return a.ts - b.ts; }); saveData(); renderDashboard(); toast('Sample readings loaded'); });

    $$('.ctx').forEach(function (b) { b.addEventListener('click', function () { S.ctx = b.getAttribute('data-c'); renderTest(); }); });
    $('#btn-start').addEventListener('click', function () { if (S.dev) S.dev.link.cmd('S').catch(function (e) { toast('Could not start: ' + e.message); }); });

    $('#hist-filter').addEventListener('change', renderHistory);
    $('#btn-csv').addEventListener('click', exportCsv);
    $('#btn-clear-sample').addEventListener('click', function () { S.data.readings = S.data.readings.filter(function (r) { return !r.sample; }); saveData(); renderHistory(); toast('Sample readings removed'); });
    $('#hist-body').addEventListener('click', function (e) {
      var b = e.target.closest('.del'); if (!b) return;
      if (b.getAttribute('data-arm')) { S.data.readings = S.data.readings.filter(function (r) { return r.id !== b.getAttribute('data-id'); }); saveData(); renderHistory(); toast('Reading deleted'); }
      else { b.setAttribute('data-arm', '1'); b.textContent = 'Confirm delete'; setTimeout(function () { if (b.isConnected) { b.removeAttribute('data-arm'); b.textContent = 'Delete'; } }, 3000); }
    });

    $('#btn-ble').addEventListener('click', function () { beginLink('ble'); });
    $('#btn-demo').addEventListener('click', function () { beginLink('demo'); });
    $('#btn-nomatch').addEventListener('click', function () { var l = S.dev && S.dev.link; if (l) { try { l.cmd('X'); } catch (e) { } } failPair('Pairing cancelled. Choose your device again and compare the codes.'); });
    $('#btn-disc').addEventListener('click', function () { disconnect(false); });
    $('#demo-touch').addEventListener('click', function () { if (S.dev && S.dev.kind === 'demo') S.dev.link.touch(); });
  }

  function init() {
    bind(); markTheme(); requestAnimationFrame(frame);
    var ready = function () {
      var email = sget('gb.session');
      if (email && users()[email]) enter(email); else { $('#auth').hidden = false; startAuthArt(); }
    };
    ready();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(function () { if (S.user) redrawAll(); });
  }
  init();
})();
