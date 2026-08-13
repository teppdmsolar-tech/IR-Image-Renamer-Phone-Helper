# Field Log

A minimal offline-first PWA starter: add text + photo entries, stored locally
in the browser (IndexedDB), works with no connection, installable on iPhone
and Android home screens.

## Try it locally

You need a local server (not just double-clicking index.html) because
service workers require it. From this folder:

```
python3 -m http.server 8000
```

Then open http://localhost:8000 in a browser.

## Host it on GitHub Pages

1. Create a new repository on GitHub (public repos get free Pages hosting).
2. Push these files to it:

```
cd pwa-starter
git init
git add .
git commit -m "Initial PWA scaffold"
git branch -M main
git remote add origin https://github.com/YOUR-USERNAME/YOUR-REPO.git
git push -u origin main
```

3. On GitHub: go to the repo's **Settings → Pages**.
4. Under "Build and deployment", set **Source** to "Deploy from a branch,"
   pick the **main** branch and **/ (root)** folder, then Save.
5. GitHub will give you a URL like:
   `https://YOUR-USERNAME.github.io/YOUR-REPO/`
   It can take a minute or two to go live after the first push.

## Installing it on a phone

- **iPhone (Safari)**: open the URL, tap the Share icon, choose
  "Add to Home Screen."
- **Android (Chrome)**: open the URL, tap the ⋮ menu, choose
  "Add to Home screen" or "Install app."

Once installed, it opens full-screen like a native app and keeps working
without a connection, since the service worker caches the app shell and all
entries are saved on-device.

## Where things live

| File | Purpose |
|---|---|
| `index.html` | Page structure |
| `styles.css` | Visual design |
| `app.js` | Entry logic, IndexedDB storage, offline detection |
| `sw.js` | Service worker — caches files for offline use |
| `manifest.json` | Tells the phone how to install the app (name, icon, colors) |
| `icons/` | App icons used on the home screen |

## Extending this

- **Sync across devices**: entries currently stay on one device only. To
  sync, you'd add a backend (e.g. a small API + database) and push/pull
  entries when online — IndexedDB already gives you a natural offline queue.
- **Bump the cache**: whenever you edit `styles.css`, `app.js`, or
  `index.html`, change `CACHE_NAME` in `sw.js` (e.g. `field-log-v2`) so
  visitors' cached copies get replaced instead of staying stale.
