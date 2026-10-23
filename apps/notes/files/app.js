'use strict';

/*
 * ShareNotes – sticky notes for ShareOS.
 *
 * With the permission "files" every note is one JSON file in the folder
 * "notes" of the user's personal folder on the box (ShareOS.fs):
 *   notes/note_<id>.json  { id, title, content, color, date, updated }
 * Without access to the box (no "files" for the account, opened outside
 * ShareOS) the notes stay in the browser (localStorage, kept apart per
 * account by the ShareOS SDK).
 */

const SOS = window.ShareOS || null;
const FS = SOS && SOS.fs ? SOS.fs : null;
const user = (SOS && SOS.user) || new URLSearchParams(location.search).get('user') || 'default';

const NOTES_FOLDER = 'notes';
const STORE_KEY = `shareos_notes_${user}`;

// note colours: key -> label; the colours themselves are in style.css
// (light and dark). Notes of version 1.0 stored the dark colour itself.
const COLORS = [
  ['default', 'Standard'], ['coral', 'Koralle'], ['peach', 'Pfirsich'], ['sand', 'Sand'],
  ['sage', 'Salbei'], ['mist', 'Nebel'], ['storm', 'Sturm'], ['lavender', 'Lavendel']
];
const LEGACY_COLORS = {
  '#202124': 'default', '#5c2b29': 'coral', '#614a19': 'peach', '#635d19': 'sand',
  '#345920': 'sage', '#16504b': 'mist', '#2d555e': 'storm', '#42275e': 'lavender'
};

let boxRoot = null;       // name of the personal folder (ShareOS.fs root)
let notes = [];
let creatorColor = 'default';
let editing = null;       // the note open in the dialog
let editingBefore = '';   // its state when opened, to save only changes

const $ = (id) => document.getElementById(id);
const creator = $('note-creator');
const titleInput = $('new-title');
const contentInput = $('new-content');
const creatorFooter = $('creator-footer');
const notesGrid = $('notes-grid');
const notesEmpty = $('notes-empty');
const searchInput = $('search-input');
const storageStatus = $('storage-status');
const editModal = $('edit-modal');
const modalDialog = $('modal-dialog');
const editTitle = $('edit-title');
const editContent = $('edit-content');

$('user-display').textContent = user;

function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 3500);
}

function showBanner(text) {
  const b = $('banner');
  b.textContent = text;
  b.classList.remove('hidden');
}

function today() { return new Date().toISOString().slice(0, 10); }

function colorKey(c) {
  if (COLORS.some(([k]) => k === c)) return c;
  return LEGACY_COLORS[String(c || '').toLowerCase()] || 'default';
}

// a note as read from a file or the browser, with sane fields
function normalize(n) {
  const id = Number(n.id) || Date.now();
  return {
    id,
    title: String(n.title || ''),
    content: String(n.content || ''),
    color: colorKey(n.color),
    date: n.date || today(),
    updated: Number(n.updated) || id,
    _fileName: n._fileName
  };
}

function stored(n) {
  return { id: n.id, title: n.title, content: n.content, color: n.color, date: n.date, updated: n.updated };
}

function sortNotes() { notes.sort((a, b) => b.updated - a.updated); }

/* ---------- storage: box ---------- */

async function initStorage() {
  if (!FS) {
    if (SOS && SOS.user && SOS.user !== 'guest')
      showBanner('Kein Zugriff auf die Ordner der Box: Der Administrator kann ihn unter Benutzer → „Dateien“ für dein Konto einschalten. Bis dahin bleiben die Notizen in diesem Browser.');
    loadBrowserNotes();
    return;
  }
  try {
    const roots = await FS.roots();
    const home = (roots || []).find((r) => r.home) || (roots || []).find((r) => !r.ro);
    if (!home) {
      showBanner('Für dein Konto gibt es auf der Box keinen Ordner, in den du schreiben darfst. Die Notizen bleiben in diesem Browser.');
      loadBrowserNotes();
      return;
    }
    boxRoot = home.name;
    await FS.mkdir(boxRoot, '', NOTES_FOLDER).catch((err) => {
      if (!/exists/i.test(err.message)) throw err;
    });
    storageStatus.textContent = `Box: ${boxRoot}/${NOTES_FOLDER}/`;
    await loadBoxNotes();
  } catch (e) {
    boxRoot = null;
    showBanner(`Die Box ist gerade nicht erreichbar (${e.message}). Die Notizen bleiben vorerst in diesem Browser.`);
    loadBrowserNotes();
  }
}

