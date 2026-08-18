// Route Log — app logic
// Sites/routes/assets/route_runs all live in Supabase so they sync across
// devices. See config.js for connection setup and schema.sql for the tables.

// ---------- Parsing ----------
// Two supported .txt/.pdf/.xlsx shapes:
//
// Template A — multiple routes in one file:
//   **Route Name**
//     asset line
//     asset line
//   **Another Route Name**
//     asset line ...
//
// Template B — a flat list with no route headers at all. The whole file
// is one route, named after the file itself (same as the site name).
//
// A line counts as a header if it's wrapped in **asterisks** (txt/pdf
// export of bold text) OR, for spreadsheets, if it's alone in its row
// with nothing in adjacent asset columns.

function parseLines(lines, defaultRouteName) {
  const routes = []; // { name, assets: [string] }
  let current = null;

  for (let raw of lines) {
    const line = raw.trim();
    if (!line) continue;

    const boldMatch = line.match(/^\*\*(.+?)\*\*$/);
    if (boldMatch) {
      current = { name: boldMatch[1].trim(), assets: [] };
      routes.push(current);
      continue;
    }

    if (!current) {
      // No header seen yet — Template B, name the route after the file.
      current = { name: defaultRouteName, assets: [] };
      routes.push(current);
    }
    current.assets.push(line);
  }

  return routes;
}

async function parseTxtFile(file, defaultRouteName) {
  const text = await file.text();
  return parseLines(text.split('\n'), defaultRouteName);
}

async function parseXlsxFile(file, defaultRouteName) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  const lines = rows.map((row) => (row && row[0] != null ? String(row[0]) : ''));
  return parseLines(lines, defaultRouteName);
}

async function parsePdfFile(file, defaultRouteName) {
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const lines = [];
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const content = await page.getTextContent();
    const rowsByY = {};
    for (const item of content.items) {
      const y = Math.round(item.transform[5]);
      (rowsByY[y] = rowsByY[y] || []).push(item);
    }
    const ys = Object.keys(rowsByY).map(Number).sort((a, b) => b - a);
    for (const y of ys) {
      const rowText = rowsByY[y]
        .sort((a, b) => a.transform[4] - b.transform[4])
        .map((i) => i.str)
        .join(' ')
        .trim();
      if (rowText) lines.push(rowText);
    }
  }
  return parseLines(lines, defaultRouteName);
}

async function parseFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const siteName = file.name.replace(/\.[^.]+$/, '');
  let routes;
  if (ext === 'txt') routes = await parseTxtFile(file, siteName);
  else if (ext === 'xlsx' || ext === 'xls') routes = await parseXlsxFile(file, siteName);
  else if (ext === 'pdf') routes = await parsePdfFile(file, siteName);
  else throw new Error('Unsupported file type: ' + ext);
  return { siteName, routes };
}

// ---------- Supabase sync ----------

async function saveImportedSite(siteName, routes) {
  const { data: site, error: siteErr } = await supabaseClient
    .from('sites')
    .upsert({ name: siteName }, { onConflict: 'name' })
    .select()
    .single();
  if (siteErr) throw siteErr;

  for (const route of routes) {
    const { data: routeRow, error: routeErr } = await supabaseClient
      .from('routes')
      .upsert({ site_id: site.id, name: route.name }, { onConflict: 'site_id,name' })
      .select()
      .single();
    if (routeErr) throw routeErr;

    await supabaseClient.from('assets').delete().eq('route_id', routeRow.id);
    const assetRows = route.assets.map((name, i) => ({
      route_id: routeRow.id,
      name,
      position: i
    }));
    if (assetRows.length) {
      const { error: assetErr } = await supabaseClient.from('assets').insert(assetRows);
      if (assetErr) throw assetErr;
    }
  }
}

async function fetchSites() {
  const { data, error } = await supabaseClient.from('sites').select('*').order('name');
  if (error) throw error;
  return data;
}

async function deleteSite(siteId) {
  // schema.sql cascades this delete to the site's routes and their assets.
  // Past route_runs are kept (route_id just becomes null on them) so
  // completed history isn't lost.
  const { error } = await supabaseClient.from('sites').delete().eq('id', siteId);
  if (error) throw error;
}

