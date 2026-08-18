# Route Log

An offline-capable PWA for walking a route of assets one at a time,
checking "Motor off" for each, and exporting a completed run as JSON.
Routes are imported from a .txt, .xlsx, or .pdf file and synced across
devices through Supabase (a free hosted database), so you can import a
route on your computer and run it on your phone.

## How the data is organized

- **Site** = the imported file's name (e.g. `U1.txt` → site "U1")
- **Route** = a bold-styled line in the file (e.g. `**Regular Route**`)
- **Asset** = each line listed under a route

This matches your file format exactly: same layout every time, asset
order may vary, no images for now.

## 1. Set up Supabase (free, ~5 minutes)

This is what makes cross-device sync work. Supabase is a hosted
Postgres database with a free tier that's more than enough for this.

1. Go to https://supabase.com, sign up, and create a new project
   (pick any name/password — the password is just for direct DB access,
   the app won't need it).
2. Once the project is ready, open **SQL Editor** in the left sidebar,
   click **New query**, paste in the contents of `schema.sql` from this
   folder, and run it. This creates the tables the app needs.
3. Go to **Settings → API**. Copy the **Project URL** and the
   **anon public** key.
4. Open `config.js` in this folder and paste those two values in:

```js
const SUPABASE_URL = 'https://xxxxxxxx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJ...';
```

That's it — no server to run or maintain. Supabase's free tier includes
500MB of database space, which is far more than this needs.

**On "safe for your company":** with the setup above, anyone with the
`config.js` values (which will be public in your GitHub repo) can read
and write your data — there's no login. That's fine solo, but before
using this for real company operations, loop in IT/security. Two easy
upgrades when you're ready: (a) add Supabase Auth so only logged-in
users can read/write, or (b) move to a database your company already
controls, self-hosted or via their cloud account — the app code barely
changes, only `config.js` and the security rules in `schema.sql`.

### Optional: auto-delete old runs after 30 days

Completed runs pile up over time. To keep storage tidy, open **SQL
Editor** in Supabase again, paste in the contents of `cleanup.sql` from
this folder, and run it once. This sets up a daily job (via Supabase's
free `pg_cron` extension) that deletes any completed run older than 30
days — it runs on Supabase's own schedule, so it happens automatically
even if nobody opens the app for a while.

As a backup, the app itself also does a quick cleanup pass of anything
older than 30 days whenever it's opened — so even without the SQL job
set up, old runs won't accumulate forever as long as the app gets
opened occasionally. Want a different retention window? Change `30
days` in both `cleanup.sql` and `RUN_RETENTION_DAYS` near the top of
`app.js`'s retention section.

## 2. Try it locally

```
cd route-log
python3 -m http.server 8000
```

Open http://localhost:8000 — import your route file, pick a site and
route, and click "Start route."

## 3. Host it on GitHub Pages

```
cd route-log
git init
git add .
git commit -m "Route Log app"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git push -u origin main
```

Then in the repo: **Settings → Pages** → Source: "Deploy from a branch"
→ branch `main`, folder `/ (root)` → Save. Your app will be live at
`https://YOUR-USERNAME.github.io/YOUR-REPO/` within a minute or two.

## 4. Install on your phone

- **iPhone (Safari)**: open the URL → Share icon → "Add to Home Screen"
- **Android (Chrome)**: open the URL → ⋮ menu → "Add to Home screen"

## Using it

1. **Import**: choose a .txt/.xlsx/.pdf file. The file name becomes the
   site, bold lines become routes, other lines become assets.
2. **Select & start**: pick a site, pick a route, tap "Start route."
3. **Walk the route**: one asset shown at a time with a "Motor off"
   checkbox. Previous/Next always visible.
4. **Complete**: on the last asset, "Next" becomes "Complete route."
   Tapping it downloads a JSON file named
   `sitename-routename-YYYY-MM-DD.json` with every asset and whether
   its box was checked, and also saves the run to Supabase so it shows
   up under "Past runs" on any device.

## Notes on offline behavior

- Once you've loaded the app and picked a route, walking through
  assets and checking boxes works fully offline — no network calls
  happen until you complete the route.
- Importing a new file or loading the site/route list requires a
  connection (it's talking to Supabase). If you're offline when
  completing a route, the JSON still downloads locally, but the run
  won't sync to Supabase until you're back online — worth re-running
  "Complete route" once you have signal, or manually uploading the
  JSON later if you build that flow.

## What's not built yet

- **Photos**: intentionally left out per your request — the data
  model doesn't block adding them back later.
- **PDF/Excel import**: the code path exists (`parsePdfFile`,
  `parseXlsxFile`) but hasn't been tested against a real PDF or Excel
  file yet — send one over and I'll verify/adjust the parsing.
- **Auth**: no login yet, see the Supabase security note above.