async function loadBoxNotes() {
  const res = await FS.list(boxRoot, NOTES_FOLDER);
  const files = (res.entries || []).filter((e) => e.type === 'file' && /\.json$/i.test(e.name));
  const loaded = [];
  for (const file of files) {
    try {
      const f = await FS.open(boxRoot, NOTES_FOLDER, file.name);
      const parsed = JSON.parse(await f.text());
      if (parsed && typeof parsed === 'object') loaded.push(normalize({ ...parsed, _fileName: file.name }));
    } catch (err) {
      console.warn('ShareNotes: cannot read', file.name, err);
    }
  }
  notes = loaded;
  sortNotes();
  renderNotes();
}

async function saveNote(note) {
  if (!boxRoot) { saveBrowserNotes(); return true; }
  note._fileName = note._fileName || `note_${note.id}.json`;
  try {
    const f = await FS.open(boxRoot, NOTES_FOLDER, note._fileName, { write: true, create: true });
    await f.save(JSON.stringify(stored(note), null, 2) + '\n');
    return true;
  } catch (e) {
    showToast(`Speichern fehlgeschlagen: ${e.message}`);
    return false;
  }
}

async function removeNote(note) {
  notes = notes.filter((x) => x !== note);
  renderNotes();
  if (!boxRoot) { saveBrowserNotes(); showToast('Notiz gelöscht.'); return; }
  try {
    await FS.remove(boxRoot, NOTES_FOLDER, [note._fileName || `note_${note.id}.json`]);
    showToast('Notiz gelöscht.');
  } catch (e) {
    showToast(`Löschen fehlgeschlagen: ${e.message}`);
  }
}

/* ---------- storage: browser ---------- */

function loadBrowserNotes() {
  storageStatus.textContent = 'Speicher: dieser Browser';
  let list = null;
  try { list = JSON.parse(localStorage.getItem(STORE_KEY)); } catch (e) { list = null; }
  if (!Array.isArray(list)) {
    list = [{
      id: 1,
      title: 'Willkommen bei ShareNotes!',
      content: 'Klick auf diese Notiz, um sie zu bearbeiten oder umzufärben. Oben schreibst du neue Notizen.',
      color: 'peach',
      date: today()
    }];
  }
  notes = list.map(normalize);
  sortNotes();
  renderNotes();
}

function saveBrowserNotes() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(notes.map(stored))); }
  catch (e) { showToast(`Speichern im Browser fehlgeschlagen: ${e.message}`); }
}

/* ---------- colour palettes ---------- */

function buildPalette(el, onPick) {
  el.innerHTML = '';
  for (const [key, label] of COLORS) {
    const dot = document.createElement('button');
    dot.type = 'button';
    dot.className = 'palette-dot';
    dot.dataset.color = key;
    dot.title = label;
    dot.setAttribute('aria-label', 'Farbe: ' + label);
    dot.addEventListener('click', (e) => { e.stopPropagation(); onPick(key); markPalette(el, key); });
    el.appendChild(dot);
  }
}

function markPalette(el, key) {
  el.querySelectorAll('.palette-dot').forEach((d) => d.classList.toggle('active', d.dataset.color === key));
}

buildPalette($('creator-palette'), (key) => { creatorColor = key; creator.dataset.color = key; });
buildPalette($('edit-palette'), (key) => { if (editing) modalDialog.dataset.color = key; });

/* ---------- new note ---------- */

function expandCreator() {
  titleInput.classList.remove('hidden');
  creatorFooter.classList.remove('hidden');
  creator.classList.add('expanded');
  contentInput.rows = 3;
}

function resetCreator() {
  titleInput.value = '';
  contentInput.value = '';
  contentInput.rows = 1;
  titleInput.classList.add('hidden');
  creatorFooter.classList.add('hidden');
  creator.classList.remove('expanded');
  creatorColor = 'default';
  creator.dataset.color = 'default';
  markPalette($('creator-palette'), 'default');
}