async function deleteRoute(routeId) {
  // Cascades to the route's assets. Past route_runs for this route are kept.
  const { error } = await supabaseClient.from('routes').delete().eq('id', routeId);
  if (error) throw error;
}

async function fetchRoutes(siteId) {
  const { data, error } = await supabaseClient
    .from('routes')
    .select('*')
    .eq('site_id', siteId)
    .order('name');
  if (error) throw error;
  return data;
}

function assetCacheKey(routeId) {
  return `route-log:assets:${routeId}`;
}

async function fetchAssets(routeId) {
  try {
    const { data, error } = await supabaseClient
      .from('assets')
      .select('*')
      .eq('route_id', routeId)
      .order('position');
    if (error) throw error;
    localStorage.setItem(assetCacheKey(routeId), JSON.stringify(data));
    return data;
  } catch (err) {
    // Offline (or Supabase unreachable) — fall back to the last-synced
    // copy of this route's assets, if we have one on this device.
    const cached = localStorage.getItem(assetCacheKey(routeId));
    if (cached) return JSON.parse(cached);
    throw err;
  }
}

async function fetchRuns() {
  const { data, error } = await supabaseClient
    .from('route_runs')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) throw error;
  return data;
}

async function saveRun(run) {
  const { error } = await supabaseClient.from('route_runs').insert(run);
  if (error) throw error;
}

// ---------- Retention: auto-delete runs older than 30 days ----------
// This is a client-side safety net that runs once per app open. The
// primary mechanism is a scheduled job in Supabase (see cleanup.sql) that
// runs daily on the server regardless of whether the app is ever opened —
// this just catches anything in between, or covers you if that job isn't
// set up yet.

const RUN_RETENTION_DAYS = 30;

async function deleteOldRuns() {
  const cutoff = new Date(Date.now() - RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  try {
    await supabaseClient.from('route_runs').delete().lt('created_at', cutoff);
  } catch (err) {
    // Non-fatal — just means old runs stick around a bit longer than usual.
    console.error('Could not clean up old runs:', err);
  }
}

// ---------- UI: shared elements ----------

const netStatus = document.getElementById('netStatus');
function updateNetStatus() {
  const online = navigator.onLine;
  netStatus.textContent = online ? 'online' : 'offline';
  netStatus.className = 'status ' + (online ? 'status--online' : 'status--offline');
}
window.addEventListener('online', updateNetStatus);
window.addEventListener('offline', updateNetStatus);
updateNetStatus();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', async () => {
    try {
      // updateViaCache: 'none' stops the browser from ever serving sw.js
      // itself out of HTTP cache — without this, a phone can keep re-running
      // an old service worker indefinitely because it never even re-checks
      // for a new one, no matter how many times you close/reopen the app.
      const reg = await navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' });
      reg.update(); // also actively check for an update on every load

      // Once a new service worker takes over, reload automatically so the
      // update applies immediately instead of waiting for a future visit.
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (reloaded) return;
        reloaded = true;
        window.location.reload();
      });
    } catch (err) {
      console.error('SW registration failed:', err);
    }
  });
}

// ---------- UI: select view ----------

const viewSelect = document.getElementById('view-select');
const viewRun = document.getElementById('view-run');

const siteSelect = document.getElementById('siteSelect');
const routeSelect = document.getElementById('routeSelect');
const startRouteBtn = document.getElementById('startRouteBtn');
const importFile = document.getElementById('importFile');
const importFileLabel = document.getElementById('importFileLabel');
const importStatus = document.getElementById('importStatus');
const runList = document.getElementById('runList');
const runEmptyState = document.getElementById('runEmptyState');

