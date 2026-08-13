// Route Log — app logic
// Sites/routes/assets/route_runs all live in Supabase so they sync across
// devices. See config.js for connection setup and schema.sql for the tables.

// ---------- Parsing ----------
// Expected shape, regardless of source file type:
//   Route Name          <- a "header" line
//     asset line
//     asset line
//   Another Route Name
//     asset line ...
// A line counts as a header if it's wrapped in **asterisks** (txt/pdf export
// of bold text) OR, for spreadsheets, if it's alone in its row with nothing
// in adjacent asset columns. See parseLines() for the shared logic once we
// have a flat list of lines.

function parseLines(lines) {
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
      // Asset appeared before any header — bucket it under a default route.
      current = { name: 'Route', assets: [] };
      routes.push(current);
    }
    current.assets.push(line);
  }

  return routes;
}

async function parseTxtFile(file) {
  const text = await file.text();
  return parseLines(text.split('\n'));
}

async function parseXlsxFile(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: 'array' });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
  const lines = rows.map((row) => (row && row[0] != null ? String(row[0]) : ''));
  return parseLines(lines);
}

async function parsePdfFile(file) {
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
  return parseLines(lines);
}

async function parseFile(file) {
  const ext = file.name.split('.').pop().toLowerCase();
  const siteName = file.name.replace(/\.[^.]+$/, '');
  let routes;
  if (ext === 'txt') routes = await parseTxtFile(file);
  else if (ext === 'xlsx' || ext === 'xls') routes = await parseXlsxFile(file);
  else if (ext === 'pdf') routes = await parsePdfFile(file);
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
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => console.error('SW registration failed:', err));
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

let sitesCache = [];

async function loadSites() {
  try {
    sitesCache = await fetchSites();
  } catch (err) {
    importStatus.textContent = 'Could not load sites: ' + err.message + ' (check config.js is set up)';
    return;
  }
  siteSelect.innerHTML = '<option value="">Select a site&hellip;</option>' +
    sitesCache.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
  routeSelect.innerHTML = '<option value="">Select a site first&hellip;</option>';
  routeSelect.disabled = true;
  startRouteBtn.disabled = true;
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
    importStatus.textContent = 'Import failed: ' + err.message;
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
  runEmptyState.hidden = runs.length > 0;
  runList.innerHTML = runs.map((r) => `
    <li>
      <span>${r.site_name} — ${r.route_name} (${r.run_date})</span>
      <button data-run-id="${r.id}" type="button">download</button>
    </li>
  `).join('');
  runList.querySelectorAll('button[data-run-id]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const run = runs.find((r) => r.id === btn.dataset.runId);
      downloadJson(run.data, run.data.fileName);
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

  viewSelect.hidden = true;
  viewRun.hidden = false;
  renderAsset();
});

exitRunBtn.addEventListener('click', () => {
  if (!confirm('Exit this route? Progress will be lost unless you complete it.')) return;
  runState = null;
  viewRun.hidden = true;
  viewSelect.hidden = false;
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
});

prevBtn.addEventListener('click', () => {
  if (runState.index === 0) return;
  runState.index -= 1;
  renderAsset();
});

nextBtn.addEventListener('click', async () => {
  const isLast = runState.index === runState.assets.length - 1;
  if (!isLast) {
    runState.index += 1;
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

async function completeRoute() {
  const { siteName, routeName, routeId, assets, checks } = runState;
  const dateStamp = todayStamp();
  const fileName = `${slugify(siteName)}-${slugify(routeName)}-${dateStamp}.json`;

  const payload = {
    site: siteName,
    route: routeName,
    date: dateStamp,
    completedAt: new Date().toISOString(),
    fileName,
    assets: assets.map((a, i) => ({ name: a.name, motorOff: checks[i] }))
  };

  downloadJson(payload, fileName);

  try {
    await saveRun({
      route_id: routeId,
      site_name: siteName,
      route_name: routeName,
      run_date: dateStamp,
      data: payload
    });
  } catch (err) {
    console.error('Could not save run to Supabase:', err);
    // Non-fatal — the JSON file already downloaded locally.
  }

  runState = null;
  viewRun.hidden = true;
  viewSelect.hidden = false;
  loadRuns();
}

loadSites();
loadRuns();