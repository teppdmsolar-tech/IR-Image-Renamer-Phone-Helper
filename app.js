// Field Log — app logic
// All entries (text + photo) are stored locally in IndexedDB, so the app
// works fully offline. Nothing leaves the device unless you add sync later.

const DB_NAME = 'field-log';
const STORE = 'entries';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveEntry(entry) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function deleteEntry(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getAllEntries() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => b.createdAt - a.createdAt));
    req.onerror = () => reject(req.error);
  });
}

// --- UI wiring ---

const entryText = document.getElementById('entryText');
const photoInput = document.getElementById('photoInput');
const photoPreview = document.getElementById('photoPreview');
const photoPreviewImg = document.getElementById('photoPreviewImg');
const removePhotoBtn = document.getElementById('removePhoto');
const addEntryBtn = document.getElementById('addEntry');
const entryList = document.getElementById('entryList');
const emptyState = document.getElementById('emptyState');
const netStatus = document.getElementById('netStatus');

let pendingPhotoDataUrl = null;

photoInput.addEventListener('change', () => {
  const file = photoInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    pendingPhotoDataUrl = reader.result;
    photoPreviewImg.src = pendingPhotoDataUrl;
    photoPreview.hidden = false;
  };
  reader.readAsDataURL(file);
});

removePhotoBtn.addEventListener('click', () => {
  pendingPhotoDataUrl = null;
  photoInput.value = '';
  photoPreview.hidden = true;
});

addEntryBtn.addEventListener('click', async () => {
  const text = entryText.value.trim();
  if (!text && !pendingPhotoDataUrl) return;

  const entry = {
    id: crypto.randomUUID(),
    text,
    photo: pendingPhotoDataUrl,
    createdAt: Date.now()
  };

  await saveEntry(entry);

  entryText.value = '';
  pendingPhotoDataUrl = null;
  photoInput.value = '';
  photoPreview.hidden = true;

  renderEntries();
});

function formatDate(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  });
}

async function renderEntries() {
  const entries = await getAllEntries();
  entryList.innerHTML = '';
  emptyState.hidden = entries.length > 0;

  for (const entry of entries) {
    const li = document.createElement('li');
    li.className = 'entry';

    const meta = document.createElement('div');
    meta.className = 'entry-meta';
    meta.innerHTML = `<span>${formatDate(entry.createdAt)}</span>`;

    const delBtn = document.createElement('button');
    delBtn.className = 'entry-delete';
    delBtn.textContent = 'delete';
    delBtn.addEventListener('click', async () => {
      await deleteEntry(entry.id);
      renderEntries();
    });
    meta.appendChild(delBtn);
    li.appendChild(meta);

    if (entry.text) {
      const p = document.createElement('p');
      p.className = 'entry-text';
      p.textContent = entry.text;
      li.appendChild(p);
    }

    if (entry.photo) {
      const img = document.createElement('img');
      img.src = entry.photo;
      img.alt = 'Entry photo';
      li.appendChild(img);
    }

    entryList.appendChild(li);
  }
}

// --- Online/offline indicator ---

function updateNetStatus() {
  const online = navigator.onLine;
  netStatus.textContent = online ? 'online' : 'offline';
  netStatus.className = 'status ' + (online ? 'status--online' : 'status--offline');
}
window.addEventListener('online', updateNetStatus);
window.addEventListener('offline', updateNetStatus);
updateNetStatus();

// --- Service worker registration ---

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.error('Service worker registration failed:', err);
    });
  });
}

renderEntries();