// Turns opaque browser/network errors into something actionable. "Load
// failed" / "Failed to fetch" style messages mean the request to Supabase
// never got a response at all — almost always a bad URL in config.js, a
// paused free-tier project, or no internet connection, rather than a bug
// in the app itself.
function describeError(err) {
  const msg = (err && err.message) || String(err);
  const isNetworkFailure = /load failed|failed to fetch|network/i.test(msg);
  if (isNetworkFailure) {
    if (!navigator.onLine) {
      return 'No internet connection right now.';
    }
    if (!SUPABASE_URL || SUPABASE_URL.includes('YOUR_SUPABASE')) {
      return 'config.js still has placeholder Supabase values — paste in your real Project URL and anon key.';
    }
    return 'Could not reach Supabase (' + SUPABASE_URL + '). Check: the URL in config.js is exactly right (starts with https://, no trailing slash or extra spaces), the anon key was copied in full, and your Supabase project isn\'t paused (free-tier projects pause after a week idle — restart it from the Supabase dashboard).';
  }
  return msg;
}

let sitesCache = [];

async function loadSites() {
  try {
    sitesCache = await fetchSites();
  } catch (err) {
    importStatus.textContent = 'Could not load sites: ' + describeError(err);
    return;
  }
  siteSelect.innerHTML = '<option value="">Select a site&hellip;</option>' +
    sitesCache.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
  routeSelect.innerHTML = '<option value="">Select a site first&hellip;</option>';
  routeSelect.disabled = true;
  startRouteBtn.disabled = true;

  // Keep the delete panel's site dropdown in sync too.
  delSiteSelect.innerHTML = '<option value="">Select a site&hellip;</option>' +
    sitesCache.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
  delRouteSelect.innerHTML = '<option value="">Select a site first&hellip;</option>';
  delRouteSelect.disabled = true;
  delSubmitBtn.disabled = true;
}

siteSelect.addEventListener('change', async () => {
  const siteId = siteSelect.value;
  routeSelect.innerHTML = '';
  startRouteBtn.disabled = true;
  if (!siteId) {
    routeSelect.innerHTML = '<option value="">Select a site first&hellip;</option>';
    routeSelect.disabled = true;
    return;
  }
  routeSelect.disabled = false;
  routeSelect.innerHTML = '<option value="">Loading&hellip;</option>';
  const routes = await fetchRoutes(siteId);
  routeSelect.innerHTML = '<option value="">Select a route&hellip;</option>' +
    routes.map((r) => `<option value="${r.id}">${r.name}</option>`).join('');
});

routeSelect.addEventListener('change', () => {
  startRouteBtn.disabled = !routeSelect.value;
});

// ---------- UI: delete panel ----------

const delSiteSelect = document.getElementById('delSiteSelect');
const delRouteSelect = document.getElementById('delRouteSelect');
const delSubmitBtn = document.getElementById('delSubmitBtn');
const delStatus = document.getElementById('delStatus');

let delRoutesCache = []; // routes currently loaded for the selected delete-site

delSiteSelect.addEventListener('change', async () => {
  const siteId = delSiteSelect.value;
  delStatus.textContent = '';
  delStatus.className = 'hint';
  delRouteSelect.innerHTML = '';
  delSubmitBtn.disabled = true;

  if (!siteId) {
    delRouteSelect.innerHTML = '<option value="">Select a site first&hellip;</option>';
    delRouteSelect.disabled = true;
    return;
  }

  delRouteSelect.disabled = false;
  delRouteSelect.innerHTML = '<option value="">Loading&hellip;</option>';
  try {
    delRoutesCache = await fetchRoutes(siteId);
  } catch (err) {
    delStatus.textContent = 'Could not load routes: ' + describeError(err);
    delStatus.className = 'hint hint--error';
    delRouteSelect.innerHTML = '<option value="">&mdash;</option>';
    return;
  }
  delRouteSelect.innerHTML =
    `<option value="">Entire site (${delRoutesCache.length} route${delRoutesCache.length === 1 ? '' : 's'})</option>` +
    delRoutesCache.map((r) => `<option value="${r.id}">${r.name}</option>`).join('');
  delSubmitBtn.disabled = false;
});

delRouteSelect.addEventListener('change', () => {
  delSubmitBtn.disabled = !delSiteSelect.value;
});

