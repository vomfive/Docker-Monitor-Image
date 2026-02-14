document.addEventListener('DOMContentLoaded', () => {
  const tbody = document.getElementById('tbody');
  const unusedCountElem = document.getElementById('unusedCount');
  const pruneBtn = document.getElementById('prune');

  const settingsBtn = document.getElementById('settingsBtn');
  const settingsModal = document.getElementById('settingsModal');
  const settingsCloseBtn = document.getElementById('settingsClose');
  const settingsSaveBtn = document.getElementById('settingsSave');
  const useApiKeyCheckbox = document.getElementById('useApiKey');
  const apiKeyInput = document.getElementById('apiKeyInput');
  const generateApiKeyBtn = document.getElementById('generateApiKey');
  const ipAllowInput = document.getElementById('ipAllowInput');
  const langSelect = document.getElementById('langSelect');
  const refreshNowBtn = document.getElementById('refreshNow');

  let authState = { auth_enabled: false, api_key: '', allowed_cidrs: [] };
  let sessionActive = false;
  let isRendering = false;
  let sseConnected = false;
  const FALLBACK_REFRESH_MS = 10000;
  const METRICS_REFRESH_MS = 8000;


  function isMaskedKey(s) {
    return typeof s === 'string' && /^\*+$/.test(s.trim());
  }

  const I18N = {
    fr: {
      brand: 'Docker Monitor Image',
      refresh: 'Rafra\u00eechir',
      prune: 'Nettoyer',
      settings: 'R\u00e9glages',
      th_container: 'Conteneur',
      th_state: '\u00c9tat & Ressources',
      th_status: 'Statut',
      th_link: 'Lien',
      th_action: 'Action',
      settings_title: 'R\u00e9glages',
      language_label: 'Langue de l\u2019interface',
      auth_label: "Activer l'authentification par cl\u00e9 API",
      generate: 'G\u00e9n\u00e9rer',
      cidr_title: 'IP autoris\u00e9es (CIDR)',
      cidr_hint: 'Une plage par ligne. Par d\u00e9faut : 0.0.0.0/0 (tout le monde). IPv6 support\u00e9 (ex: ::/0).',
      save: 'Enregistrer',
      ha_doc: '\u2197 Int\u00e9gration Home Assistant : documentation officielle',
      auth_hint: "Astuce : si l'auth est d\u00e9sactiv\u00e9e, aucune cl\u00e9 n'est requise. Les IP autoris\u00e9es s'appliquent toujours.",
      loading: 'Chargement\u2026',
      refresh_ing: 'Rafra\u00eechir\u2026',
      cleaned_ok: 'Nettoyage termin\u00e9. Espace r\u00e9cup\u00e9r\u00e9: {bytes} octets.',
      clean_fail: '\u00c9chec du nettoyage: {err}',
      update_btn: 'Mettre \u00e0 jour',
      updated_ok: '\u2705 {name} mis \u00e0 jour',
      up_to_date: '\u2705 {name} est d\u00e9j\u00e0 \u00e0 jour',
      update_fail: '\u274c {name}: {err}',
      refresh_fail: '\u00c9chec du rafra\u00eechissement: {err}',
      pending: 'pending\u2026',
      CPU: 'CPU',
      RAM: 'RAM',
      NET: 'NET',
      state_running: 'running',
      state_loading: 'Chargement\u2026',
      settings_saved: 'R\u00e9glages enregistr\u00e9s',
      gen_failed: 'Erreur lors de la g\u00e9n\u00e9ration: ',
    },
    en: {
      brand: 'Docker Monitor Image',
      refresh: 'Refresh',
      prune: 'Prune',
      settings: 'Settings',
      th_container: 'Container',
      th_state: 'State & Resources',
      th_status: 'Status',
      th_link: 'Link',
      th_action: 'Action',
      settings_title: 'Settings',
      language_label: 'Interface language',
      auth_label: 'Enable API key authentication',
      generate: 'Generate',
      cidr_title: 'Allowed IPs (CIDR)',
      cidr_hint: 'One network per line. Default: 0.0.0.0/0 (everyone). IPv6 supported (e.g. ::/0).',
      save: 'Save',
      ha_doc: '\u2197 Home Assistant Integration: official docs',
      auth_hint: 'Tip: if auth is disabled, no key is required. Allowed IPs always apply.',
      loading: 'Loading\u2026',
      refresh_ing: 'Refreshing\u2026',
      cleaned_ok: 'Prune done. Space reclaimed: {bytes} bytes.',
      clean_fail: 'Prune failed: {err}',
      update_btn: 'Update',
      updated_ok: '\u2705 {name} updated',
      up_to_date: '\u2705 {name} is already up to date',
      update_fail: '\u274c {name}: {err}',
      refresh_fail: 'Refresh failed: {err}',
      pending: 'pending\u2026',
      CPU: 'CPU',
      RAM: 'RAM',
      NET: 'NET',
      state_running: 'running',
      state_loading: 'Loading\u2026',
      settings_saved: 'Settings saved',
      gen_failed: 'Generation failed: ',
    }
  };
  let LANG = localStorage.getItem('dm_lang') || (navigator.language || 'fr').slice(0,2);
  if (!['fr','en'].includes(LANG)) LANG = 'fr';

  function t(key, vars) {
    const s = (I18N[LANG] && I18N[LANG][key]) || I18N.fr[key] || key;
    if (!vars) return s;
    return s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
  }

  function applyStaticTranslations() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const key = el.getAttribute('data-i18n');
      el.textContent = t(key);
    });
    if (apiKeyInput) apiKeyInput.placeholder = (LANG === 'en' ? 'API key' : 'Cl\u00e9 API');
    document.title = t('brand');
    try { document.documentElement.setAttribute('lang', LANG); } catch {}
    if (langSelect) langSelect.value = LANG;
  }

  function buildUrl(path, params) {
    const q = new URLSearchParams(params || {});
    return path + (q.toString() ? ('?' + q.toString()) : '');
  }

  // Auth via Authorization header (preferred over query param)
  function authHeaders() {
    const h = {};
    if (!sessionActive && authState.auth_enabled && authState.api_key && !isMaskedKey(authState.api_key)) {
      h['Authorization'] = 'Bearer ' + authState.api_key;
    }
    return h;
  }

  // Query param key — only used for SSE EventSource (no header support)
  function sseKeyParams() {
    const p = {};
    if (!sessionActive && authState.auth_enabled && authState.api_key && !isMaskedKey(authState.api_key)) {
      p.key = authState.api_key;
    }
    return p;
  }

  async function fetchJSON(path, { method='GET', params=null, body=null, headers=null, useKeyFallback=true } = {}) {
    const url = params ? buildUrl(path, params) : path;
    const opts = {
      method,
      headers: { ...(headers || {}), ...authHeaders() },
      credentials: 'include'
    };
    if (body != null) {
      opts.body = typeof body === 'string' ? body : JSON.stringify(body);
      if (!opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json';
    }

    let res = await fetch(url, opts);
    if (res.status === 401 && useKeyFallback && !sessionActive && authState.auth_enabled && authState.api_key && !isMaskedKey(authState.api_key)) {
      // Last resort: key in URL (for proxies that strip headers)
      const urlWithKey = buildUrl(path, { ...(params || {}), key: authState.api_key });
      res = await fetch(urlWithKey, opts);
    }
    if (!res.ok) {
      const errText = await res.text().catch(()=> '');
      const err = new Error(errText || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json().catch(()=> ({}));
  }

  async function tryStartSessionWithApiKey() {
    if (!authState.auth_enabled) return false;
    const k = authState.api_key;
    if (!k || isMaskedKey(k)) return false;
    try {
      const data = await fetchJSON('/auth/login', {
        method: 'POST',
        body: { api_key: k },
        useKeyFallback: false
      });
      if (data && data.status === 'ok') {
        sessionActive = true;
        return true;
      }
    } catch {
    }
    return false;
  }

  function formatBytes(b) {
    if (b == null) return '0 B';
    const u = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let i = 0, n = Number(b);
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (Math.round(n * 10) / 10) + ' ' + u[i];
  }
  function clampPct(n) {
    const x = isNaN(n) ? 0 : Number(n);
    if (!isFinite(x)) return 0;
    return Math.max(0, Math.min(100, x));
  }
  function fmtPct(n) {
    if (n == null || isNaN(n)) return '0%';
    return (Math.round(n * 10) / 10) + '%';
  }
  function tag(status) {
    const cls = status === 'up_to_date' ? 'ok'
              : status === 'update_available' ? 'warn'
              : status === 'not_found' ? 'muted'
              : 'err';
    const span = document.createElement('span');
    span.className = 'tag ' + cls;
    span.textContent = status;
    return span;
  }
  function repoLinkFromImage(imageRef) {
    if (!imageRef) return null;
    let ref = String(imageRef).trim();
    if (ref.startsWith('[') && ref.endsWith(']')) ref = ref.slice(1, -1);
    const repoPath = ref.split(':')[0];
    if (repoPath.startsWith('ghcr.io/')) return `https://github.com/${repoPath.replace(/^ghcr\.io\//, '')}`;
    if (repoPath.startsWith('lscr.io/linuxserver/')) return `https://github.com/linuxserver/docker-${repoPath.split('/').pop()}`;
    if (!repoPath.includes('/')) return `https://hub.docker.com/_/${repoPath}`;
    const first = repoPath.split('/')[0];
    if (!first.includes('.') && !first.includes(':')) return `https://hub.docker.com/r/${repoPath}`;
    return null;
  }
  function repoLabelFromImage(imageRef) {
    if (!imageRef) return null;
    let ref = String(imageRef).trim();
    if (ref.startsWith('[') && ref.endsWith(']')) ref = ref.slice(1, -1);
    const idx = ref.lastIndexOf(':');
    const tagStr = idx > -1 ? ref.slice(idx) : '';
    let repoPath = idx > -1 ? ref.slice(0, idx) : ref;
    return repoPath.replace(/^ghcr\.io\//, '').replace(/^lscr\.io\//, '').replace(/^registry-1\.docker\.io\//, '').replace(/^library\//, '') + tagStr;
  }
  function stateClass(s) {
    const v = String(s || '').toLowerCase();
    if (['running', 'healthy'].includes(v)) return 'state--ok';
    if (['restarting', 'starting', 'unhealthy'].includes(v)) return 'state--warn';
    if (['exited', 'dead', 'removing', 'error'].includes(v)) return 'state--err';
    if (['paused', 'created'].includes(v)) return 'state--muted';
    return 'state--muted';
  }

  const netPrev = new Map();
  let netPeakBps = 2 * 1024 * 1024;
  const cpuEma = new Map();
  const ramEma = new Map();
  function emaUpdate(map, name, value, alpha = 0.3) {
    if (typeof value !== 'number' || !isFinite(value)) return 0;
    const prev = map.get(name);
    const next = (prev == null) ? value : (alpha * value + (1 - alpha) * prev);
    map.set(name, next);
    return next;
  }
  function formatRate(bps) {
    const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
    let i = 0, n = Math.max(0, Number(bps) || 0);
    while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
    return (Math.round(n * 10) / 10) + ' ' + units[i];
  }
  function computeNetRate(name, m) {
    const now = Date.now();
    const rx = Number(m?.net_rx || 0);
    const tx = Number(m?.net_tx || 0);
    const prev = netPrev.get(name);
    netPrev.set(name, { t: now, rx, tx });
    if (!prev || !prev.t) return { rxps: 0, txps: 0, dt: 0 };
    const dt = (now - prev.t) / 1000;
    if (dt <= 0) return { rxps: 0, txps: 0, dt: 0 };
    const rxps = Math.max(0, (rx - prev.rx) / dt);
    const txps = Math.max(0, (tx - prev.tx) / dt);
    const sum = rxps + txps;
    netPeakBps = Math.max(netPeakBps, sum * 1.2, 1 * 1024 * 1024);
    return { rxps, txps, dt };
  }

  // ---------- Safe DOM helpers ----------
  function setLinkCell(td, imageRef) {
    td.innerHTML = '';
    const link = repoLinkFromImage(imageRef);
    const label = repoLabelFromImage(imageRef);
    if (link) {
      const a = document.createElement('a');
      a.href = link;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.textContent = label || '';
      td.appendChild(a);
    } else {
      td.textContent = label || '\u2014';
    }
  }

  // ---------- API wrappers ----------
  async function fetchSettings() {
    const data = await fetchJSON('/settings');
    authState = {
      auth_enabled: !!data.auth_enabled,
      api_key: isMaskedKey(data.api_key) ? '' : (data.api_key || ''),
      allowed_cidrs: Array.isArray(data.allowed_cidrs) ? data.allowed_cidrs : []
    };
    return authState;
  }
  async function saveSettings(payload) {
    const data = await fetchJSON('/settings', { method: 'POST', body: payload });
    authState = {
      auth_enabled: !!data.auth_enabled,
      api_key: isMaskedKey(data.api_key) ? '' : (data.api_key || ''),
      allowed_cidrs: Array.isArray(data.allowed_cidrs) ? data.allowed_cidrs : []
    };
    return data;
  }
  async function fetchUnusedImages() {
    try {
      const data = await fetchJSON('/images/unused');
      if (unusedCountElem) unusedCountElem.textContent = (typeof data.count === 'number') ? data.count : '\u2014';
    } catch {
      if (unusedCountElem) unusedCountElem.textContent = '\u2014';
    }
  }
  async function pruneUnused() {
    if (!confirm(t('prune') + ' ?')) return;
    if (pruneBtn) pruneBtn.disabled = true;
    try {
      const data = await fetchJSON('/images/prune', { method: 'POST' });
      const reclaimed = (data.SpaceReclaimed != null ? data.SpaceReclaimed : 0);
      alert(t('cleaned_ok', { bytes: reclaimed }));
      await fetchUnusedImages();
      await render(true, true);
    } catch (e) {
      alert(t('clean_fail', { err: e.message }));
    } finally {
      if (pruneBtn) pruneBtn.disabled = false;
    }
  }
  async function fetchStatus({ force=false, light=false } = {}) {
    const params = {};
    if (force) params.force = '1';
    if (light) params.light = '1';
    return await fetchJSON('/status', { params });
  }
  async function fetchStatusOne(name, force=false) {
    const params = force ? { force: '1' } : {};
    return await fetchJSON(`/status/${encodeURIComponent(name)}`, { params });
  }

  // ---------- Batch metrics (single call instead of N) ----------
  async function fetchAllMetrics() {
    try {
      const data = await fetchJSON('/metrics');
      if (!data || data.status !== 'ok' || !data.metrics) return;
      for (const [name, m] of Object.entries(data.metrics)) {
        const tr = document.getElementById(`row-${name}`);
        if (!tr) continue;
        renderResourcesCell(tr.children[1], m, name);
      }
    } catch (e) { /* soft fail */ }
  }

  async function fetchMetricsOne(name) {
    try {
      const data = await fetchJSON(`/metrics/${encodeURIComponent(name)}`);
      const tr = document.getElementById(`row-${name}`);
      if (!tr) return;
      const m = data.meta || {};
      renderResourcesCell(tr.children[1], m, name);
    } catch (e) { /* soft */ }
  }

  async function updateContainer(name, btn) {
    if (btn) { btn.disabled = true; btn.textContent = t('update_btn'); }
    try {
      const data = await fetchJSON('/update_container', {
        method: 'POST',
        body: { name }
      });
      if (data && (data.updated === false || /already up to date/i.test(String(data.message||'')))) {
        alert(t('up_to_date', { name }));
        await render(false);
        return;
      }
      if (data && (data.updated === true || /recreated|updated|pulled/i.test(String(data.message||'')))) {
        alert(t('updated_ok', { name }));
      }
      await render(true, true);
    } catch (e) {
      alert(t('update_fail', { name, err: e.message }));
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = t('update_btn'); }
    }
  }

  function renderResourcesLoading(td) {
    if (!td) return;
    td.innerHTML = '';
    td.className = 'rescell';
    const state = document.createElement('div');
    state.className = 'rescell__state state--muted';
    state.innerHTML = '<span class="spinner"></span> ' + t('loading');
    td.appendChild(state);
    const metrics = document.createElement('div');
    metrics.className = 'rescell__metrics';
    const skeleton = (labelTxt) => {
      const box = document.createElement('div'); box.className = 'metric';
      const label = document.createElement('div'); label.className = 'meter__label'; label.textContent = labelTxt; box.appendChild(label);
      const meter = document.createElement('div'); meter.className = 'meter';
      const bar = document.createElement('div'); bar.className = 'meter__bar'; bar.style.width = '35%'; meter.appendChild(bar); box.appendChild(meter);
      const val = document.createElement('div'); val.className = 'meter__val'; val.textContent = '\u2014'; box.appendChild(val);
      return box;
    };
    metrics.appendChild(skeleton(t('CPU')));
    metrics.appendChild(skeleton(t('RAM')));
    metrics.appendChild(skeleton(t('NET')));
    td.appendChild(metrics);
    td.setAttribute('data-has-metrics', '0');
  }
  function renderResourcesCell(td, m, name) {
    td.innerHTML = '';
    td.className = 'rescell';
    const state = document.createElement('div');
    state.className = 'rescell__state ' + stateClass(m?.state);
    state.textContent = m?.state || '\u2014';
    td.appendChild(state);
    const metrics = document.createElement('div'); metrics.className = 'rescell__metrics';

    const makeBarMetric = (labelTxt, pctVal, suffixText) => {
      const box = document.createElement('div'); box.className = 'metric';
      const label = document.createElement('div'); label.className = 'meter__label'; label.textContent = labelTxt; box.appendChild(label);
      const meter = document.createElement('div'); meter.className = 'meter';
      const bar = document.createElement('div'); bar.className = 'meter__bar';
      const pct = clampPct(pctVal); bar.style.width = pct + '%';
      meter.appendChild(bar); box.appendChild(meter);
      if (suffixText) { const val = document.createElement('div'); val.className = 'meter__val'; val.textContent = suffixText; box.appendChild(val); }
      return box;
    };

    if (typeof m?.cpu === 'number') {
      const cpuPctRaw = clampPct(m.cpu);
      const cpuPctSmoothed = clampPct(emaUpdate(cpuEma, name, cpuPctRaw));
      metrics.appendChild(makeBarMetric(t('CPU'), cpuPctSmoothed, (Math.round(cpuPctSmoothed * 10) / 10) + '%'));
    }
    if (typeof m?.mem_usage === 'number' && typeof m?.mem_limit === 'number' && m.mem_limit > 0) {
      const memPctRaw = clampPct((m.mem_usage / m.mem_limit) * 100);
      const memPctSmoothed = clampPct(emaUpdate(ramEma, name, memPctRaw));
      metrics.appendChild(makeBarMetric(t('RAM'), memPctSmoothed, `${(Math.round(memPctSmoothed * 10) / 10)}%`));
    }
    if (name) {
      const { rxps, txps } = computeNetRate(name, m);
      const sum = rxps + txps;
      const scale = Math.max(netPeakBps, 1);
      const pct = clampPct((sum / scale) * 100);
      const suffix = `\u2191 ${formatRate(txps)} \u2022 \u2193 ${formatRate(rxps)}`;
      metrics.appendChild(makeBarMetric(t('NET'), pct, suffix));
    }

    td.appendChild(metrics);
    td.setAttribute('data-has-metrics', '1');
  }

  function applyData(data, { pending = false } = {}) {
    if (!data || data.status !== 'ok' || !tbody) return;
    const entries = Object.entries(data.updates || {});
    const namesSet = new Set(entries.map(([n]) => n));

    for (const row of Array.from(tbody.querySelectorAll('tr'))) {
      const id = row.id || '';
      if (!id.startsWith('row-')) continue;
      const name = id.slice(4);
      if (!namesSet.has(name)) {
        tbody.removeChild(row);
        netPrev.delete(name);
        cpuEma.delete(name);
        ramEma.delete(name);
      }
    }

    for (const [name, st] of entries) {
      let tr = document.getElementById(`row-${name}`);
      if (!tr) {
        tr = document.createElement('tr');
        tr.id = `row-${name}`;

        const tdName = document.createElement('td');
        const strong = document.createElement('strong');
        strong.textContent = name;
        tdName.appendChild(strong);

        const tdRes = document.createElement('td'); tdRes.className = 'rescell';

        const tdStatus = document.createElement('td'); tdStatus.className = 'status';

        const tdLink = document.createElement('td'); tdLink.className = 'link';

        const tdAct = document.createElement('td'); tdAct.className = 'action';
        const btnUpdate = document.createElement('button');
        btnUpdate.textContent = t('update_btn');
        btnUpdate.className = 'btn';
        btnUpdate.onclick = () => updateContainer(name, btnUpdate);

        const btnRefresh = document.createElement('button');
        btnRefresh.textContent = '\u21bb ' + t('refresh');
        btnRefresh.className = 'btn';
        btnRefresh.style.marginLeft = '8px';
        btnRefresh.onclick = async (ev) => {
          const btn = ev.currentTarget;
          const old = btn.innerHTML;
          btn.disabled = true;
          renderResourcesLoading(tdRes);
          btn.innerHTML = `<span class="spinner"></span> ${t('refresh_ing')}`;
          try {
            const one = await fetchStatusOne(name, true);
            const st2 = one.updates[name];
            const m2 = one.meta[name] || {};
            tdStatus.innerHTML = '';
            tdStatus.appendChild(tag(st2));
            renderResourcesCell(tdRes, m2, name);
            setLinkCell(tdLink, m2.image);
          } catch (e) {
            alert(e.message);
          } finally {
            btn.disabled = false;
            btn.innerHTML = old;
          }
        };
        tdAct.appendChild(btnUpdate);
        tdAct.appendChild(btnRefresh);

        tr.appendChild(tdName);
        tr.appendChild(tdRes);
        tr.appendChild(tdStatus);
        tr.appendChild(tdLink);
        tr.appendChild(tdAct);
        tbody.appendChild(tr);
      }

      const m = (data.meta && data.meta[name]) || {};
      const statusCell = tr.children[2];
      statusCell.innerHTML = '';
      if (pending) {
        statusCell.innerHTML = `<span class="tag muted">${t('pending')}</span>`;
        renderResourcesLoading(tr.children[1]);
      } else {
        statusCell.appendChild(tag(st));
        const tdRes = tr.children[1];
        if (tdRes.getAttribute('data-has-metrics') !== '1') {
          renderResourcesLoading(tdRes);
        }
      }

      setLinkCell(tr.children[3], m.image);

      const btnUpdate = tr.children[4].querySelector('button');
      if (btnUpdate) btnUpdate.disabled = (!pending) && (st === 'not_found' || (typeof st === 'string' && st.startsWith('error')));
    }
  }

  async function render(force=false, showLoading=false) {
    if (isRendering) return;
    isRendering = true;
    try {
      if (showLoading && tbody) {
        for (const tr of Array.from(tbody.querySelectorAll('tr'))) {
          const tdRes = tr.children[1];
          const tdStatus = tr.children[2];
          if (tdStatus) tdStatus.innerHTML = `<span class="tag muted">${t('pending')}</span>`;
          if (tdRes) renderResourcesLoading(tdRes);
        }
      }
      const data = await fetchStatus({ force, light: true });
      if (data && data.status === 'ok') {
        try { localStorage.setItem('dm_cache', JSON.stringify({ t: Date.now(), data })); } catch {}
        applyData(data, { pending: false });
        fetchAllMetrics();
      }
    } catch (e) {
      console.error(e);
      try {
        const raw = localStorage.getItem('dm_cache');
        if (raw) {
          const cache = JSON.parse(raw);
          if (cache && cache.data && cache.data.status === 'ok') {
            applyData(cache.data, { pending: true });
          }
        }
      } catch {}
    } finally {
      isRendering = false;
    }
  }

  // ---------- SSE — Server-Sent Events ----------
  let evtSource = null;
  let sseRetryTimeout = null;

  function buildSseUrl() {
    const params = sseKeyParams();
    const qs = new URLSearchParams(params).toString();
    return '/events' + (qs ? '?' + qs : '');
  }

  function connectSSE() {
    if (evtSource) {
      try { evtSource.close(); } catch {}
    }
    try {
      evtSource = new EventSource(buildSseUrl());
    } catch {
      sseConnected = false;
      return;
    }

    evtSource.addEventListener('connected', () => {
      sseConnected = true;
    });

    evtSource.addEventListener('status', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data && data.status === 'ok') {
          applyData(data, { pending: false });
          try { localStorage.setItem('dm_cache', JSON.stringify({ t: Date.now(), data })); } catch {}
        }
      } catch (err) {
        console.error('[SSE] parse error', err);
      }
    });

    evtSource.onerror = () => {
      sseConnected = false;
      try { evtSource.close(); } catch {}
      evtSource = null;
      if (sseRetryTimeout) clearTimeout(sseRetryTimeout);
      sseRetryTimeout = setTimeout(connectSSE, 5000);
    };
  }

  // ---------- Settings UI ----------
  function openSettings() {
    fetchSettings()
      .then(s => {
        if (useApiKeyCheckbox) useApiKeyCheckbox.checked = !!s.auth_enabled;
        if (apiKeyInput) {
          apiKeyInput.value = '';
          apiKeyInput.placeholder = '********';
        }
        if (ipAllowInput) ipAllowInput.value = (Array.isArray(s.allowed_cidrs) ? s.allowed_cidrs : ['0.0.0.0/0']).join('\n');
        if (settingsModal) { settingsModal.style.display = 'block'; settingsModal.setAttribute('aria-hidden', 'false'); }
      })
      .catch(() => {
        if (settingsModal) { settingsModal.style.display = 'block'; settingsModal.setAttribute('aria-hidden', 'false'); }
      });
  }
  function closeSettings() {
    if (settingsModal) { settingsModal.style.display = 'none'; settingsModal.setAttribute('aria-hidden', 'true'); }
  }
  async function onSaveSettings() {
    try {
      const allowed = ipAllowInput ? ipAllowInput.value.split('\n').map(s => s.trim()).filter(Boolean) : [];
      const payload = {
        auth_enabled: !!(useApiKeyCheckbox && useApiKeyCheckbox.checked),
        allowed_cidrs: allowed
      };
      const maybeKey = apiKeyInput ? apiKeyInput.value.trim() : '';
      if (maybeKey && !isMaskedKey(maybeKey)) {
        payload.api_key = maybeKey;
      }
      await saveSettings(payload);
      alert(t('settings_saved'));
      closeSettings();

      if (authState.auth_enabled) {
        await tryStartSessionWithApiKey();
      }

      connectSSE();
      render(true);
    } catch (e) {
      alert((LANG === 'en' ? 'Error while saving: ' : 'Erreur lors de l\u2019enregistrement: ') + e.message);
    }
  }
  async function onGenerateApiKey() {
    try {
      const allowed = ipAllowInput ? ipAllowInput.value.split('\n').map(s => s.trim()).filter(Boolean) : [];
      const data = await saveSettings({
        auth_enabled: true,
        generate_api_key: true,
        allowed_cidrs: allowed
      });
      if (apiKeyInput) {
        apiKeyInput.value = data.api_key || '';
      }
      if (useApiKeyCheckbox) useApiKeyCheckbox.checked = !!data.auth_enabled;

      await tryStartSessionWithApiKey();
    } catch (e) {
      alert(t('gen_failed') + e.message);
    }
  }

  if (pruneBtn) pruneBtn.addEventListener('click', pruneUnused);

  async function handleToolbarRefresh(btn) {
    if (!btn || btn.disabled) return;
    const oldHtml = btn.innerHTML;
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner"></span> ${t('refresh_ing')}`;
    try {
      await render(true, true);
      setTimeout(() => fetchAllMetrics(), 200);
    } catch (err) {
      console.error(err);
      alert(t('refresh_fail', { err: (err?.message || err) }));
    } finally {
      btn.disabled = false;
      btn.innerHTML = oldHtml;
    }
  }
  document.addEventListener('click', (ev) => {
    const btn = ev.target.closest('#refreshNow, [data-action="refresh"], #toolbar-refresh');
    if (!btn) return;
    ev.preventDefault();
    handleToolbarRefresh(btn);
  });

  if (settingsBtn) settingsBtn.addEventListener('click', openSettings);
  if (settingsCloseBtn) settingsCloseBtn.addEventListener('click', closeSettings);
  if (settingsSaveBtn) settingsSaveBtn.addEventListener('click', onSaveSettings);
  if (generateApiKeyBtn) generateApiKeyBtn.addEventListener('click', onGenerateApiKey);
  window.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettings(); });

  if (langSelect) {
    langSelect.addEventListener('change', (e) => {
      const v = (e.target.value || 'fr').toLowerCase();
      LANG = ['fr','en'].includes(v) ? v : 'fr';
      localStorage.setItem('dm_lang', LANG);
      applyStaticTranslations();
    });
  }


  (async () => {
    applyStaticTranslations();

    try { await fetchSettings(); } catch {}

    try { await tryStartSessionWithApiKey(); } catch {}

    fetchUnusedImages();
    setInterval(fetchUnusedImages, 30000);

    try {
      const raw = localStorage.getItem('dm_cache');
      if (raw) {
        const cache = JSON.parse(raw);
        if (cache && cache.data && cache.data.status === 'ok') {
          applyData(cache.data, { pending: true });
        }
      }
    } catch {}

    await render(true, true);

    connectSSE();

    setInterval(() => fetchAllMetrics(), METRICS_REFRESH_MS);

    // Fallback polling only when SSE is disconnected
    setInterval(() => {
      if (!sseConnected) render(false);
    }, FALLBACK_REFRESH_MS);

    setInterval(() => render(false), 3600000);
  })();
});