async function finishCreator() {
  const title = titleInput.value.trim();
  const content = contentInput.value.trim();
  const color = creatorColor;
  resetCreator();
  if (!title && !content) return;
  const now = Date.now();
  const note = { id: now, title, content, color, date: today(), updated: now };
  notes.unshift(note);
  renderNotes();
  if (await saveNote(note)) showToast('Notiz gespeichert.');
}

contentInput.addEventListener('focus', expandCreator);
titleInput.addEventListener('focus', expandCreator);
$('add-note-btn').addEventListener('click', finishCreator);
creator.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finishCreator(); }
  if (e.key === 'Escape') { e.preventDefault(); finishCreator(); }
});
// a click elsewhere closes the new note (and keeps it, if it has text)
document.addEventListener('mousedown', (e) => {
  if (creator.classList.contains('expanded') && !creator.contains(e.target) && editModal.classList.contains('hidden'))
    finishCreator();
});

/* ---------- edit dialog ---------- */

function openNote(note) {
  editing = note;
  editingBefore = JSON.stringify([note.title, note.content, note.color]);
  editTitle.value = note.title;
  editContent.value = note.content;
  modalDialog.dataset.color = note.color;
  markPalette($('edit-palette'), note.color);
  editModal.classList.remove('hidden');
  editContent.focus();
}

async function closeNote() {
  if (!editing) return;
  const note = editing;
  editing = null;
  editModal.classList.add('hidden');
  const title = editTitle.value.trim();
  const content = editContent.value.trim();
  const color = modalDialog.dataset.color || 'default';
  if (JSON.stringify([title, content, color]) === editingBefore) return;
  // emptied: the note goes, as nothing would be left to see
  if (!title && !content) { await removeNote(note); return; }
  Object.assign(note, { title, content, color, date: today(), updated: Date.now() });
  sortNotes();
  renderNotes();
  if (await saveNote(note)) showToast('Änderungen gespeichert.');
}

$('modal-save-btn').addEventListener('click', closeNote);
$('modal-delete-btn').addEventListener('click', async () => {
  if (!editing || !confirm('Diese Notiz löschen?')) return;
  const note = editing;
  editing = null;
  editModal.classList.add('hidden');
  await removeNote(note);
});
editModal.addEventListener('mousedown', (e) => { if (e.target === editModal) closeNote(); });
editModal.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); closeNote(); }
});

/* ---------- cards and search ---------- */

function escapeHTML(str) {
  return String(str).replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
}

function renderNotes() {
  const query = searchInput.value.trim().toLowerCase();
  const shown = notes.filter((n) => !query || n.title.toLowerCase().includes(query) || n.content.toLowerCase().includes(query));
  $('notes-count').textContent = notes.length === 1 ? '1 Notiz' : `${notes.length} Notizen`;
  notesGrid.innerHTML = '';
  for (const n of shown) {
    const card = document.createElement('div');
    card.className = 'note-card';
    card.dataset.color = n.color;
    card.tabIndex = 0;
    card.innerHTML = `
      ${n.title ? `<div class="note-card-title">${escapeHTML(n.title)}</div>` : ''}
      <div class="note-card-content">${escapeHTML(n.content)}</div>
      <div class="note-card-footer">
        <span>${escapeHTML(n.date)}</span>
        <button class="del-note-btn" title="Löschen" aria-label="Notiz löschen">🗑</button>
      </div>`;
    card.addEventListener('click', (e) => { if (!e.target.closest('.del-note-btn')) openNote(n); });
    card.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === card) openNote(n); });
    card.querySelector('.del-note-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      if (confirm('Diese Notiz löschen?')) removeNote(n);
    });
    notesGrid.appendChild(card);
  }
  notesEmpty.classList.toggle('hidden', shown.length > 0);
  notesEmpty.textContent = query ? 'Keine Notiz passt zur Suche.' : 'Noch keine Notizen – oben die erste schreiben.';
}

searchInput.addEventListener('input', renderNotes);

resetCreator();
initStorage();