delSubmitBtn.addEventListener('click', async () => {
  const siteId = delSiteSelect.value;
  if (!siteId) return;
  const siteName = delSiteSelect.options[delSiteSelect.selectedIndex].text;
  const routeId = delRouteSelect.value;

  if (routeId) {
    // Deleting one specific route.
    const routeName = delRouteSelect.options[delRouteSelect.selectedIndex].text;
    if (!confirm(`Delete route "${routeName}" from "${siteName}"? This cannot be undone. Past completed runs for this route are kept.`)) return;

    delSubmitBtn.disabled = true;
    delStatus.textContent = 'Deleting…';
    delStatus.className = 'hint hint--loading';
    try {
      await deleteRoute(routeId);
      delStatus.textContent = `Deleted route "${routeName}".`;
      delStatus.className = 'hint hint--success';
      await loadSites();
      // Restore the site selection so the panel doesn't reset to nothing.
      delSiteSelect.value = siteId;
      delSiteSelect.dispatchEvent(new Event('change'));
    } catch (err) {
      delStatus.textContent = 'Delete failed: ' + describeError(err);
      delStatus.className = 'hint hint--error';
      delSubmitBtn.disabled = false;
    }
    return;
  }

  // No specific route chosen — deleting the entire site.
  // Per requirement: only allowed outright if the site has no routes,
  // otherwise an explicit confirmation naming the route count is required.
  const routeCount = delRoutesCache.length;
  const confirmMsg = routeCount > 0
    ? `"${siteName}" has ${routeCount} route${routeCount === 1 ? '' : 's'}. Delete the entire site and all ${routeCount === 1 ? 'that route' : 'those routes'}? This cannot be undone. Past completed runs are kept.`
    : `Delete "${siteName}"? This cannot be undone.`;
  if (!confirm(confirmMsg)) return;

  delSubmitBtn.disabled = true;
  delStatus.textContent = 'Deleting…';
  delStatus.className = 'hint hint--loading';
  try {
    await deleteSite(siteId);
    delStatus.textContent = `Deleted site "${siteName}" and all its routes.`;
    delStatus.className = 'hint hint--success';
    await loadSites();
  } catch (err) {
    delStatus.textContent = 'Delete failed: ' + describeError(err);
    delStatus.className = 'hint hint--error';
    delSubmitBtn.disabled = false;
  }
});

importFile.addEventListener('change', async () => {
  const file = importFile.files[0];
  if (!file) return;
  importFileLabel.textContent = file.name;
  importStatus.textContent = 'Parsing…';
  try {
    const { siteName, routes } = await parseFile(file);
    if (!routes.length) throw new Error('No routes found in file');
    importStatus.textContent = `Saving ${routes.length} route(s) for "${siteName}"…`;
    await saveImportedSite(siteName, routes);
    importStatus.textContent = `Imported "${siteName}": ${routes.length} route(s).`;
    await loadSites();
  } catch (err) {
    importStatus.textContent = 'Import failed: ' + describeError(err);
  } finally {
    importFile.value = '';
    importFileLabel.textContent = 'Choose file…';
  }
});

async function loadRuns() {
  let runs = [];
  try {
    runs = await fetchRuns();
  } catch (err) {
    return; // Non-fatal if config isn't set up yet.
  }
  const pendingCount = getPendingRuns().length;
  runEmptyState.hidden = runs.length > 0 || pendingCount > 0;
  runList.innerHTML = runs.map((r) => `
    <li>
      <span>${r.site_name} — ${r.route_name} (${r.run_date})</span>
      <button data-run-id="${r.id}" type="button">share</button>
    </li>
  `).join('') + (pendingCount
    ? `<li class="run-list__pending"><span>${pendingCount} run(s) waiting to sync&hellip;</span></li>`
    : '');
  runList.querySelectorAll('button[data-run-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const run = runs.find((r) => r.id === btn.dataset.runId);
      shareOrDownloadJson(run.data, run.data.fileName);
    });
  });
}

// ---------- UI: run view ----------

const exitRunBtn = document.getElementById('exitRunBtn');
const runSiteRoute = document.getElementById('runSiteRoute');
const runProgress = document.getElementById('runProgress');
const assetIndex = document.getElementById('assetIndex');
const assetName = document.getElementById('assetName');
const motorOffCheck = document.getElementById('motorOffCheck');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');

// Autosaved so an in-progress route survives the app closing, the phone
// locking, losing signal, or a browser crash — not just a controlled exit.
const ACTIVE_RUN_KEY = 'route-log:active-run';

function saveActiveRun() {
  if (runState) localStorage.setItem(ACTIVE_RUN_KEY, JSON.stringify(runState));
}
function clearActiveRun() {
  localStorage.removeItem(ACTIVE_RUN_KEY);
}
function loadActiveRunFromStorage() {
  try {
    return JSON.parse(localStorage.getItem(ACTIVE_RUN_KEY) || 'null');
  } catch {
    return null;
  }
}

let runState = null; // { siteName, routeName, routeId, assets, index, checks }

startRouteBtn.addEventListener('click', async () => {
  const siteName = siteSelect.options[siteSelect.selectedIndex].text;
  const routeName = routeSelect.options[routeSelect.selectedIndex].text;
  const routeId = routeSelect.value;

  const assets = await fetchAssets(routeId);
  if (!assets.length) {
    alert('This route has no assets.');
    return;
  }

  runState = {
    siteName,
    routeName,
    routeId,
    assets,
    index: 0,
    checks: assets.map(() => false)
  };

  saveActiveRun();
  viewSelect.hidden = true;
  viewRun.hidden = false;
  renderAsset();
});

exitRunBtn.addEventListener('click', () => {
  // Progress is autosaved as you go, so exiting doesn't lose anything —
  // it'll be offered back to you as "Resume" next time you open the app.
  if (!confirm("Exit this route? Your progress is saved — you'll be able to resume it later.")) return;
  runState = null;
  viewRun.hidden = true;
  viewSelect.hidden = false;
  checkForResumableRun();
});

function renderAsset() {
  const { assets, index, checks } = runState;
  const total = assets.length;

  runSiteRoute.textContent = `${runState.siteName} — ${runState.routeName}`;
  runProgress.textContent = `Asset ${index + 1} of ${total}`;
  assetIndex.textContent = `${index + 1} / ${total}`;
  assetName.textContent = assets[index].name;
  motorOffCheck.checked = checks[index];

  prevBtn.disabled = index === 0;
  nextBtn.textContent = index === total - 1 ? 'Complete route' : 'Next';
}

motorOffCheck.addEventListener('change', () => {
  runState.checks[runState.index] = motorOffCheck.checked;
  saveActiveRun();
});

prevBtn.addEventListener('click', () => {
  if (runState.index === 0) return;
  runState.index -= 1;
  saveActiveRun();
  renderAsset();
});

nextBtn.addEventListener('click', async () => {
  const isLast = runState.index === runState.assets.length - 1;
  if (!isLast) {
    runState.index += 1;
    saveActiveRun();
    renderAsset();
    return;
  }
  await completeRoute();
});

function pad(n) { return String(n).padStart(2, '0'); }

function todayStamp() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function slugify(s) {
  return s.trim().replace(/\s+/g, '_').replace(/[^\w\-]/g, '');
}

function downloadJson(obj, fileName) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// Opens the native Share Sheet (Mail, Messages, AirDrop, Save to Files,
// etc.) with the JSON attached as a real file — this is what avoids the
// clunky "tap to open, then figure out what to do with it" screen.
// Falls back to a plain download on browsers/desktops without share support.
async function shareOrDownloadJson(obj, fileName) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const file = new File([blob], fileName, { type: 'application/json' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: fileName,
        text: `Completed route: ${fileName}`
      });
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled'; // user backed out of the share sheet
      // Fall through to download if share failed for some other reason.
    }
  }
  downloadJson(obj, fileName);
  return 'downloaded';
}

// ---------- Offline queue for completed runs ----------
// If Supabase can't be reached when a route is completed (no connection,
// project paused, etc.), the run is kept here and retried automatically
// the next time the app is online — so nothing has to be re-entered.

const PENDING_KEY = 'route-log:pending-runs';

function getPendingRuns() {
  try {
    return JSON.parse(localStorage.getItem(PENDING_KEY) || '[]');
  } catch {
    return [];
  }
}

function setPendingRuns(runs) {
  localStorage.setItem(PENDING_KEY, JSON.stringify(runs));
}

function addPendingRun(run) {
  const runs = getPendingRuns();
  runs.push(run);
  setPendingRuns(runs);
}

async function flushPendingRuns() {
  const runs = getPendingRuns();
  if (!runs.length) return;
  const stillPending = [];
  for (const run of runs) {
    try {
      await saveRun(run.record);
    } catch (err) {
      stillPending.push(run);
    }
  }
  setPendingRuns(stillPending);
  if (stillPending.length !== runs.length) {
    loadRuns(); // some synced — refresh the list
  }
}

window.addEventListener('online', flushPendingRuns);

// ---------- UI: complete view ----------

const viewComplete = document.getElementById('view-complete');
const completeSummary = document.getElementById('completeSummary');
const completeSyncStatus = document.getElementById('completeSyncStatus');
const shareRunBtn = document.getElementById('shareRunBtn');
const doneBtn = document.getElementById('doneBtn');

let lastCompletedPayload = null;

shareRunBtn.addEventListener('click', async () => {
  if (!lastCompletedPayload) return;
  await shareOrDownloadJson(lastCompletedPayload, lastCompletedPayload.fileName);
});

doneBtn.addEventListener('click', () => {
  viewComplete.hidden = true;
  viewSelect.hidden = false;
  lastCompletedPayload = null;
  loadRuns();
});

async function completeRoute() {
  const { siteName, routeName, routeId, assets, checks } = runState;
  const dateStamp = todayStamp();
  const fileName = `${slugify(siteName)}-${slugify(routeName)}-${dateStamp}.json`;
  const offCount = checks.filter(Boolean).length;

  const payload = {
    site: siteName,
    route: routeName,
    date: dateStamp,
    completedAt: new Date().toISOString(),
    fileName,
    assets: assets.map((a, i) => ({ name: a.name, motorOff: checks[i] }))
  };

  const record = {
    route_id: routeId,
    site_name: siteName,
    route_name: routeName,
    run_date: dateStamp,
    data: payload
  };

  let synced = false;
  try {
    await saveRun(record);
    synced = true;
  } catch (err) {
    addPendingRun({ record });
  }

  lastCompletedPayload = payload;
  runState = null;
  clearActiveRun();
  viewRun.hidden = true;
  viewComplete.hidden = false;

  completeSummary.textContent = `${siteName} — ${routeName}: ${offCount} of ${assets.length} marked Motor off.`;
  completeSyncStatus.textContent = synced
    ? 'Saved — visible on all your devices.'
    : "Saved on this device only for now — it'll sync automatically once you're back online.";
  completeSyncStatus.className = 'hint ' + (synced ? '' : 'hint--pending');
}

loadSites();
loadRuns();
flushPendingRuns();
deleteOldRuns().then(() => loadRuns()); // trim first, then refresh the list shown

// ---------- Resume an interrupted route ----------

const resumeBanner = document.getElementById('resumeBanner');
const resumeText = document.getElementById('resumeText');
const resumeBtn = document.getElementById('resumeBtn');
const discardResumeBtn = document.getElementById('discardResumeBtn');

function checkForResumableRun() {
  const saved = loadActiveRunFromStorage();
  if (!saved) {
    resumeBanner.hidden = true;
    return;
  }
  const doneCount = saved.checks.filter(Boolean).length;
  resumeText.textContent = `${saved.siteName} — ${saved.routeName}: stopped at asset ${saved.index + 1} of ${saved.assets.length} (${doneCount} checked so far).`;
  resumeBanner.hidden = false;
}

resumeBtn.addEventListener('click', () => {
  const saved = loadActiveRunFromStorage();
  if (!saved) return;
  runState = saved;
  resumeBanner.hidden = true;
  viewSelect.hidden = true;
  viewRun.hidden = false;
  renderAsset();
});

discardResumeBtn.addEventListener('click', () => {
  if (!confirm('Discard this in-progress route? This cannot be undone.')) return;
  clearActiveRun();
  resumeBanner.hidden = true;
});

checkForResumableRun();