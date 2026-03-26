/* ═══════════════════════════════════════════════════════════════
   Media Indexer — main.js
   Architecture : class-based modals (.show), async/await, clean state
═══════════════════════════════════════════════════════════════ */

const API = 'http://127.0.0.1:8765';
const NAV_ORDER_KEY = 'mi-nav-order';
const NAV_LONG_PRESS_MS = 280;
let DEFAULT_NAV_ORDER = [];

const state = {
  tab: 'all',
  disk: 'Tous',
  search: '',
  sortCol: 'nom',
  sortOrder: 'asc',
  seriesView: 'list',
  selectedFile: null,
  privateUnlocked: false,
  privateLockTimer: null,
  privateTimeout: 5,
  currentRegroupSuggestion: null,
  tagModalChemin: '',
  tagModalCurrent: '',
  missingSearch: localStorage.getItem('mi-missing-search') || '',
  missingSort: localStorage.getItem('mi-missing-sort') || 'priority',
  missingOrder: localStorage.getItem('mi-missing-order') || 'asc',
  missingShowPriorityOnly: localStorage.getItem('mi-missing-priority-only') === '1',
  missingShowIgnored: localStorage.getItem('mi-missing-show-ignored') === '1',
  missingView: localStorage.getItem('mi-missing-view') || 'detailed',
  navDrag: null,
  backendStopOnClose: localStorage.getItem('mi-backend-stop-on-close') === '1',
};

/* ─── Utils ─────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const fmt = n => { const v = Number(n); if (!isFinite(v)) return '—'; return v >= 1024 ? (v/1024).toFixed(1)+' GB' : v.toFixed(1)+' MB'; };

const readStore = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch(e) { return fallback; }
};
const writeStore = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch(e) {}
};
const missingPrefs = {
  ignoredSeasons: () => readStore('mi-missing-ignored-seasons', {}),
  ignoredEpisodes: () => readStore('mi-missing-ignored-episodes', {}),
  snapshot: () => readStore('mi-missing-snapshot', {}),
  activity: () => readStore('mi-missing-activity', []),
};
function persistMissingUiState() {
  localStorage.setItem('mi-missing-search', state.missingSearch || '');
  localStorage.setItem('mi-missing-sort', state.missingSort || 'priority');
  localStorage.setItem('mi-missing-order', state.missingOrder || 'asc');
  localStorage.setItem('mi-missing-priority-only', state.missingShowPriorityOnly ? '1' : '0');
  localStorage.setItem('mi-missing-show-ignored', state.missingShowIgnored ? '1' : '0');
  localStorage.setItem('mi-missing-view', state.missingView || 'detailed');
}
function escapeHtml(s='') {
  return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
}
function slugMissingKey(serie, saison) { return `${serie}__S${saison}`; }
function normalizeSerieText(value) {
  return String(value || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}
function tokenizeSerieName(value) {
  return normalizeSerieText(value).split(/[^a-z0-9]+/).filter(Boolean);
}
function tsNowIso() {
  return new Date().toISOString();
}
function humanDateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' });
}
function saveMissingActivity(entry) {
  const items = missingPrefs.activity();
  items.unshift({ ...entry, at: tsNowIso() });
  writeStore('mi-missing-activity', items.slice(0, 25));
}
function downloadTextFile(filename, content, mime='text/plain;charset=utf-8') {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 0);
}

async function api(path, opts = {}) {
  try {
    const r = await fetch(API + path, opts);
    return await r.json();
  } catch(e) { console.error('API error', path, e); return null; }
}

function setStatus(msg, busy = false) {
  const t = $('status-text'), d = $('status-dot');
  if (t) t.textContent = msg;
  if (d) d.className = 'status-dot' + (busy ? ' busy' : '');
}

async function pickFolder(title) {
  try {
    if (window.__TAURI__?.dialog?.open) {
      const f = await window.__TAURI__.dialog.open({ directory: true, multiple: false, title });
      return Array.isArray(f) ? f[0] : f;
    }
  } catch(e) {}
  return prompt(title + '\nChemin (ex: E:\\Films) :');
}

async function pickFile(title, filters) {
  try {
    if (window.__TAURI__?.dialog?.save) {
      return await window.__TAURI__.dialog.save({ filters, title });
    }
  } catch(e) {}
  return prompt(title + '\nChemin (ex: C:\\export.xlsx) :');
}


let backendChild = null;
let backendBootPromise = null;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function isBackendReady() {
  try {
    const r = await fetch(API + '/ping');
    return r.ok;
  } catch(_) {
    return false;
  }
}

async function waitBackendReady(timeoutMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isBackendReady()) return true;
    await sleep(350);
  }
  throw new Error('Backend non disponible');
}

async function startBackendSidecar() {
  if (await isBackendReady()) return true;
  if (backendBootPromise) return backendBootPromise;

  backendBootPromise = (async () => {
    const sidecarFactory = window.__TAURI__?.shell?.Command?.sidecar;
    if (!sidecarFactory) {
      throw new Error('API shell Tauri indisponible');
    }

    try {
      const cmd = sidecarFactory('binaries/media-indexer-api');
      backendChild = await cmd.spawn();
    } catch (err) {
      console.error('Impossible de lancer le sidecar backend:', err);
    }

    return waitBackendReady();
  })();

  try {
    return await backendBootPromise;
  } finally {
    backendBootPromise = null;
  }
}

function updateBackendCloseStatus() {
  const status = $('backend-stop-on-close-status');
  if (!status) return;
  status.classList.remove('is-green', 'is-orange');
  if (state.backendStopOnClose) {
    status.textContent = "Le backend s'arrêtera aussi quand tu fermes l'application.";
    status.classList.add('is-orange');
  } else {
    status.textContent = "Le backend restera actif en arrière-plan après la fermeture.";
    status.classList.add('is-green');
  }
}

function setBackendStopOnClosePreference(enabled) {
  state.backendStopOnClose = !!enabled;
  localStorage.setItem('mi-backend-stop-on-close', state.backendStopOnClose ? '1' : '0');
  const cb = $('backend-stop-on-close');
  if (cb) cb.checked = state.backendStopOnClose;
  updateBackendCloseStatus();
}

function loadRuntimeSettingsUi() {
  const cb = $('backend-stop-on-close');
  if (cb) cb.checked = state.backendStopOnClose;
  updateBackendCloseStatus();
}

function shutdownBackendOnWindowExit() {
  if (state.backendStopOnClose) {
    try { fetch(API + '/shutdown', { method: 'POST', keepalive: true }); } catch(_) {}
  }
  try { backendChild?.kill?.(); } catch(_) {}
}

window.addEventListener('beforeunload', shutdownBackendOnWindowExit);
window.addEventListener('unload', shutdownBackendOnWindowExit);


function setUpdateFeedback(message = '', color = 'var(--muted)') {
  const el = $('update-feedback');
  if (!el) return;
  el.textContent = message;
  el.style.color = color;
}

async function checkForAppUpdate({ silent = false } = {}) {
  try {
    const updater = window.__TAURI__?.updater;
    const processApi = window.__TAURI__?.process;

    if (!updater?.checkUpdate || !updater?.installUpdate || !updater?.onUpdaterEvent) {
      if (!silent) setUpdateFeedback('Updater Tauri indisponible dans cette build.', 'var(--muted)');
      return false;
    }

    if (!silent) {
      setUpdateFeedback('Vérification en cours…', 'var(--muted)');
      const btn = $('btn-check-update');
      if (btn) { btn.disabled = true; btn.textContent = 'Vérification…'; }
    }

    const unlisten = await updater.onUpdaterEvent(({ error, status }) => {
      if (error) console.error('Updater error:', error);
      else console.log('Updater status:', status);
    });

    try {
      const { shouldUpdate, manifest } = await updater.checkUpdate();

      if (!shouldUpdate) {
        if (!silent) setUpdateFeedback('Aucune mise à jour disponible.', 'var(--accent2)');
        return false;
      }

      const version = manifest?.version ?? 'inconnue';
      const notes = manifest?.body || manifest?.notes || 'Aucune note de version.';
      const ok = confirm(
        `Une nouvelle version ${version} est disponible.\n\n${notes}\n\nInstaller maintenant ?`
      );

      if (!ok) {
        if (!silent) setUpdateFeedback('Mise à jour reportée.', 'var(--muted)');
        return false;
      }

      if (!silent) setUpdateFeedback('Téléchargement et installation…', 'var(--muted)');
      await updater.installUpdate();

      try {
        await processApi?.relaunch?.();
      } catch (e) {
        console.warn('Relaunch:', e);
      }

      return true;
    } finally {
      if (typeof unlisten === 'function') unlisten();
      if (!silent) {
        const btn = $('btn-check-update');
        if (btn) { btn.disabled = false; btn.textContent = 'Vérifier les mises à jour'; }
      }
    }
  } catch (e) {
    console.error('Erreur update:', e);
    if (!silent) setUpdateFeedback('Impossible de vérifier les mises à jour.', 'var(--danger)');
    return false;
  }
}

/* ─── Modals (class-based) ──────────────────────────────────── */
function openModal(id, overlayId) {
  const m = $(id), o = overlayId ? $(overlayId) : null;
  if (m) m.classList.add('show');
  if (o) o.classList.add('show');
}

function closeModal(id, overlayId) {
  const m = $(id), o = overlayId ? $(overlayId) : null;
  if (m) m.classList.remove('show');
  if (o) o.classList.remove('show');
}

function closeAllModals() {
  document.querySelectorAll('.show').forEach(el => {
    if (el.id !== 'detail-panel' && el.id !== 'serie-panel') {
      el.classList.remove('show');
    }
  });
}

/* ─── Init ──────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  DEFAULT_NAV_ORDER = getNavButtons().map(btn => btn.dataset.tab);
  applySavedNavOrder();
  initNav();
  initSidebarReorder();
  initSearch();
  initDiskFilter();
  initFooter();
  initDetailPanel();
  initSettings();
  initPinModal();
  initTagModal();
  initFixSerieModal();
  initRegroupModal();
  initRuleModal();
  initViewToggle();
  initKeyboard();
  initApp();
});

async function initApp() {
  setStatus('Connexion…', true);
  try { await startBackendSidecar(); } catch (e) { console.warn('Backend sidecar:', e); }
  let tries = 0;
  while (tries < 30) {
    const r = await api('/ping');
    if (r?.ok) break;
    await new Promise(res => setTimeout(res, 500));
    tries++;
  }
  const cfg = await api('/config');
  if (cfg) state.privateTimeout = cfg.private_timeout ?? 5;
  updateLockBtn();
  setStatus('Prêt');
  await updateCounts();
  render();
  setTimeout(() => { checkForAppUpdate({ silent: true }); }, 1800);
  setInterval(pollDisks, 4000);
  setInterval(async () => { await updateCounts(); }, 30000);
}

function getNavButtons() {
  return [...document.querySelectorAll('.nav .nav-btn[data-tab]')];
}

function applySavedNavOrder() {
  const nav = document.querySelector('.nav');
  const saved = readStore(NAV_ORDER_KEY, []);
  if (!nav || !Array.isArray(saved) || saved.length === 0) return;

  const byTab = new Map(getNavButtons().map(btn => [btn.dataset.tab, btn]));
  saved.forEach(tab => {
    const btn = byTab.get(tab);
    if (btn) nav.appendChild(btn);
  });
  getNavButtons().forEach(btn => {
    if (!saved.includes(btn.dataset.tab)) nav.appendChild(btn);
  });
}

function saveNavOrder() {
  writeStore(NAV_ORDER_KEY, getNavButtons().map(btn => btn.dataset.tab));
}

function resetNavOrder() {
  const nav = document.querySelector('.nav');
  if (!nav || !DEFAULT_NAV_ORDER.length) return;

  const byTab = new Map(getNavButtons().map(btn => [btn.dataset.tab, btn]));
  DEFAULT_NAV_ORDER.forEach(tab => {
    const btn = byTab.get(tab);
    if (btn) nav.appendChild(btn);
  });
  localStorage.removeItem(NAV_ORDER_KEY);
  setStatus('Ordre du menu réinitialisé');
  setTimeout(() => {
    if ($('status-text')?.textContent === 'Ordre du menu réinitialisé') setStatus('Prêt');
  }, 1600);
}

function initSidebarReorder() {
  const nav = document.querySelector('.nav');
  if (!nav) return;

  getNavButtons().forEach(bindSidebarReorderButton);
  $('btn-reset-nav-order')?.addEventListener('click', resetNavOrder);
}

function bindSidebarReorderButton(btn) {
  if (!btn || btn.dataset.reorderBound === '1') return;
  btn.dataset.reorderBound = '1';

  let pressTimer = null;
  let startX = 0;
  let startY = 0;

  const cancelPress = () => {
    if (pressTimer) clearTimeout(pressTimer);
    pressTimer = null;
    btn.classList.remove('drag-armed');
  };

  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    if (state.navDrag?.active) return;

    startX = e.clientX;
    startY = e.clientY;
    btn.classList.add('drag-armed');

    pressTimer = setTimeout(() => {
      pressTimer = null;
      startSidebarDrag(btn, e.pointerId);
    }, NAV_LONG_PRESS_MS);
  });

  btn.addEventListener('pointermove', (e) => {
    if (!pressTimer) return;
    const dx = Math.abs(e.clientX - startX);
    const dy = Math.abs(e.clientY - startY);
    if (dx > 6 || dy > 6) cancelPress();
  });

  btn.addEventListener('pointerup', cancelPress);
  btn.addEventListener('pointercancel', cancelPress);
  btn.addEventListener('dragstart', (e) => e.preventDefault());
}

function startSidebarDrag(btn, pointerId) {
  const nav = document.querySelector('.nav');
  if (!nav) return;

  state.navDrag = {
    active: true,
    btn,
    pointerId,
  };

  btn.dataset.skipClick = '1';
  nav.classList.add('reorder-mode');
  btn.classList.remove('drag-armed');
  btn.classList.add('dragging');
  document.body.classList.add('sidebar-dragging');

  const onMove = (e) => handleSidebarDragMove(e);
  const onEnd = (e) => endSidebarDrag(e, onMove, onEnd);

  state.navDrag.onMove = onMove;
  state.navDrag.onEnd = onEnd;

  document.addEventListener('pointermove', onMove, true);
  document.addEventListener('pointerup', onEnd, true);
  document.addEventListener('pointercancel', onEnd, true);
}

function handleSidebarDragMove(e) {
  const drag = state.navDrag;
  if (!drag?.active) return;

  e.preventDefault();
  const nav = document.querySelector('.nav');
  const draggingBtn = drag.btn;
  if (!nav || !draggingBtn) return;

  const navRect = nav.getBoundingClientRect();
  if (e.clientY < navRect.top + 44) nav.scrollTop -= 14;
  else if (e.clientY > navRect.bottom - 44) nav.scrollTop += 14;

  const otherButtons = getNavButtons().filter(btn => btn !== draggingBtn);
  let inserted = false;
  for (const candidate of otherButtons) {
    const rect = candidate.getBoundingClientRect();
    const midpoint = rect.top + rect.height / 2;
    if (e.clientY < midpoint) {
      nav.insertBefore(draggingBtn, candidate);
      inserted = true;
      break;
    }
  }

  if (!inserted) nav.appendChild(draggingBtn);
}

function endSidebarDrag(_e, onMove, onEnd) {
  const drag = state.navDrag;
  if (!drag?.active) return;

  document.removeEventListener('pointermove', onMove, true);
  document.removeEventListener('pointerup', onEnd, true);
  document.removeEventListener('pointercancel', onEnd, true);

  const nav = document.querySelector('.nav');
  if (nav) nav.classList.remove('reorder-mode');
  document.body.classList.remove('sidebar-dragging');

  drag.btn.classList.remove('dragging');
  saveNavOrder();

  const draggedBtn = drag.btn;
  state.navDrag = null;

  setTimeout(() => { draggedBtn.dataset.skipClick = ''; }, 140);
}

/* ─── Navigation ────────────────────────────────────────────── */
function initNav() {
  document.querySelectorAll('.nav-btn[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (state.navDrag?.active || btn.dataset.skipClick === '1') return;
      document.querySelectorAll('.nav-btn.active').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.tab = btn.dataset.tab;
      const vt = $('view-toggle');
      if (vt) vt.style.display = state.tab === 'series' ? 'flex' : 'none';
      if (state.tab === 'private' && !state.privateUnlocked) {
        openPinModal('unlock');
      }
      render();
    });
  });
}

/* ─── Recherche ─────────────────────────────────────────────── */
function initSearch() {
  const input = $('search-input');
  let timer;
  input?.addEventListener('input', e => {
    state.search = e.target.value;
    clearTimeout(timer);
    timer = setTimeout(render, 300);
  });
  $('search-clear')?.addEventListener('click', () => {
    if (input) input.value = '';
    state.search = '';
    render();
  });
}

function initDiskFilter() {
  $('disk-filter')?.addEventListener('change', e => { state.disk = e.target.value; render(); });
}

/* ─── Footer ────────────────────────────────────────────────── */
function initFooter() {
  $('btn-scan')?.addEventListener('click', startScan);
  $('btn-export')?.addEventListener('click', doExport);
  $('btn-settings')?.addEventListener('click', openSettings);
  $('btn-lock')?.addEventListener('click', () => {
    if (state.privateUnlocked) lockPrivate();
    else openPinModal('unlock');
  });
  $('btn-notif-scan')?.addEventListener('click', async () => {
    $('disk-notif').style.display = 'none';
    const r = await api('/scan', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path: $('disk-notif').dataset.racine || '' }) });
    if (r?.started) startScanPolling();
  });
  $('btn-notif-ignore')?.addEventListener('click', () => {
    $('disk-notif').style.display = 'none';
    api('/dismiss-disk', { method: 'POST' });
  });
}

/* ─── View toggle (séries) ──────────────────────────────────── */
function initViewToggle() {
  $('btn-view-list')?.addEventListener('click', () => {
    state.seriesView = 'list';
    $('btn-view-list').classList.add('active');
    $('btn-view-grid').classList.remove('active');
    render();
  });
  $('btn-view-grid')?.addEventListener('click', () => {
    state.seriesView = 'grid';
    $('btn-view-grid').classList.add('active');
    $('btn-view-list').classList.remove('active');
    render();
  });
}

/* ─── Keyboard ──────────────────────────────────────────────── */
function initKeyboard() {
  document.addEventListener('keydown', e => {
    const inInput = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);
    if ((e.ctrlKey && e.key === 'f') || (e.key === '/' && !inInput)) {
      e.preventDefault(); $('search-input')?.focus(); $('search-input')?.select(); return;
    }
    if (e.key === 'Escape') { closeAllModals(); closeDetail(); closeSeriePanel(); return; }
    if (!inInput) {
      if (e.key === 'r') { setTab('recent'); return; }
      if (e.key === 'f') { setTab('favoris'); return; }
    }
  });
}

function setTab(tab) {
  document.querySelectorAll('.nav-btn.active').forEach(b => b.classList.remove('active'));
  const btn = document.querySelector(`[data-tab="${tab}"]`);
  if (btn) btn.classList.add('active');
  state.tab = tab;
  render();
}

/* ─── Scan ──────────────────────────────────────────────────── */
async function startScan() {
  const folder = await pickFolder('Choisir un dossier à scanner');
  if (!folder) return;
  const r = await api('/scan', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path: folder }) });
  if (r?.started) startScanPolling();
  else if (r?.error) setStatus(r.error);
}

function startScanPolling() {
  const btn = $('btn-scan');
  if (btn) { btn.textContent = 'Scan…'; btn.disabled = true; }
  const bar = $('scan-progress-bar');
  if (bar) bar.style.display = 'flex';
  const interval = setInterval(async () => {
    const p = await api('/scan/progress');
    if (!p) return;
    const pct = p.total > 0 ? Math.round((p.current / p.total) * 100) : 0;
    const fill = $('scan-progress-fill');
    const text = $('scan-progress-text');
    if (fill) fill.style.width = pct + '%';
    if (text) text.textContent = p.total > 0 ? `${p.current.toLocaleString()} / ${p.total.toLocaleString()} (${pct}%)` : `${p.current.toLocaleString()} fichiers…`;
    if (!p.running) {
      clearInterval(interval);
      if (btn) { btn.textContent = '+ Scanner'; btn.disabled = false; }
      if (bar) bar.style.display = 'none';
      if (fill) fill.style.width = '0%';
      setStatus(`Scan terminé — ${p.count} fichiers`);
      await updateCounts();
      render();
    }
  }, 600);
}

async function doExport() {
  const dest = await pickFile('Exporter vers Excel', [{ name: 'Excel', extensions: ['xlsx'] }]);
  if (!dest) return;
  setStatus('Export…', true);
  const r = await api('/export', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ path: dest }) });
  setStatus(r?.ok ? 'Export terminé !' : 'Erreur export');
}

/* ─── Detail panel ──────────────────────────────────────────── */
function initDetailPanel() {
  $('detail-close')?.addEventListener('click', closeDetail);
  $('overlay')?.addEventListener('click', () => { closeDetail(); closeSeriePanel(); });

  $('btn-open-file')?.addEventListener('click', () => {
    if (state.selectedFile?.chemin) ouvrirFichier(state.selectedFile.chemin);
  });

  $('btn-ollama')?.addEventListener('click', async () => {
    const f = state.selectedFile;
    if (!f?.chemin) return;
    $('btn-ollama').textContent = 'Analyse…'; $('btn-ollama').disabled = true;
    setStatus(`Analyse : ${f.nom}…`, true);
    const r = await api('/analyse', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ chemin: f.chemin }) });
    $('btn-ollama').disabled = false; $('btn-ollama').textContent = 'Analyser avec Ollama';
    if (r?.ok) {
      $('detail-resume').textContent = r.resume || '—';
      if (r.titre) $('detail-title').textContent = r.titre;
      renderOllamaTags(r.tags || '');
      setStatus('Analyse terminée');
    } else setStatus('Erreur — Ollama lancé ?');
  });

  $('btn-favori')?.addEventListener('click', async () => {
    const f = state.selectedFile;
    if (!f?.chemin) return;
    const next = f.favori ? 0 : 1;
    const r = await api('/favori', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ chemin: f.chemin, favori: next }) });
    if (r?.ok) {
      f.favori = next;
      updateFavoriBtn(next);
      setStatus(next ? 'Ajouté aux favoris' : 'Retiré des favoris');
      await updateCounts();
    }
  });

  $('detail-note')?.addEventListener('blur', async e => {
    const f = state.selectedFile;
    if (!f?.chemin) return;
    f.note = e.target.value;
    await api('/note', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ chemin: f.chemin, note: f.note }) });
  });

  $('btn-fix-serie')?.addEventListener('click', () => {
    if (state.selectedFile) openFixSerieModal(state.selectedFile);
  });
}

function openDetail(file) {
  if (file._prive && !state.privateUnlocked) return;
  state.selectedFile = file;

  const type = file.type || 'Autre';
  $('detail-type').textContent = type;
  $('detail-type').className = 'detail-type type-' + type;
  $('detail-title').textContent = file.titre || file.nom || '—';
  $('detail-path').textContent = file.chemin || '—';

  let meta = fmt(file.taille_mb);
  if (file.qualite) meta = file.qualite + '  ' + meta;
  if (file.serie) meta = `${file.serie}  S${String(file.saison||0).padStart(2,'0')}E${String(file.episode||0).padStart(3,'0')}\n` + meta;
  meta += `\n${file.disque || ''}:`;
  $('detail-meta').textContent = meta;

  $('detail-resume').textContent = file.resume || 'Pas encore analysé.';
  renderOllamaTags(file.tags || '');
  renderTagsManuels(file.tags_manuels || '', file.chemin);
  $('detail-note').value = file.note || '';
  $('detail-note').dataset.chemin = file.chemin;
  updateFavoriBtn(file.favori);

  // Montrer bouton fix seulement pour vidéos
  const fixBtn = $('btn-fix-serie');
  if (fixBtn) fixBtn.style.display = file.type === 'Vidéo' ? 'block' : 'none';

  $('detail-panel').classList.add('open');
  $('overlay').classList.add('show');
}

function closeDetail() {
  $('detail-panel')?.classList.remove('open');
  $('overlay')?.classList.remove('show');
}

function renderOllamaTags(tagsStr) {
  const el = $('detail-tags');
  if (!el) return;
  el.innerHTML = '';
  tagsStr.split(',').map(t => t.trim()).filter(Boolean).forEach(t => {
    const pill = document.createElement('span');
    pill.className = 'tag-pill';
    pill.textContent = t;
    el.appendChild(pill);
  });
}

function renderTagsManuels(tagsStr, chemin) {
  const el = $('detail-tags-manuels');
  if (!el) return;
  el.innerHTML = '';
  const tags = tagsStr.split(',').map(t => t.trim()).filter(Boolean);
  tags.forEach(tag => {
    const pill = document.createElement('span');
    pill.className = 'tag-manuel-pill';
    pill.innerHTML = `${tag} <button class="tag-manuel-remove" data-tag="${tag}" data-chemin="${chemin}">×</button>`;
    el.appendChild(pill);
  });
  const addBtn = document.createElement('button');
  addBtn.className = 'tag-manuel-add';
  addBtn.textContent = '+ tag';
  addBtn.addEventListener('click', () => openTagModal(chemin, tagsStr));
  el.appendChild(addBtn);
  el.querySelectorAll('.tag-manuel-remove').forEach(btn => {
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      const newTags = tags.filter(t => t !== btn.dataset.tag).join(',');
      await api('/tags-manuels', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ chemin: btn.dataset.chemin, tags_manuels: newTags }) });
      if (state.selectedFile) state.selectedFile.tags_manuels = newTags;
      renderTagsManuels(newTags, btn.dataset.chemin);
    });
  });
}

function updateFavoriBtn(favori) {
  const btn = $('btn-favori');
  if (!btn) return;
  btn.textContent = favori ? '⭐ Retirer des favoris' : '☆ Ajouter aux favoris';
  btn.classList.toggle('is-favori', !!favori);
}

async function ouvrirFichier(chemin) {
  const r = await api('/ouvrir', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ chemin }) });
  if (!r?.ok) setStatus('Impossible d\'ouvrir le fichier');
}


function getParentFolderPath(filePath = '') {
  const clean = String(filePath || '').replace(/[\/]+$/, '');
  const slash = Math.max(clean.lastIndexOf('\\'), clean.lastIndexOf('/'));
  return slash >= 0 ? clean.slice(0, slash) : clean;
}

function getDiskLabel(filePath = '') {
  const m = String(filePath || '').match(/^[A-Za-z]:/);
  return m ? m[0].toUpperCase() : 'Autre';
}

function summarizeSeasons(seasons = []) {
  const nums = [...new Set((seasons || []).map(n => Number(n)).filter(Number.isFinite))].sort((a, b) => a - b);
  if (!nums.length) return 'Saisons inconnues';
  if (nums.length === 1) return `S${nums[0]}`;
  return nums.length <= 4 ? nums.map(n => `S${n}`).join(', ') : `S${nums[0]}–S${nums[nums.length - 1]}`;
}

async function fetchSerieFolders(serieName) {
  const detail = await api('/series/' + encodeURIComponent(serieName) + '/detail');
  const folderMap = new Map();
  for (const saison of detail?.saisons || []) {
    for (const ep of saison.episodes || []) {
      const folder = getParentFolderPath(ep.chemin);
      if (!folder) continue;
      if (!folderMap.has(folder)) {
        folderMap.set(folder, {
          path: folder,
          disk: ep.disque || getDiskLabel(folder),
          count: 0,
          seasons: new Set(),
        });
      }
      const item = folderMap.get(folder);
      item.count += 1;
      item.seasons.add(Number(saison.saison));
    }
  }
  return [...folderMap.values()]
    .map(item => ({ ...item, seasons: [...item.seasons].sort((a, b) => a - b) }))
    .sort((a, b) => a.disk.localeCompare(b.disk, 'fr') || b.count - a.count || a.path.localeCompare(b.path, 'fr'));
}

async function ouvrirDossier(chemin) {
  const r = await api('/ouvrir', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ chemin }) });
  if (r?.ok) setStatus('Dossier ouvert');
  else setStatus("Impossible d'ouvrir le dossier");
}

function closeSerieFoldersModal() {
  closeModal('serie-folders-modal', 'serie-folders-overlay');
}

function ensureSerieFoldersModal() {
  if ($('serie-folders-modal') && $('serie-folders-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'serie-folders-overlay';
  overlay.className = 'series-folders-overlay';
  overlay.addEventListener('click', closeSerieFoldersModal);

  const modal = document.createElement('div');
  modal.id = 'serie-folders-modal';
  modal.className = 'series-folders-modal';
  modal.innerHTML = `
    <div class="series-folders-header">
      <div>
        <div class="series-folders-title" id="serie-folders-title">Dossiers de la série</div>
        <div class="series-folders-subtitle" id="serie-folders-subtitle">Choisis le dossier à ouvrir</div>
      </div>
      <button class="detail-close" id="serie-folders-close">✕</button>
    </div>
    <div class="series-folders-body" id="serie-folders-body"></div>
    <div class="series-folders-footer">
      <button class="pin-btn-cancel" id="serie-folders-cancel">Fermer</button>
    </div>`;

  document.body.appendChild(overlay);
  document.body.appendChild(modal);
  $('serie-folders-close')?.addEventListener('click', closeSerieFoldersModal);
  $('serie-folders-cancel')?.addEventListener('click', closeSerieFoldersModal);
}

function ensureSeriePanelFoldersButton() {
  const header = document.querySelector('.serie-panel-header');
  const closeBtn = $('serie-panel-close');
  if (!header || !closeBtn) return null;
  let btn = $('serie-panel-open-folders');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'serie-panel-open-folders';
    btn.className = 'serie-open-folders-btn panel';
    btn.type = 'button';
    btn.textContent = '📂 Dossiers';
    header.insertBefore(btn, closeBtn);
    btn.addEventListener('click', async e => {
      e.stopPropagation();
      if (btn.dataset.serie) await handleOpenSerieFolders(btn.dataset.serie, btn);
    });
  }
  return btn;
}

function showSerieFoldersModal(serieName, folders) {
  ensureSerieFoldersModal();
  const title = $('serie-folders-title');
  const subtitle = $('serie-folders-subtitle');
  const body = $('serie-folders-body');
  if (!body) return;

  if (title) title.textContent = `Dossiers · ${serieName}`;
  if (subtitle) subtitle.textContent = `${folders.length} dossier(s) trouvé(s) — choisis celui à ouvrir.`;

  const groups = folders.reduce((acc, folder) => {
    const key = folder.disk || getDiskLabel(folder.path);
    if (!acc.has(key)) acc.set(key, []);
    acc.get(key).push(folder);
    return acc;
  }, new Map());

  body.innerHTML = [...groups.entries()].map(([disk, items]) => `
    <div class="series-folder-group">
      <div class="series-folder-group-title">${escapeHtml(disk)}</div>
      <div class="series-folder-list">${items.map(folder => `
        <button class="series-folder-item" type="button" data-path="${escapeHtml(folder.path)}">
          <span class="series-folder-item-top">
            <span class="series-folder-item-name">${escapeHtml(folder.path.split('\\').pop() || folder.path)}</span>
            <span class="series-folder-item-count">${folder.count} ép.</span>
          </span>
          <span class="series-folder-item-path" title="${escapeHtml(folder.path)}">${escapeHtml(folder.path)}</span>
          <span class="series-folder-item-seasons">${escapeHtml(summarizeSeasons(folder.seasons))}</span>
        </button>`).join('')}</div>
    </div>`).join('');

  body.querySelectorAll('.series-folder-item').forEach(btn => {
    btn.addEventListener('click', async () => {
      await ouvrirDossier(btn.dataset.path);
      closeSerieFoldersModal();
    });
  });

  openModal('serie-folders-modal', 'serie-folders-overlay');
}

async function handleOpenSerieFolders(serieName, triggerBtn = null) {
  const btn = triggerBtn;
  const previous = btn?.textContent;
  if (btn) {
    btn.disabled = true;
    btn.textContent = btn.classList.contains('panel') ? '…' : '…';
  }
  try {
    const folders = await fetchSerieFolders(serieName);
    if (!folders.length) {
      setStatus('Aucun dossier trouvé pour cette série');
      return;
    }
    if (folders.length === 1) {
      await ouvrirDossier(folders[0].path);
      return;
    }
    showSerieFoldersModal(serieName, folders);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = previous || '📂';
    }
  }
}

/* ─── Serie panel ───────────────────────────────────────────── */
async function openSeriePanel(serieName) {
  $('serie-panel-title').textContent = serieName;
  const foldersBtn = ensureSeriePanelFoldersButton();
  if (foldersBtn) {
    foldersBtn.dataset.serie = serieName;
    foldersBtn.title = `Ouvrir les dossiers de ${serieName}`;
  }
  $('serie-panel-body').innerHTML = '<div class="serie-accordion-loading">Chargement…</div>';
  $('serie-panel').classList.add('open');
  $('overlay').classList.add('show');
  await loadSerieDetail(serieName, $('serie-panel-body'));
}

function closeSeriePanel() {
  $('serie-panel')?.classList.remove('open');
  $('overlay')?.classList.remove('show');
}
$('serie-panel-close')?.addEventListener('click', closeSeriePanel);

/* ─── Poll disques ──────────────────────────────────────────── */
async function pollDisks() {
  const r = await api('/new-disk');
  if (r?.disk) {
    const d = r.disk;
    const banner = $('disk-notif');
    if (banner) {
      $('disk-notif-title').textContent = `Nouveau disque ${d.lettre}: — ${d.label}`;
      $('disk-notif-sub').textContent = `${d.total_gb} GB · ${d.type}`;
      banner.dataset.racine = d.racine;
      banner.style.display = 'flex';
    }
  }
}

/* ═══════════════════════════════════════════════════════════════
   RENDU PRINCIPAL
═══════════════════════════════════════════════════════════════ */
async function render() {
  const content = $('content');
  if (!content) return;
  content.innerHTML = '<div class="loading">Chargement…</div>';

  switch(state.tab) {
    case 'stats':     await renderStats(content); break;
    case 'series':    await renderSeries(content); break;
    case 'dupes':     await renderDuplicates(content); break;
    case 'missing':   await renderMissing(content); break;
    case 'private':   await renderPrivate(content); break;
    case 'corrupted': await renderCorrupted(content); break;
    case 'compare':   await renderCompare(content); break;
    case 'evolution': await renderEvolution(content); break;
    case 'rules':     await renderRules(content); break;
    case 'regroup':   await renderRegroup(content); break;
    default:          await renderFiles(content); break;
  }
}


const FILE_TABLE_MIN_WIDTH = 90;

function getStoredColWidth(scope, key, fallback) {
  const v = Number(readStore(`mi-colwidth-${scope}-${key}`, fallback));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function setStoredColWidth(scope, key, width) {
  writeStore(`mi-colwidth-${scope}-${key}`, Math.max(FILE_TABLE_MIN_WIDTH, Math.round(width)));
}

function attachResizableColumns(table, cols, scope) {
  if (!table || !Array.isArray(cols) || !cols.length) return;
  if (table.dataset.resizableReady === '1') return;
  table.dataset.resizableReady = '1';

  const colgroup = document.createElement('colgroup');
  let totalWidth = 0;
  cols.forEach(col => {
    const c = document.createElement('col');
    const width = getStoredColWidth(scope, col.key, col.width || 140);
    c.dataset.colKey = col.key;
    c.style.width = `${width}px`;
    colgroup.appendChild(c);
    totalWidth += width;
  });
  table.prepend(colgroup);
  table.style.tableLayout = 'fixed';
  table.classList.add('resizable-table');

  const applyMinWidth = () => {
    table.style.minWidth = `${Math.max(totalWidth, table.parentElement?.clientWidth || 0)}px`;
  };
  applyMinWidth();

  const headers = table.querySelectorAll('thead th');
  headers.forEach((th, index) => {
    const meta = cols[index];
    if (!meta) return;
    th.dataset.colKey = meta.key;
    th.classList.add('resizable-col');
    th.style.position = 'relative';
    if (th.querySelector('.col-resizer')) return;
    const handle = document.createElement('span');
    handle.className = 'col-resizer';
    handle.title = `Redimensionner ${meta.label}`;
    handle.addEventListener('click', (e) => e.stopPropagation());
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const startX = e.clientX;
      const colEl = colgroup.children[index];
      const startWidth = parseFloat(colEl.style.width) || th.getBoundingClientRect().width;
      const minWidth = meta.minWidth || FILE_TABLE_MIN_WIDTH;
      let lastAppliedWidth = startWidth;
      let pendingWidth = startWidth;
      let rafId = 0;

      document.body.classList.add('is-resizing-cols');

      const flushWidth = () => {
        rafId = 0;
        if (pendingWidth === lastAppliedWidth) return;
        totalWidth += pendingWidth - lastAppliedWidth;
        lastAppliedWidth = pendingWidth;
        colEl.style.width = `${pendingWidth}px`;
        applyMinWidth();
      };

      const queueWidth = (nextWidth) => {
        pendingWidth = nextWidth;
        if (!rafId) rafId = requestAnimationFrame(flushWidth);
      };

      const onMove = (ev) => {
        const nextWidth = Math.max(minWidth, startWidth + (ev.clientX - startX));
        queueWidth(nextWidth);
      };

      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        document.body.classList.remove('is-resizing-cols');
        if (rafId) {
          cancelAnimationFrame(rafId);
          flushWidth();
        }
        setStoredColWidth(scope, meta.key, lastAppliedWidth);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
    th.appendChild(handle);
  });
}

async function renderFiles(content) {
  const typeMap = { all:'Tous', pdf:'PDF', images:'Image', music:'Musique', others:'Autre', recent:'Tous', favoris:'Tous' };
  const params = new URLSearchParams({
    q: state.search, type: typeMap[state.tab]||'Tous', disk: state.disk,
    sort: state.sortCol, order: state.sortOrder,
    unlocked: state.privateUnlocked ? 1 : 0,
  });
  if (state.tab === 'recent') params.set('recent', '50');
  if (state.tab === 'favoris') params.set('favoris', '1');
  const data = await api('/files?' + params);
  if (!data) { content.innerHTML = '<div class="empty">Erreur de connexion. Backend lancé ?</div>'; return; }
  $('result-count').textContent = `${data.length} fichier(s)`;
  if (data.length === 0) { content.innerHTML = `<div class="empty">${state.tab==='favoris'?'Aucun favori. Clique sur ☆ dans le panel détail.':'Aucun fichier. Clique sur "+ Scanner".'}</div>`; return; }

  const table = document.createElement('table');
  table.className = 'file-table';
  const cols = [
    { key:'nom', label:'Fichier', width: 420, minWidth: 220 },
    { key:'type', label:'Type', width: 120, minWidth: 90 },
    { key:'serie', label:'Série/Ép.', width: 220, minWidth: 130 },
    { key:'disque', label:'Disque', width: 110, minWidth: 90 },
    { key:'tags', label:'Tags', width: 220, minWidth: 130 },
    { key:'qualite', label:'Qualité', width: 140, minWidth: 100 },
    { key:'taille', label:'Taille', align:'right', width: 120, minWidth: 90 },
    { key:'date', label:'Date', width: 130, minWidth: 100 }
  ];
  const thead = document.createElement('thead');
  const hrow  = document.createElement('tr');
  cols.forEach(col => {
    const th = document.createElement('th');
    th.textContent = col.label;
    if (col.align) th.style.textAlign = col.align;
    if (col.key) {
      th.style.cursor = 'pointer';
      if (state.sortCol === col.key) th.textContent += state.sortOrder === 'asc' ? ' ▲' : ' ▼';
      th.addEventListener('click', () => {
        if (state.sortCol === col.key) state.sortOrder = state.sortOrder === 'asc' ? 'desc' : 'asc';
        else { state.sortCol = col.key; state.sortOrder = 'asc'; }
        render();
      });
    }
    hrow.appendChild(th);
  });
  thead.appendChild(hrow); table.appendChild(thead);
  const tbody = document.createElement('tbody');
  data.forEach(f => {
    const tr = document.createElement('tr');
    const isPriv = f._prive && !state.privateUnlocked;
    const ep = (f.saison && f.episode) ? `S${String(f.saison).padStart(2,'0')}E${String(f.episode).padStart(3,'0')}` : '';
    const tagsHtml = f.tags_manuels ? f.tags_manuels.split(',').filter(t=>t.trim()).map(t=>`<span class="tag-manuel-pill-sm">${t.trim()}</span>`).join('') : '<span class="no-tag">—</span>';
    tr.innerHTML = `
      <td><div class="file-name ${isPriv?'file-private':''}">${f.favori?'⭐ ':''}${isPriv?'🔒 ':''}${f.nom}</div></td>
      <td><span class="type-badge type-${f.type}">${f.type}</span></td>
      <td>${f.serie?`<div class="file-serie">${f.serie}</div>`:''}${ep?`<span class="ep-badge">${ep}</span>`:''}</td>
      <td><span class="disk-tag">${f.disque}:</span></td>
      <td><div class="tags-cell">${tagsHtml}</div></td>
      <td>${f.qualite?`<span class="qualite-badge q-${f.qualite.replace(/\s/g,'')}">${f.qualite}</span>`:'<span class="no-tag">—</span>'}</td>
      <td class="size-cell">${fmt(f.taille_mb)}</td>
      <td class="date-cell">${(f.date_scan||'').substring(0,10)}</td>`;
    tr.style.cursor = isPriv ? 'default' : 'pointer';
    if (!isPriv) {
      tr.addEventListener('click', () => { document.querySelectorAll('.file-table tbody tr.selected').forEach(r=>r.classList.remove('selected')); tr.classList.add('selected'); openDetail(f); });
      tr.addEventListener('dblclick', () => ouvrirFichier(f.chemin));
    }
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  const wrap = document.createElement('div'); wrap.className = 'table-wrap'; wrap.appendChild(table);
  attachResizableColumns(table, cols, 'files-main');
  content.innerHTML = ''; content.appendChild(wrap);
}

async function renderSeries(content) {
  const data = await api('/series?q=' + encodeURIComponent(state.search));
  if (!data) { content.innerHTML = '<div class="empty">Erreur.</div>'; return; }
  $('result-count').textContent = `${data.length} série(s)`;
  if (data.length === 0) { content.innerHTML = '<div class="empty">Aucune série détectée.</div>'; return; }
  if (state.seriesView === 'grid') renderSeriesGrid(data, content);
  else renderSeriesAccordion(data, content);
}

function renderSeriesGrid(data, content) {
  const wrap = document.createElement('div'); wrap.className = 'series-grid-view';
  data.forEach(s => {
    const card = document.createElement('div'); card.className = 'serie-grid-card';
    const seasons = s.saison_min === s.saison_max ? `S${s.saison_min}` : `S${s.saison_min}–S${s.saison_max}`;
    card.innerHTML = `
      <div class="serie-grid-top">
        <div class="serie-grid-name">${s.serie}</div>
        <button class="serie-open-folders-btn" type="button" data-serie="${escapeHtml(s.serie)}" title="Ouvrir les dossiers de la série">📂</button>
      </div>
      <div class="serie-grid-meta"><span class="serie-tag accent">${s.nb} ép.</span><span class="serie-tag">${seasons}</span><span class="serie-tag">${s.disques}</span></div>`;
    card.addEventListener('click', () => openSeriePanel(s.serie));
    card.querySelector('.serie-open-folders-btn')?.addEventListener('click', async e => {
      e.stopPropagation();
      await handleOpenSerieFolders(s.serie, e.currentTarget);
    });
    wrap.appendChild(card);
  });
  content.innerHTML = ''; content.appendChild(wrap);
}

function renderSeriesAccordion(data, content) {
  const wrap = document.createElement('div'); wrap.className = 'series-list';
  data.forEach(s => {
    const card = document.createElement('div'); card.className = 'serie-accordion';
    const seasons = s.saison_min === s.saison_max ? `S${s.saison_min}` : `S${s.saison_min}–S${s.saison_max}`;
    card.innerHTML = `
      <div class="serie-accordion-header" data-serie="${s.serie}">
        <div class="serie-accordion-left"><span class="serie-accordion-arrow">▶</span><span class="serie-accordion-name">${s.serie}</span></div>
        <div class="serie-accordion-right"><span class="serie-accordion-meta">${s.nb} ép. · ${seasons}</span><span class="serie-accordion-disks">${s.disques}</span><button class="serie-open-folders-btn" type="button" data-serie="${escapeHtml(s.serie)}" title="Ouvrir les dossiers de la série">📂</button></div>
      </div>
      <div class="serie-accordion-body" style="display:none"></div>`;
    wrap.appendChild(card);
    card.querySelector('.serie-accordion-header').addEventListener('click', async () => {
      const body = card.querySelector('.serie-accordion-body');
      const arrow = card.querySelector('.serie-accordion-arrow');
      if (body.style.display !== 'none') { body.style.display = 'none'; arrow.textContent = '▶'; }
      else { body.style.display = 'block'; arrow.textContent = '▼'; body.innerHTML = '<div class="serie-accordion-loading">Chargement…</div>'; await loadSerieDetail(s.serie, body); }
    });
    card.querySelector('.serie-open-folders-btn')?.addEventListener('click', async e => {
      e.stopPropagation();
      await handleOpenSerieFolders(s.serie, e.currentTarget);
    });
  });
  content.innerHTML = ''; content.appendChild(wrap);
}

async function loadSerieDetail(serieName, bodyEl) {
  const data = await api('/series/' + encodeURIComponent(serieName) + '/detail');
  if (!data) { bodyEl.innerHTML = '<div class="serie-accordion-loading">Erreur.</div>'; return; }
  let html = '';
  for (const saison of data.saisons) {
    const { count, total_ep: total = 0, source } = saison;
    const hasTotal = total > 0;
    const pct = hasTotal ? Math.round((count/total)*100) : null;
    const maxEp = hasTotal ? total : (Math.max(...saison.episodes.map(e=>e.episode), 0) || count);
    html += `<div class="saison-block"><div class="saison-header">
      <div class="saison-header-left">
        <span class="saison-label">Saison ${saison.saison}</span>
        <span class="saison-count ${hasTotal?(count===total?'complete':'partial'):''}">${count}${hasTotal?' / '+total:''} ép.</span>
        ${hasTotal&&pct!==null?`<div class="saison-progress-bar"><div class="saison-progress-fill ${pct===100?'complete':pct>=50?'partial':'low'}" style="width:${pct}%"></div></div>`:''}
        ${source?`<span class="saison-source">${source==='tmdb'?'● TMDB':'✎ Manuel'}</span>`:''}
      </div>
      <div class="saison-header-right">
        <button class="saison-edit-btn" data-serie="${serieName}" data-saison="${saison.saison}" data-total="${total}">✎</button>
        <button class="saison-tmdb-btn" data-serie="${serieName}" data-saison="${saison.saison}">⟳ TMDB</button>
      </div>
    </div><div class="episode-grid">`;
    for (let i = 1; i <= maxEp; i++) {
      const ep = saison.episodes.find(e => e.episode === i);
      if (ep) html += `<div class="ep-cell present${ep.vu?' vu':''}" data-chemin="${ep.chemin}" data-vu="${ep.vu||0}" title="${ep.nom}\n${ep.disque}: ${fmt(ep.taille_mb)}">${i}${ep.qualite?`<span class="ep-qualite">${ep.qualite}</span>`:''}</div>`;
      else    html += `<div class="ep-cell missing" title="Épisode ${i} manquant">${i}</div>`;
    }
    html += `</div></div>`;
  }
  bodyEl.innerHTML = html;
  bodyEl.querySelectorAll('.ep-cell.present').forEach(cell => {
    cell.addEventListener('click', async e => { e.stopPropagation(); const vu = parseInt(cell.dataset.vu)===1?0:1; await api('/vu',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chemin:cell.dataset.chemin,vu})}); cell.dataset.vu=vu; cell.classList.toggle('vu',vu===1); });
    cell.addEventListener('dblclick', e => { e.stopPropagation(); ouvrirFichier(cell.dataset.chemin); });
  });
  bodyEl.querySelectorAll('.saison-edit-btn').forEach(btn => {
    btn.addEventListener('click', async e => { e.stopPropagation(); const input=prompt(`${btn.dataset.serie} — Saison ${btn.dataset.saison}\nTotal épisodes (actuel: ${btn.dataset.total||'non défini'}) :`); if(!input||isNaN(parseInt(input)))return; const r=await api('/series-meta',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({serie:btn.dataset.serie,saison:parseInt(btn.dataset.saison),total_ep:parseInt(input)})}); if(r?.ok){setStatus('Mise à jour');await loadSerieDetail(btn.dataset.serie,bodyEl);} });
  });
  bodyEl.querySelectorAll('.saison-tmdb-btn').forEach(btn => {
    btn.addEventListener('click', async e => { e.stopPropagation(); btn.textContent='…';btn.disabled=true; const r=await api('/tmdb-fetch',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({serie:btn.dataset.serie,saison:parseInt(btn.dataset.saison)})}); btn.disabled=false;btn.textContent='⟳ TMDB'; if(r?.ok){setStatus(`TMDB : ${r.total} épisodes`);await loadSerieDetail(btn.dataset.serie,bodyEl);}else setStatus(r?.error||'Clé TMDB non configurée'); });
  });
}


async function buildMissingDataset(raw) {
  const ignoredSeasons = missingPrefs.ignoredSeasons();
  const ignoredEpisodes = missingPrefs.ignoredEpisodes();
  const collator = new Intl.Collator('fr', { sensitivity:'base', numeric:true });
  const snapshot = missingPrefs.snapshot();

  const detailEntries = await Promise.all(raw.map(async item => {
    const detail = await api('/series/' + encodeURIComponent(item.serie) + '/detail');
    const saisonDetail = detail?.saisons?.find(s => Number(s.saison) === Number(item.saison)) || null;
    const key = slugMissingKey(item.serie, item.saison);
    const ignoredSeason = !!ignoredSeasons[key];
    const ignoredEpList = (ignoredEpisodes[key] || []).map(Number);
    const hidden = item.manquants.filter(ep => ignoredEpList.includes(Number(ep)));
    const visibleMissing = item.manquants.filter(ep => !ignoredEpList.includes(Number(ep)));
    const presentCount = saisonDetail?.count || 0;
    const total = saisonDetail?.total_ep || (presentCount + item.count);
    const progress = total > 0 ? Math.round((presentCount / total) * 100) : 0;
    const nextMissing = visibleMissing[0] || item.manquants[0] || null;
    const priorityScore = visibleMissing.length > 0 ? visibleMissing.length : item.count;
    const latestPresentEp = saisonDetail?.episodes?.length ? Math.max(...saisonDetail.episodes.map(e => Number(e.episode) || 0)) : 0;
    const allEpisodes = saisonDetail?.episodes || [];
    const dupMap = {};
    allEpisodes.forEach(ep => { dupMap[ep.episode] = (dupMap[ep.episode] || 0) + 1; });
    const duplicateEpisodes = Object.entries(dupMap).filter(([, count]) => count > 1).map(([ep]) => Number(ep));
    return {
      ...item,
      key,
      detail: saisonDetail,
      presentCount,
      total,
      progress,
      nextMissing,
      latestPresentEp,
      visibleMissing,
      hiddenMissing: hidden,
      ignoredSeason,
      duplicateEpisodes,
      completedPct: progress,
      snapshotPrev: snapshot[key] || null,
      priorityScore,
    };
  }));

  const filtered = detailEntries.filter(item => item.visibleMissing.length > 0 || (state.missingShowIgnored && (item.hiddenMissing.length > 0 || item.ignoredSeason)));

  const q = normalizeSerieText((state.search || '') + ' ' + (state.missingSearch || '')).trim();
  let data = filtered.filter(item => {
    if (!q) return true;
    const hay = normalizeSerieText(`${item.serie} saison ${item.saison} ${item.visibleMissing.join(' ')} ${item.hiddenMissing.join(' ')}`);
    return hay.includes(q);
  });

  if (!state.missingShowIgnored) data = data.filter(item => !item.ignoredSeason);
  if (state.missingShowPriorityOnly) data = data.filter(item => item.visibleMissing.length > 0 && item.visibleMissing.length <= 3);

  const getValue = (item) => {
    switch (state.missingSort) {
      case 'alpha': return item.serie;
      case 'count': return item.visibleMissing.length || item.count;
      case 'next': return item.nextMissing || 9999;
      case 'progress': return item.completedPct;
      case 'recent': return item.snapshotPrev?.updated_at || '';
      case 'priority':
      default: return item.visibleMissing.length || item.count;
    }
  };
  const order = state.missingOrder === 'desc' ? -1 : 1;
  data.sort((a, b) => {
    let cmp = 0;
    if (['count','next','progress','priority'].includes(state.missingSort)) cmp = (Number(getValue(a)) || 0) - (Number(getValue(b)) || 0);
    else cmp = collator.compare(String(getValue(a) || ''), String(getValue(b) || ''));
    if (cmp === 0) cmp = collator.compare(a.serie, b.serie) || (Number(a.saison) - Number(b.saison));
    return cmp * order;
  });
  return data;
}

async function computeMissingInsights(data) {
  const totalSeries = data.length;
  const totalMissing = data.reduce((sum, item) => sum + item.visibleMissing.length, 0);
  const priority = [...data].filter(i => i.visibleMissing.length > 0).sort((a,b) => (a.visibleMissing.length - b.visibleMissing.length) || (b.completedPct - a.completedPct) || a.serie.localeCompare(b.serie, 'fr'));
  const nearest = priority[0] || null;
  const mostIncomplete = [...data].sort((a,b) => (b.visibleMissing.length - a.visibleMissing.length) || (a.completedPct - b.completedPct))[0] || null;
  const activity = missingPrefs.activity();
  const changes = buildMissingChanges(data);
  return { totalSeries, totalMissing, nearest, mostIncomplete, changes, activity, priority: priority.slice(0, 5) };
}

function buildMissingChanges(data) {
  const oldSnap = missingPrefs.snapshot();
  const newSnap = {};
  const changes = [];
  data.forEach(item => {
    const prev = oldSnap[item.key] || { missing: [] };
    const currentMissing = [...item.visibleMissing];
    newSnap[item.key] = {
      serie: item.serie,
      saison: item.saison,
      missing: currentMissing,
      total: item.total,
      progress: item.completedPct,
      updated_at: tsNowIso(),
    };
    const added = currentMissing.filter(ep => !(prev.missing || []).includes(ep));
    const resolved = (prev.missing || []).filter(ep => !currentMissing.includes(ep));
    if (added.length) changes.push({ type:'added', serie:item.serie, saison:item.saison, episodes:added });
    if (resolved.length) changes.push({ type:'resolved', serie:item.serie, saison:item.saison, episodes:resolved });
  });
  Object.keys(oldSnap).forEach(key => {
    if (!newSnap[key]) {
      const prev = oldSnap[key];
      changes.push({ type:'closed', serie:prev.serie, saison:prev.saison, episodes:prev.missing || [] });
    }
  });
  writeStore('mi-missing-snapshot', newSnap);
  return changes.slice(0, 10);
}

async function computeRenameSuggestion(item) {
  const serieTokens = tokenizeSerieName(item.serie);
  if (!serieTokens.length) return null;
  const all = await api('/files?q=' + encodeURIComponent(item.serie) + '&type=Tous&disk=Tous&sort=nom&order=asc&unlocked=' + (state.privateUnlocked ? 1 : 0));
  if (!Array.isArray(all)) return null;
  const suspects = all.filter(f => {
    if (f.type !== 'Vidéo') return false;
    const nom = normalizeSerieText(f.nom);
    const hasTokens = serieTokens.every(t => nom.includes(t));
    if (!hasTokens) return false;
    const linkedToSeason = String(f.serie || '').trim() === String(item.serie).trim() && Number(f.saison) === Number(item.saison);
    return !linkedToSeason;
  }).slice(0, 5);
  if (!suspects.length && !item.duplicateEpisodes.length) return null;
  const parts = [];
  if (suspects.length) parts.push(`${suspects.length} fichier(s) vidéo semblent proches de cette série sans être rattachés à S${item.saison}.`);
  if (item.duplicateEpisodes.length) parts.push(`Doublons détectés sur les épisodes : ${item.duplicateEpisodes.join(', ')}.`);
  return {
    text: parts.join(' '),
    suspects,
  };
}

function formatMissingExportRows(data) {
  return data.map(item => ({
    serie: item.serie,
    saison: item.saison,
    presents: item.presentCount,
    total: item.total,
    progress: item.completedPct,
    next: item.nextMissing || '',
    missing: item.visibleMissing.join(', '),
  }));
}

function exportMissingTxt(data) {
  const lines = formatMissingExportRows(data).map(r => `${r.serie} S${String(r.saison).padStart(2, '0')} · ${r.presents}/${r.total} · prochain E${String(r.next || '').padStart(2,'0')} · manquants: ${r.missing}`);
  downloadTextFile('media-indexer-manquants.txt', lines.join('\n'));
}

function exportMissingCsv(data) {
  const rows = formatMissingExportRows(data);
  const header = ['Serie','Saison','Presents','Total','Progression','ProchainEpisode','Manquants'];
  const body = rows.map(r => [r.serie, r.saison, r.presents, r.total, r.progress, r.next, r.missing].map(v => `"${String(v).replace(/"/g, '""')}"`).join(';'));
  downloadTextFile('media-indexer-manquants.csv', [header.join(';'), ...body].join('\n'), 'text/csv;charset=utf-8');
}

function toggleIgnoredSeason(item) {
  const map = missingPrefs.ignoredSeasons();
  if (map[item.key]) delete map[item.key];
  else map[item.key] = true;
  writeStore('mi-missing-ignored-seasons', map);
  saveMissingActivity({ type: map[item.key] ? 'ignore-season' : 'restore-season', serie:item.serie, saison:item.saison, episodes:[] });
  render();
}

function toggleIgnoredEpisode(item, episode) {
  const map = missingPrefs.ignoredEpisodes();
  const current = new Set((map[item.key] || []).map(Number));
  if (current.has(Number(episode))) current.delete(Number(episode));
  else current.add(Number(episode));
  map[item.key] = [...current].sort((a,b) => a-b);
  if (!map[item.key].length) delete map[item.key];
  writeStore('mi-missing-ignored-episodes', map);
  saveMissingActivity({ type: current.has(Number(episode)) ? 'ignore-episode' : 'restore-episode', serie:item.serie, saison:item.saison, episodes:[episode] });
  render();
}

function resetIgnoredMissing() {
  localStorage.removeItem('mi-missing-ignored-seasons');
  localStorage.removeItem('mi-missing-ignored-episodes');
  saveMissingActivity({ type:'reset-ignored', serie:'Toutes les séries', saison:'—', episodes:[] });
  render();
}

function renderMissingSummary(insights) {
  const nearest = insights.nearest;
  const worst = insights.mostIncomplete;
  return `
    <div class="missing-summary-grid">
      <div class="missing-summary-card"><div class="missing-summary-label">Séries incomplètes</div><div class="missing-summary-value">${insights.totalSeries}</div><div class="missing-summary-sub">saisons encore ouvertes</div></div>
      <div class="missing-summary-card"><div class="missing-summary-label">Épisodes manquants</div><div class="missing-summary-value">${insights.totalMissing}</div><div class="missing-summary-sub">sur la vue actuelle</div></div>
      <div class="missing-summary-card"><div class="missing-summary-label">À compléter en priorité</div><div class="missing-summary-value small">${nearest ? escapeHtml(nearest.serie) + ' · S' + nearest.saison : '—'}</div><div class="missing-summary-sub">${nearest ? nearest.visibleMissing.length + ' épisode(s) manquant(s)' : 'Aucune priorité'}</div></div>
      <div class="missing-summary-card"><div class="missing-summary-label">La plus incomplète</div><div class="missing-summary-value small">${worst ? escapeHtml(worst.serie) + ' · S' + worst.saison : '—'}</div><div class="missing-summary-sub">${worst ? worst.visibleMissing.length + ' épisode(s)' : '—'}</div></div>
    </div>`;
}

function renderMissingPriority(insights) {
  if (!insights.priority.length) return '';
  return `
    <div class="missing-section">
      <div class="missing-section-title">À compléter en priorité</div>
      <div class="missing-priority-list">${insights.priority.map(item => `
        <button class="missing-priority-chip" data-missing-focus="${escapeHtml(item.key)}" type="button">
          <span>${escapeHtml(item.serie)} · S${item.saison}</span>
          <strong>${item.visibleMissing.length} manquant(s)</strong>
        </button>`).join('')}
      </div>
    </div>`;
}

function renderMissingChanges(insights) {
  const recent = [...insights.changes, ...insights.activity].slice(0, 8);
  if (!recent.length) return '';
  const describe = item => {
    if (item.type === 'added') return `Nouveaux manquants détectés : ${escapeHtml(item.serie)} S${item.saison} → ${item.episodes.join(', ')}`;
    if (item.type === 'resolved') return `Complétés depuis la dernière vue : ${escapeHtml(item.serie)} S${item.saison} → ${item.episodes.join(', ')}`;
    if (item.type === 'closed') return `Saison complétée : ${escapeHtml(item.serie)} S${item.saison}`;
    if (item.type === 'ignore-season') return `Saison masquée : ${escapeHtml(item.serie)} S${item.saison}`;
    if (item.type === 'restore-season') return `Saison réaffichée : ${escapeHtml(item.serie)} S${item.saison}`;
    if (item.type === 'ignore-episode') return `Épisode masqué : ${escapeHtml(item.serie)} S${item.saison} · ${item.episodes.join(', ')}`;
    if (item.type === 'restore-episode') return `Épisode réaffiché : ${escapeHtml(item.serie)} S${item.saison} · ${item.episodes.join(', ')}`;
    if (item.type === 'reset-ignored') return `Réinitialisation des éléments masqués`;
    return `${escapeHtml(item.serie)} S${item.saison}`;
  };
  return `
    <div class="missing-section">
      <div class="missing-section-title">Activité récente</div>
      <div class="missing-activity-list">${recent.map(item => `<div class="missing-activity-item"><span>${describe(item)}</span><small>${humanDateTime(item.at || tsNowIso())}</small></div>`).join('')}</div>
    </div>`;
}

function renderMissingControls() {
  return `
    <div class="missing-toolbar">
      <div class="missing-search-wrap"><input class="missing-search-input" id="missing-search" placeholder="Filtrer par série, saison ou épisode" value="${escapeHtml(state.missingSearch)}"></div>
      <select class="missing-select" id="missing-sort">
        <option value="priority" ${state.missingSort==='priority'?'selected':''}>Priorité</option>
        <option value="count" ${state.missingSort==='count'?'selected':''}>Nb manquants</option>
        <option value="next" ${state.missingSort==='next'?'selected':''}>Prochain épisode</option>
        <option value="progress" ${state.missingSort==='progress'?'selected':''}>Progression</option>
        <option value="serie" ${state.missingSort==='serie'?'selected':''}>Alphabétique</option>
        <option value="updated" ${state.missingSort==='updated'?'selected':''}>Dernière activité</option>
      </select>
      <button class="missing-btn secondary" id="missing-order">${state.missingOrder === 'asc' ? 'Croissant' : 'Décroissant'}</button>
      <div class="missing-view-switch" role="tablist" aria-label="Vue onglet manquants">
        <button class="missing-view-btn ${state.missingView === 'detailed' ? 'active' : ''}" id="missing-view-detailed" type="button">Détaillée</button>
        <button class="missing-view-btn ${state.missingView === 'simple' ? 'active' : ''}" id="missing-view-simple" type="button">Simple</button>
      </div>
      <label class="missing-toggle"><input type="checkbox" id="missing-priority-only" ${state.missingShowPriorityOnly ? 'checked' : ''}> Priorité seulement</label>
      <label class="missing-toggle"><input type="checkbox" id="missing-show-ignored" ${state.missingShowIgnored ? 'checked' : ''}> Afficher masqués</label>
      <button class="missing-btn secondary" id="missing-export-txt">TXT</button>
      <button class="missing-btn secondary" id="missing-export-csv">CSV</button>
      <button class="missing-btn ghost" id="missing-reset-ignored">Réinitialiser masqués</button>
    </div>`;
}

function renderMissingCard(item, suggestion) {
  const missingCells = item.visibleMissing.map(ep => `<button class="ep-cell missing actionable" data-missing-episode="${ep}" data-missing-key="${escapeHtml(item.key)}" type="button" title="Masquer l'épisode ${ep}">${String(ep).padStart(2,'0')}</button>`).join('');
  const hiddenCells = item.hiddenMissing.map(ep => `<button class="ep-cell hidden-missing actionable" data-restore-episode="${ep}" data-missing-key="${escapeHtml(item.key)}" type="button" title="Réafficher l'épisode ${ep}">${String(ep).padStart(2,'0')}</button>`).join('');
  const suspectHtml = suggestion?.suspects?.length ? `<div class="missing-suspects">${suggestion.suspects.map(f => `<div class="missing-suspect-item">${escapeHtml(f.nom)}</div>`).join('')}</div>` : '';
  return `
    <div class="missing-card" data-missing-card="${escapeHtml(item.key)}">
      <div class="missing-card-header">
        <div>
          <div class="missing-card-title">${escapeHtml(item.serie)}</div>
          <div class="missing-card-sub">Saison ${item.saison} · ${item.presentCount} / ${item.total} épisodes · ${item.completedPct}%</div>
        </div>
        <div class="missing-card-metrics">
          <span class="missing-badge">${item.visibleMissing.length} manquant(s)</span>
          <span class="missing-badge soft">Prochain: E${String(item.nextMissing || '—').padStart(2,'0')}</span>
        </div>
      </div>
      <div class="missing-progress"><div class="missing-progress-fill" style="width:${Math.max(4, item.completedPct)}%"></div></div>
      <div class="missing-meta-grid">
        <div class="missing-meta-item"><span class="missing-meta-label">Dernier présent</span><strong>E${String(item.latestPresentEp || 0).padStart(2,'0')}</strong></div>
        <div class="missing-meta-item"><span class="missing-meta-label">Prochain attendu</span><strong>E${String(item.nextMissing || 0).padStart(2,'0')}</strong></div>
        <div class="missing-meta-item"><span class="missing-meta-label">Source</span><strong>${item.detail?.source === 'tmdb' ? 'TMDB' : item.detail?.source === 'manual' ? 'Manuel' : 'Locale'}</strong></div>
      </div>
      <div class="missing-actions">
        <button class="missing-btn secondary" data-copy-missing="${escapeHtml(item.key)}" type="button">Copier</button>
        <button class="missing-btn secondary" data-focus-serie="${escapeHtml(item.serie)}" type="button">Voir série</button>
        <button class="missing-btn ghost" data-toggle-season-ignore="${escapeHtml(item.key)}" type="button">${item.ignoredSeason ? 'Réafficher saison' : 'Masquer saison'}</button>
      </div>
      <div class="missing-episodes-block">
        <div class="missing-block-title">Épisodes manquants</div>
        <div class="episode-grid missing-grid">${missingCells || '<span class="empty-inline">Aucun épisode visible</span>'}</div>
      </div>
      ${item.hiddenMissing.length ? `<div class="missing-episodes-block"><div class="missing-block-title">Masqués</div><div class="episode-grid missing-grid hidden">${hiddenCells}</div></div>` : ''}
      <div class="missing-suggestion ${suggestion ? '' : 'empty'}">
        <div class="missing-block-title">Suggestion renommage / détection</div>
        <div>${suggestion ? escapeHtml(suggestion.text) : 'Aucune anomalie évidente détectée.'}</div>
        ${suspectHtml}
      </div>
    </div>`;
}


function renderMissingSimpleSection(data) {
  return `
    <div class="missing-section">
      <div class="missing-section-title">Vue simple</div>
      <div class="missing-simple-list">
        ${data.map(item => `
          <div class="missing-simple-row" data-missing-card="${escapeHtml(item.key)}">
            <div class="missing-simple-top">
              <div class="missing-simple-main">
                <div class="missing-simple-title">${escapeHtml(item.serie)} <span>Saison ${item.saison}</span></div>
                <div class="missing-simple-sub">Dernier présent E${String(item.latestPresentEp || 0).padStart(2,'0')} · source ${item.detail?.source === 'tmdb' ? 'TMDB' : item.detail?.source === 'manual' ? 'manuelle' : 'locale'}</div>
              </div>
              <div class="missing-simple-badge-wrap">
                <div class="missing-simple-badge">${item.visibleMissing.length}</div>
                <div class="missing-simple-badge-label">${item.visibleMissing.length > 1 ? 'épisodes manquants' : 'épisode manquant'}</div>
              </div>
            </div>

            <div class="missing-simple-stats">
              <span class="missing-simple-chip">Complété ${item.presentCount}/${item.total}</span>
              <span class="missing-simple-chip">${item.completedPct}%</span>
              <span class="missing-simple-chip">Prochain E${String(item.nextMissing || '—').padStart(2,'0')}</span>
            </div>

            <div class="missing-simple-episodes-wrap">
              <div class="missing-simple-episodes-label">Épisodes manquants</div>
              <div class="missing-simple-episodes">${item.visibleMissing.length ? item.visibleMissing.map(ep => `E${String(ep).padStart(2,'0')}`).join(' · ') : '—'}</div>
            </div>

            <div class="missing-simple-actions">
              <button class="missing-btn secondary small" data-copy-missing="${escapeHtml(item.key)}" type="button">Copier</button>
              <button class="missing-btn secondary small" data-focus-serie="${escapeHtml(item.serie)}" type="button">Voir série</button>
              <button class="missing-btn ghost small" data-toggle-season-ignore="${escapeHtml(item.key)}" type="button">${item.ignoredSeason ? 'Réafficher' : 'Masquer'}</button>
            </div>
          </div>
        `).join('')}
      </div>
    </div>`;
}

function bindMissingControls(data) {
  $('missing-search')?.addEventListener('input', e => { state.missingSearch = e.target.value; persistMissingUiState(); render(); });
  $('missing-sort')?.addEventListener('change', e => { state.missingSort = e.target.value; persistMissingUiState(); render(); });
  $('missing-order')?.addEventListener('click', () => { state.missingOrder = state.missingOrder === 'asc' ? 'desc' : 'asc'; persistMissingUiState(); render(); });
  $('missing-priority-only')?.addEventListener('change', e => { state.missingShowPriorityOnly = e.target.checked; persistMissingUiState(); render(); });
  $('missing-show-ignored')?.addEventListener('change', e => { state.missingShowIgnored = e.target.checked; persistMissingUiState(); render(); });
  $('missing-export-txt')?.addEventListener('click', () => exportMissingTxt(data));
  $('missing-export-csv')?.addEventListener('click', () => exportMissingCsv(data));
  $('missing-reset-ignored')?.addEventListener('click', resetIgnoredMissing);
  $('missing-view-detailed')?.addEventListener('click', () => { state.missingView = 'detailed'; persistMissingUiState(); render(); });
  $('missing-view-simple')?.addEventListener('click', () => { state.missingView = 'simple'; persistMissingUiState(); render(); });
  document.querySelectorAll('[data-missing-focus]').forEach(btn => btn.addEventListener('click', () => {
    const card = document.querySelector(`[data-missing-card="${btn.dataset.missingFocus}"]`);
    card?.scrollIntoView({ behavior:'smooth', block:'center' });
    card?.classList.add('pulse');
    setTimeout(() => card?.classList.remove('pulse'), 1200);
  }));
  data.forEach(item => {
    document.querySelectorAll(`[data-missing-key="${CSS.escape(item.key)}"]`).forEach(btn => {
      if (btn.dataset.missingEpisode) btn.addEventListener('click', () => toggleIgnoredEpisode(item, Number(btn.dataset.missingEpisode)));
      if (btn.dataset.restoreEpisode) btn.addEventListener('click', () => toggleIgnoredEpisode(item, Number(btn.dataset.restoreEpisode)));
    });
    document.querySelector(`[data-toggle-season-ignore="${CSS.escape(item.key)}"]`)?.addEventListener('click', () => toggleIgnoredSeason(item));
    document.querySelector(`[data-copy-missing="${CSS.escape(item.key)}"]`)?.addEventListener('click', async () => {
      const text = `${item.serie} S${String(item.saison).padStart(2,'0')} · ${item.presentCount}/${item.total} · manquants: ${item.visibleMissing.join(', ')}`;
      try { await navigator.clipboard.writeText(text); setStatus('Liste copiée'); } catch(e) { setStatus('Copie impossible'); }
    });
    document.querySelector(`[data-focus-serie="${CSS.escape(item.serie)}"]`)?.addEventListener('click', () => openSeriePanel(item.serie));
  });
}

async function renderStats(content) {
  const data = await api('/stats');
  if (!data) { content.innerHTML = '<div class="empty">Erreur.</div>'; return; }
  const total = data.par_type.reduce((s,t) => s+t.count, 0);
  $('result-count').textContent = 'Stats';
  let html = `<div class="stats-layout"><div class="section-title">Vue d'ensemble</div><div class="stats-grid">
    <div class="stat-card"><div class="stat-label">Total</div><div class="stat-value">${total.toLocaleString()}</div><div class="stat-sub">fichiers</div></div>
    <div class="stat-card"><div class="stat-label" style="color:#facc15">Favoris</div><div class="stat-value" style="color:#facc15">${(data.nb_favoris||0).toLocaleString()}</div><div class="stat-sub">fichiers favoris</div></div>`;
  const colors = {'PDF':'#f38ba8','Image':'#a6e3a1','Vidéo':'#fab387','Musique':'#89b4fa','Autre':'#cba6f7'};
  data.par_type.forEach(t => { html += `<div class="stat-card"><div class="stat-label" style="color:${colors[t.type]||'#888'}">${t.type}</div><div class="stat-value" style="color:${colors[t.type]||'var(--text)'}">${t.count.toLocaleString()}</div><div class="stat-sub">${fmt(t.size_mb)}</div></div>`; });
  html += `</div><div class="section-title" style="margin-top:24px">Par disque</div>`;
  const maxC = Math.max(...data.par_disk.map(d=>d.count), 1);
  data.par_disk.forEach(d => { const pct=Math.round((d.count/maxC)*100); html+=`<div class="disk-bar-row"><span class="disk-bar-label">${d.disque}:</span><div class="disk-bar-track"><div class="disk-bar-fill" style="width:${pct}%"></div></div><span class="disk-bar-count">${d.count.toLocaleString()}</span></div>`; });
  html += `</div>`; content.innerHTML = html;
}

async function renderDuplicates(content) {
  const data = await api('/duplicates');
  if (!data) { content.innerHTML = '<div class="empty">Erreur.</div>'; return; }
  $('result-count').textContent = `${data.length} doublon(s)`;
  if (data.length === 0) { content.innerHTML = '<div class="empty">Aucun doublon.</div>'; return; }
  const total = data.reduce((s,d) => s+(d.taille_unit*(d.count-1)), 0);
  let html = `<div class="table-wrap"><div class="dupes-header"><span class="dupes-info">Économie potentielle : <strong>${fmt(total)}</strong></span></div><table class="file-table"><thead><tr><th>Fichier</th><th>Type</th><th>Copies</th><th>Disques</th><th style="text-align:right">Taille/copie</th><th style="text-align:right">Gaspillé</th></tr></thead><tbody>`;
  data.forEach(d => { html+=`<tr><td><div class="file-name">${d.nom}</div></td><td><span class="type-badge type-${d.type}">${d.type}</span></td><td><span class="dupe-count">${d.count}×</span></td><td><span class="disk-tag">${d.disques}</span></td><td class="size-cell">${fmt(d.taille_unit)}</td><td class="size-cell" style="color:var(--danger)">${fmt(d.taille_unit*(d.count-1))}</td></tr>`; });
  html += `</tbody></table></div>`; content.innerHTML = html;
}


async function renderMissing(content) {
  const raw = await api('/missing-episodes');
  if (!raw) { content.innerHTML = '<div class="empty">Erreur.</div>'; return; }

  const data = await buildMissingDataset(raw);
  const insights = await computeMissingInsights(data);
  $('result-count').textContent = `${insights.totalSeries} série(s) incomplète(s) · ${insights.totalMissing} épisode(s)`;

  if (data.length === 0) {
    content.innerHTML = `
      <div class="missing-layout">
        ${renderMissingControls()}
        <div class="empty">Aucun épisode manquant pour les filtres actuels.</div>
      </div>`;
    bindMissingControls(data);
    return;
  }

  const suggestions = state.missingView === 'detailed'
    ? await Promise.all(data.map(item => computeRenameSuggestion(item)))
    : [];

  const bodyHtml = state.missingView === 'simple'
    ? renderMissingSimpleSection(data)
    : `
      ${renderMissingPriority(insights)}
      ${renderMissingChanges(insights)}
      <div class="missing-section">
        <div class="missing-section-title">Saisons incomplètes</div>
        <div class="missing-card-list">
          ${data.map((item, idx) => renderMissingCard(item, suggestions[idx])).join('')}
        </div>
      </div>`;

  content.innerHTML = `
    <div class="missing-layout">
      ${renderMissingControls()}
      ${renderMissingSummary(insights)}
      ${bodyHtml}
    </div>`;

  bindMissingControls(data);
}

async function renderPrivate(content) {
  if (!state.privateUnlocked) {
    content.innerHTML = `<div class="private-locked"><div class="private-lock-icon">🔒</div><div class="private-lock-title">Espace Privé</div><div class="private-lock-sub">Entrez votre PIN pour accéder</div><button class="private-unlock-btn" id="btn-private-unlock">Déverrouiller</button></div>`;
    $('btn-private-unlock')?.addEventListener('click', () => openPinModal('unlock'));
    return;
  }
  const data = await api('/files/private?unlocked=1');
  if (!data) { content.innerHTML = '<div class="empty">Erreur.</div>'; return; }
  $('result-count').textContent = `${data.length} fichier(s) privé(s)`;
  const timerHtml = `<div class="private-timer">🔓 Déverrouillé${state.privateTimeout>0?' · '+state.privateTimeout+' min':' · sans limite'} <button class="private-lock-now" id="btn-lock-now">Verrouiller</button></div>`;
  if (data.length === 0) { content.innerHTML = timerHtml + '<div class="empty">Aucun fichier privé.</div>'; $('btn-lock-now')?.addEventListener('click', lockPrivate); return; }
  const table = buildFileTableEl(data);
  const wrap = document.createElement('div'); wrap.className = 'table-wrap';
  const td = document.createElement('div'); td.innerHTML = timerHtml;
  wrap.appendChild(td); wrap.appendChild(table);
  content.innerHTML = ''; content.appendChild(wrap);
  $('btn-lock-now')?.addEventListener('click', lockPrivate);
}

function buildFileTableEl(data) {
  const table = document.createElement('table'); table.className = 'file-table';
  table.innerHTML = `<thead><tr><th>Fichier</th><th>Type</th><th>Disque</th><th>Qualité</th><th style="text-align:right">Taille</th><th>Date</th></tr></thead>`;
  const cols = [
    { key:'nom', label:'Fichier', width: 420, minWidth: 220 },
    { key:'type', label:'Type', width: 120, minWidth: 90 },
    { key:'disque', label:'Disque', width: 110, minWidth: 90 },
    { key:'qualite', label:'Qualité', width: 140, minWidth: 100 },
    { key:'taille', label:'Taille', width: 120, minWidth: 90 },
    { key:'date', label:'Date', width: 130, minWidth: 100 }
  ];
  const tbody = document.createElement('tbody');
  data.forEach(f => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td><div class="file-name" title="${escapeHtml(f.nom || '')}">${f.nom}</div></td><td><span class="type-badge type-${f.type}">${f.type}</span></td><td><span class="disk-tag">${f.disque}:</span></td><td>${f.qualite?`<span class="qualite-badge q-${f.qualite}">${f.qualite}</span>`:'—'}</td><td class="size-cell">${fmt(f.taille_mb)}</td><td class="date-cell">${(f.date_scan||'').substring(0,10)}</td>`;
    tr.style.cursor = 'pointer';
    tr.addEventListener('click', () => openDetail(f));
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  attachResizableColumns(table, cols, 'files-private');
  return table;
}

async function renderCorrupted(content) {
  setStatus('Analyse…', true);
  const data = await api('/corrupted');
  setStatus('Prêt');
  if (!data) { content.innerHTML = '<div class="empty">Erreur.</div>'; return; }
  $('result-count').textContent = `${data.length} fichier(s) problématique(s)`;
  if (data.length === 0) { content.innerHTML = '<div class="empty">✓ Aucun fichier corrompu ou manquant.</div>'; return; }
  let html = `<div class="table-wrap"><div class="dupes-header"><span class="dupes-info"><strong style="color:var(--danger)">${data.length}</strong> fichier(s) à vérifier</span></div><table class="file-table"><thead><tr><th>Fichier</th><th>Type</th><th>Disque</th><th>Problème</th><th style="text-align:right">Taille</th><th></th></tr></thead><tbody>`;
  data.forEach(f => { html+=`<tr><td><div class="file-name" title="${f.chemin}">${f.nom}</div></td><td><span class="type-badge type-${f.type}">${f.type}</span></td><td><span class="disk-tag">${f.disque}:</span></td><td><span class="corrupted-reason">${f.raison}</span></td><td class="size-cell">${fmt(f.taille_mb)}</td><td><button class="corrupted-remove-btn" data-id="${f.id}">✕ Retirer</button></td></tr>`; });
  html += `</tbody></table></div>`; content.innerHTML = html;
  content.querySelectorAll('.corrupted-remove-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Retirer ce fichier de la base ?')) return;
      await api(`/corrupted/${btn.dataset.id}`, { method: 'DELETE' });
      await renderCorrupted(content); await updateCounts();
    });
  });
}

async function renderCompare(content) {
  $('result-count').textContent = 'Comparateur';
  content.innerHTML = `
    <div class="compare-wrap">
      <div class="compare-inputs">
        <div class="compare-input-group"><label class="compare-label">Dossier A</label><div class="compare-field-row"><input type="text" class="compare-input" id="compare-a" placeholder="Ex: E:\\Films\\Action"/><button class="compare-browse-btn" id="browse-a">Parcourir</button></div></div>
        <div class="compare-vs">⇄</div>
        <div class="compare-input-group"><label class="compare-label">Dossier B</label><div class="compare-field-row"><input type="text" class="compare-input" id="compare-b" placeholder="Ex: F:\\Backup"/><button class="compare-browse-btn" id="browse-b">Parcourir</button></div></div>
      </div>
      <button class="compare-run-btn" id="compare-run">Comparer les dossiers</button>
      <div id="compare-result"></div>
    </div>`;
  $('browse-a')?.addEventListener('click', async () => { const f=await pickFolder('Dossier A'); if(f)$('compare-a').value=f; });
  $('browse-b')?.addEventListener('click', async () => { const f=await pickFolder('Dossier B'); if(f)$('compare-b').value=f; });
  $('compare-run')?.addEventListener('click', async () => {
    const a=$('compare-a').value.trim(), b=$('compare-b').value.trim();
    if(!a||!b){alert('Renseigne les deux dossiers.');return;}
    $('compare-run').textContent='Comparaison…';$('compare-run').disabled=true;
    setStatus('Comparaison…',true);
    const r=await api('/compare-folders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dossier_a:a,dossier_b:b})});
    $('compare-run').disabled=false;$('compare-run').textContent='Comparer les dossiers';setStatus('Prêt');
    if(!r){$('compare-result').innerHTML='<div class="empty">Erreur.</div>';return;}
    $('compare-result').innerHTML=`
      <div class="compare-summary">
        <div class="compare-stat-card"><div class="compare-stat-val">${r.total_a}</div><div class="compare-stat-label">Fichiers dans A</div></div>
        <div class="compare-stat-card"><div class="compare-stat-val">${r.total_b}</div><div class="compare-stat-label">Fichiers dans B</div></div>
        <div class="compare-stat-card accent"><div class="compare-stat-val">${r.nb_communs}</div><div class="compare-stat-label">En commun</div></div>
        <div class="compare-stat-card warn"><div class="compare-stat-val">${r.nb_seulement_a}</div><div class="compare-stat-label">Seulement dans A</div></div>
        <div class="compare-stat-card warn"><div class="compare-stat-val">${r.nb_seulement_b}</div><div class="compare-stat-label">Seulement dans B</div></div>
      </div>
      ${r.seulement_a.length?`<div class="compare-section-title">Seulement dans A (${r.seulement_a.length})</div><div class="compare-file-list">${r.seulement_a.slice(0,100).map(f=>`<div class="compare-file-row"><span class="compare-file-name">${f.nom}</span><span class="compare-file-size">${fmt(f.taille_mb)}</span></div>`).join('')}${r.seulement_a.length>100?`<div class="compare-more">… et ${r.seulement_a.length-100} autres</div>`:''}</div>`:''}
      ${r.seulement_b.length?`<div class="compare-section-title">Seulement dans B (${r.seulement_b.length})</div><div class="compare-file-list">${r.seulement_b.slice(0,100).map(f=>`<div class="compare-file-row"><span class="compare-file-name">${f.nom}</span><span class="compare-file-size">${fmt(f.taille_mb)}</span></div>`).join('')}${r.seulement_b.length>100?`<div class="compare-more">… et ${r.seulement_b.length-100} autres</div>`:''}</div>`:''}`;
  });
}

/* ── Évolution state ─────────────────────────────────────────── */
const evoState = {
  period: readStore('mi-evo-period', '12w'),
  disk:   readStore('mi-evo-disk',   'Tous'),
  mode:   readStore('mi-evo-mode',   'count'), // 'count' | 'size' | 'cumul'
  selectedWeek: null,
};
function saveEvoState() {
  writeStore('mi-evo-period', evoState.period);
  writeStore('mi-evo-disk',   evoState.disk);
  writeStore('mi-evo-mode',   evoState.mode);
}

async function renderEvolution(content) {
  $('result-count').textContent = 'Évolution';

  const PERIODS = [
    { k:'4w',  label:'4 sem.' },{ k:'12w', label:'12 sem.' },
    { k:'26w', label:'6 mois' },{ k:'52w', label:'1 an' },{ k:'all', label:'Tout' },
  ];
  const MODES = [
    { k:'count', label:'Fichiers' },{ k:'size', label:'Taille' },{ k:'cumul', label:'Cumulatif' },
  ];

  const wrap = document.createElement('div');
  wrap.className = 'evo-wrap2';
  wrap.innerHTML = `
    <div class="evo-toolbar">
      <div class="evo-period-btns">
        ${PERIODS.map(p=>`<button class="evo-period-btn${evoState.period===p.k?' active':''}" data-period="${p.k}">${p.label}</button>`).join('')}
      </div>
      <div class="evo-toolbar-right">
        <select class="evo-disk-select" id="evo-disk-select"></select>
        <div class="evo-mode-btns">
          ${MODES.map(m=>`<button class="evo-mode-btn${evoState.mode===m.k?' active':''}" data-mode="${m.k}">${m.label}</button>`).join('')}
        </div>
      </div>
    </div>
    <div id="evo-kpis" class="evo-kpis"></div>
    <div id="evo-chart-area" class="evo-chart-area"><div class="loading">Chargement…</div></div>
    <div id="evo-detail" class="evo-detail" style="display:none"></div>`;
  content.innerHTML = '';
  content.appendChild(wrap);

  // Disk selector
  const diskSel = $('evo-disk-select');
  if (diskSel) {
    const o0 = document.createElement('option'); o0.value='Tous'; o0.textContent='Tous les disques'; diskSel.appendChild(o0);
    const mainDisk = $('disk-filter');
    if (mainDisk) [...mainDisk.options].forEach(o => {
      if (o.value !== 'Tous') { const oo=document.createElement('option'); oo.value=o.value; oo.textContent=o.value; diskSel.appendChild(oo); }
    });
    diskSel.value = evoState.disk;
    diskSel.addEventListener('change', () => { evoState.disk=diskSel.value; evoState.selectedWeek=null; saveEvoState(); loadEvoData(content); });
  }
  wrap.querySelectorAll('.evo-period-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      evoState.period=btn.dataset.period; evoState.selectedWeek=null; saveEvoState();
      wrap.querySelectorAll('.evo-period-btn').forEach(b=>b.classList.toggle('active',b.dataset.period===evoState.period));
      loadEvoData(content);
    });
  });
  wrap.querySelectorAll('.evo-mode-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      evoState.mode=btn.dataset.mode; saveEvoState();
      wrap.querySelectorAll('.evo-mode-btn').forEach(b=>b.classList.toggle('active',b.dataset.mode===evoState.mode));
      loadEvoData(content);
    });
  });
  await loadEvoData(content);
}

async function loadEvoData(content) {
  const chartArea=$('evo-chart-area'), kpisEl=$('evo-kpis');
  if (chartArea) chartArea.innerHTML='<div class="loading">Chargement…</div>';
  if (kpisEl) kpisEl.innerHTML='';

  const data = await api(`/stats/evolution?period=${evoState.period}&disk=${encodeURIComponent(evoState.disk)}`);
  if (!data) { if(chartArea) chartArea.innerHTML='<div class="empty">Erreur de connexion.</div>'; return; }
  if (data.length === 0) { if(chartArea) chartArea.innerHTML='<div class="empty">Pas encore assez de données pour cette période.</div>'; return; }

  let cumul = 0;
  const displayData = data.map(d => ({
    ...d,
    _val: evoState.mode==='cumul' ? (cumul+=d.nb)
        : evoState.mode==='size'  ? (d.size_mb||0)
        : d.nb,
  }));

  const totalFiles = data.reduce((s,d)=>s+d.nb,0);
  const totalSize  = data.reduce((s,d)=>s+(d.size_mb||0),0);
  const recordWeek = data.reduce((a,b)=>b.nb>a.nb?b:a, data[0]);
  const avgPerWeek = data.length>0 ? Math.round(totalFiles/data.length) : 0;
  const maxVal     = Math.max(...displayData.map(d=>d._val),1);

  if (kpisEl) {
    kpisEl.innerHTML=`
      <div class="evo-kpi"><div class="evo-kpi-val">${totalFiles.toLocaleString('fr-FR')}</div><div class="evo-kpi-label">Fichiers ajoutés</div></div>
      <div class="evo-kpi"><div class="evo-kpi-val">${fmt(totalSize)}</div><div class="evo-kpi-label">Taille totale</div></div>
      <div class="evo-kpi"><div class="evo-kpi-val">${recordWeek.nb.toLocaleString('fr-FR')}<span class="evo-kpi-sub"> ${recordWeek.semaine.replace(/^\d{4}-W/,'S')}</span></div><div class="evo-kpi-label">Semaine record ★</div></div>
      <div class="evo-kpi"><div class="evo-kpi-val">${avgPerWeek.toLocaleString('fr-FR')}</div><div class="evo-kpi-label">Moy. / semaine</div></div>`;
  }

  // Gap detection
  let gapHtml='';
  for (let i=1;i<data.length;i++) {
    const p=parseInt(data[i-1].semaine.split('-W')[1]), c=parseInt(data[i].semaine.split('-W')[1]);
    if (c-p>2) { gapHtml=`<div class="evo-gap-notice">⚠ Pause de ${c-p-1} semaine(s) sans ajout entre ${data[i-1].semaine.replace(/^\d{4}-W/,'S')} et ${data[i].semaine.replace(/^\d{4}-W/,'S')}</div>`; break; }
  }

  const TYPES=[
    {key:'nb_video',color:'var(--video)',label:'Vidéo'},
    {key:'nb_pdf',  color:'var(--pdf)',  label:'PDF'},
    {key:'nb_image',color:'var(--image)',label:'Image'},
    {key:'nb_music',color:'var(--music)',label:'Musique'},
    {key:'nb_other',color:'var(--other)',label:'Autre'},
  ];

  const barsHtml = displayData.map(d => {
    const isRecord   = d.semaine===recordWeek.semaine && evoState.mode==='count';
    const isSelected = d.semaine===evoState.selectedWeek;
    const pct        = Math.max(Math.round((d._val/maxVal)*100), d._val>0?2:0);
    const label      = d.semaine.replace(/^\d{4}-W/,'S');
    const valDisplay = evoState.mode==='size'
      ? (d.size_mb>=1024?(d.size_mb/1024).toFixed(0)+'G':(d.size_mb||0).toFixed(0)+'M')
      : d._val.toLocaleString('fr-FR');
    const innerHtml = evoState.mode==='count' && d.nb>0
      ? TYPES.map(t=>{const sp=Math.round(((d[t.key]||0)/d.nb)*100); return sp?`<div class="evo-bar-seg" style="height:${sp}%;background:${t.color}" title="${t.label}: ${d[t.key]||0}"></div>`:''}).join('')
      : `<div class="evo-bar-fill" style="height:100%"></div>`;
    const sizeStr=d.size_mb?` · ${fmt(d.size_mb)}`:'';
    return `<div class="evo-bar-col${isSelected?' selected':''}" data-week="${d.semaine}" title="${label} · ${d.nb} fichier(s)${sizeStr}">
      <div class="evo-bar-val">${valDisplay}</div>
      <div class="evo-bar-bg"><div class="evo-bar-inner" style="height:${pct}%">${innerHtml}</div></div>
      <div class="evo-bar-label">${label}</div>
      ${isRecord?'<div class="evo-bar-record">★</div>':''}
    </div>`;
  }).join('');

  const legendHtml = evoState.mode==='count'
    ? `<div class="evo-legend">${TYPES.map(t=>`<span class="evo-legend-item"><span class="evo-legend-dot" style="background:${t.color}"></span>${t.label}</span>`).join('')}</div>` : '';

  if (chartArea) {
    chartArea.innerHTML=`${gapHtml}<div class="evo-chart2">${barsHtml}</div>${legendHtml}`;
    chartArea.querySelectorAll('.evo-bar-col').forEach(col=>{
      col.addEventListener('click', async () => {
        const week=col.dataset.week;
        if (evoState.selectedWeek===week) {
          evoState.selectedWeek=null; const d=$('evo-detail'); if(d)d.style.display='none';
        } else { evoState.selectedWeek=week; await loadEvoWeekDetail(week); }
        chartArea.querySelectorAll('.evo-bar-col').forEach(c=>c.classList.toggle('selected',c.dataset.week===evoState.selectedWeek));
      });
    });
  }
  if (evoState.selectedWeek) await loadEvoWeekDetail(evoState.selectedWeek);
}

async function loadEvoWeekDetail(week) {
  const detailEl=$('evo-detail');
  if (!detailEl) return;
  detailEl.style.display='block';
  detailEl.innerHTML='<div class="loading">Chargement…</div>';

  const files=await api(`/stats/evolution/files?week=${encodeURIComponent(week)}&disk=${encodeURIComponent(evoState.disk)}`);
  if (!files) { detailEl.innerHTML='<div class="empty">Erreur.</div>'; return; }

  const label=week.replace(/^\d{4}-W/,'Semaine ');
  const TC={'Vidéo':'var(--video)','PDF':'var(--pdf)','Image':'var(--image)','Musique':'var(--music)'};
  const byType={};
  files.forEach(f=>{(byType[f.type]=byType[f.type]||[]).push(f);});

  const typeSummary=Object.entries(byType).map(([t,arr])=>
    `<span class="evo-detail-type-pill" style="border-color:${TC[t]||'var(--other)'};color:${TC[t]||'var(--other)'}">${t} ${arr.length}</span>`
  ).join('');

  const rowsHtml=files.map(f=>{
    const color=TC[f.type]||'var(--other)';
    const serie=f.serie?` · ${f.serie} S${String(f.saison).padStart(2,'0')}E${String(f.episode).padStart(2,'0')}`:'';
    return `<div class="evo-detail-row">
      <span class="evo-detail-dot" style="background:${color}"></span>
      <span class="evo-detail-name" title="${escapeHtml(f.chemin)}">${escapeHtml(f.nom)}</span>
      <span class="evo-detail-meta">${f.disque} · ${fmt(f.taille_mb)}${serie}</span>
    </div>`;
  }).join('');

  detailEl.innerHTML=`
    <div class="evo-detail-header">
      <div><span class="evo-detail-title">📅 ${label}</span><span class="evo-detail-count">${files.length} fichier(s)</span>
      <div class="evo-detail-types">${typeSummary}</div></div>
      <button class="evo-detail-close" id="evo-detail-close">✕</button>
    </div>
    <div class="evo-detail-list">${rowsHtml}</div>`;

  $('evo-detail-close')?.addEventListener('click',()=>{
    evoState.selectedWeek=null; detailEl.style.display='none';
    document.querySelectorAll('.evo-bar-col').forEach(c=>c.classList.remove('selected'));
  });
}

async function renderRules(content) {
  $('result-count').textContent = 'Règles automatiques';
  const rules = await api('/rules');
  if (!rules) { content.innerHTML = '<div class="empty">Erreur.</div>'; return; }
  const condLabels = { extension:'Extension', type:'Type', nom_contient:'Nom contient' };
  const actionLabels = { deplacer:'→ Déplacer', copier:'⎘ Copier' };
  const wrap = document.createElement('div'); wrap.className = 'rules-wrap';
  wrap.innerHTML = `<div class="rules-header"><div class="rules-desc">Règles appliquées automatiquement quand un fichier est détecté dans un dossier surveillé.</div><button class="rules-add-btn" id="rules-add-btn">+ Nouvelle règle</button></div><div class="rules-list" id="rules-list">${rules.length===0?'<div class="rules-empty">Aucune règle. Crée ta première règle !</div>':rules.map(r=>`
    <div class="rule-card ${r.actif?'':'rule-inactive'}">
      <div class="rule-card-left">
        <div class="rule-name">${r.nom}</div>
        <div class="rule-details">
          <span class="rule-badge">${condLabels[r.condition_type]||r.condition_type} = <strong>${r.condition_val}</strong></span>
          <span class="rule-arrow">→</span>
          <span class="rule-badge action">${actionLabels[r.action]||r.action}</span>
          <span class="rule-dest" title="${r.destination}">${r.destination}</span>
        </div>
        ${r.source?`<div class="rule-source">Source : ${r.source}</div>`:''}
      </div>
      <div class="rule-card-right">
        <span class="rule-status ${r.actif?'active':'inactive'}">${r.actif?'Active':'Inactive'}</span>
        <button class="rule-delete-btn" data-id="${r.id}">✕</button>
      </div>
    </div>`).join('')}</div>`;
  content.innerHTML = ''; content.appendChild(wrap);
  $('rules-add-btn')?.addEventListener('click', () => openModal('rule-modal', 'rule-overlay'));
  content.querySelectorAll('.rule-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => { if(!confirm('Supprimer ?'))return; await api(`/rules/${btn.dataset.id}`,{method:'DELETE'}); await renderRules(content); });
  });
}

async function renderRegroup(content) {
  $('result-count').textContent = 'Suggestions de regroupement';
  content.innerHTML = '<div class="loading">Analyse…</div>';
  setStatus('Analyse…', true);
  const data = await api('/regroup/suggestions');
  setStatus('Prêt');
  if (!data) { content.innerHTML = '<div class="empty">Erreur.</div>'; return; }
  $('result-count').textContent = `${data.length} suggestion(s)`;
  if (data.length === 0) { content.innerHTML = '<div class="empty">✓ Aucun regroupement suggéré. Tes fichiers sont bien organisés !</div>'; return; }
  const byType = {
    serie_multi_disques: { label:'Séries éparpillées sur plusieurs disques', icon:'💿', items:[] },
    serie_multi_dossiers: { label:'Séries avec saisons dans des dossiers différents', icon:'📁', items:[] },
    type_multi_disques: { label:'Fichiers du même type sur plusieurs disques', icon:'📂', items:[] },
  };
  data.forEach(s => { if (byType[s.type]) byType[s.type].items.push(s); });
  const wrap = document.createElement('div'); wrap.className = 'regroup-wrap';
  Object.entries(byType).forEach(([,group]) => {
    if (!group.items.length) return;
    const section = document.createElement('div'); section.className = 'regroup-section';
    section.innerHTML = `<div class="regroup-section-title"><span>${group.icon}</span> ${group.label} <span class="regroup-count">${group.items.length}</span></div>`;
    group.items.forEach(s => {
      const card = document.createElement('div'); card.className = 'regroup-card';
      const disquesHtml = s.disques.map(d=>`<span class="regroup-disk-badge">${d}:</span>`).join('');
      card.innerHTML = `<div class="regroup-card-left"><div class="regroup-card-title">${s.titre}</div><div class="regroup-card-desc">${s.description}</div><div class="regroup-card-meta">${disquesHtml}<span class="regroup-nb">${s.nb_fichiers} fichier(s)</span>${s.taille_mb?`<span class="regroup-nb">${fmt(s.taille_mb)}</span>`:''}</div>${s.dossiers?`<div class="regroup-dossiers">${s.dossiers.map(d=>`<span class="regroup-dossier-path" title="${d}">${d.split('\\').pop()||d}</span>`).join(' · ')}</div>`:''}</div><div class="regroup-card-right"><button class="regroup-action-btn">Regrouper →</button></div>`;
      card.querySelector('.regroup-action-btn').addEventListener('click', () => openRegroupModal(s));
      section.appendChild(card);
    });
    wrap.appendChild(section);
  });
  content.innerHTML = ''; content.appendChild(wrap);
}

/* ═══════════════════════════════════════════════════════════════
   SETTINGS
═══════════════════════════════════════════════════════════════ */
function openSettings() {
  openModal('settings-modal', 'settings-overlay');
  switchSettingsTab('general');
}

function initSettings() {
  $('settings-close')?.addEventListener('click', () => closeModal('settings-modal', 'settings-overlay'));
  $('settings-overlay')?.addEventListener('click', () => closeModal('settings-modal', 'settings-overlay'));
  document.querySelectorAll('.settings-tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchSettingsTab(btn.dataset.tab));
  });
}

$('backend-stop-on-close')?.addEventListener('change', e => setBackendStopOnClosePreference(e.target.checked));
$('btn-check-update')?.addEventListener('click', () => checkForAppUpdate({ silent: false }));

function switchSettingsTab(tab) {
  document.querySelectorAll('.settings-tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.settings-tab-panel').forEach(p => p.style.display = p.dataset.panel === tab ? 'block' : 'none');
  if (tab === 'general') { loadModels(); loadWatchedFolders(); loadBatchStatus(); loadRuntimeSettingsUi(); }
  if (tab === 'private') { loadPinStatus(); loadPrivateFoldersList(); loadPrivateTimeout(); }
  if (tab === 'backup')  { loadBackupSettings(); loadBackupList(); }
  if (tab === 'api')     loadApiConfig();
}

async function loadModels() {
  const r = await api('/models'); const sel = $('model-select');
  if (!r || !r.models?.length) { if(sel)sel.innerHTML='<option>Ollama non disponible</option>'; if($('current-model-name'))$('current-model-name').textContent='Non connecté'; return; }
  if($('current-model-name'))$('current-model-name').textContent=r.current;
  if(sel){sel.innerHTML='';r.models.forEach(m=>{const opt=document.createElement('option');opt.value=m;opt.textContent=m;if(m===r.current)opt.selected=true;sel.appendChild(opt);});}
  if($('settings-feedback'))$('settings-feedback').textContent='';
}
$('model-apply')?.addEventListener('click', async () => {
  const model=$('model-select')?.value; if(!model)return;
  $('model-apply').textContent='Application…';$('model-apply').disabled=true;
  const r=await api('/model',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model})});
  $('model-apply').disabled=false;$('model-apply').textContent='Appliquer';
  if(r?.ok){if($('current-model-name'))$('current-model-name').textContent=r.model;if($('settings-feedback')){$('settings-feedback').textContent='✓ Modèle appliqué';setTimeout(()=>{if($('settings-feedback'))$('settings-feedback').textContent='';},3000);}setStatus(`Modèle : ${r.model}`);}
});

async function loadBatchStatus() {
  const r=await api('/analyse-batch-status');if(!r)return;
  if($('batch-status'))$('batch-status').textContent=`${r.analysed} / ${r.total} PDFs analysés`;
  if($('btn-batch'))$('btn-batch').disabled=r.remaining===0;
}
$('btn-batch')?.addEventListener('click', async () => {
  if($('btn-batch')){$('btn-batch').textContent='Lancement…';$('btn-batch').disabled=true;}
  const r=await api('/analyse-batch',{method:'POST'});
  if($('btn-batch')){$('btn-batch').textContent='Lancer batch';}
  if(r?.ok&&r.count>0){setStatus(`Batch : ${r.count} PDFs…`,true);if($('settings-feedback')){$('settings-feedback').textContent=`✓ ${r.count} PDFs en file`;setTimeout(()=>{if($('settings-feedback'))$('settings-feedback').textContent='';},4000);}}
  await loadBatchStatus();
});

async function loadWatchedFolders() {
  const r=await api('/watched-folders');const list=$('folders-list');if(!r||!list)return;
  list.innerHTML='';
  r.folders.forEach((folder,i)=>{
    const isDefault=i===0;const item=document.createElement('div');item.className='settings-folder-item';
    item.innerHTML=`<span class="settings-folder-dot ${isDefault?'default':''}"></span><span class="settings-folder-path" title="${folder}">${folder}</span>${isDefault?'<span class="settings-folder-badge">défaut</span>':`<button class="settings-folder-remove" data-path="${folder}">✕</button>`}`;
    list.appendChild(item);
  });
  list.querySelectorAll('.settings-folder-remove').forEach(btn=>{btn.addEventListener('click',async()=>{btn.textContent='…';btn.disabled=true;await api('/watched-folders',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:btn.dataset.path})});await loadWatchedFolders();});});
}
$('btn-add-folder')?.addEventListener('click', async()=>{
  const folder=await pickFolder('Dossier à surveiller');if(!folder)return;
  if($('btn-add-folder')){$('btn-add-folder').textContent='Ajout…';$('btn-add-folder').disabled=true;}
  const r=await api('/watched-folders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:folder})});
  if($('btn-add-folder')){$('btn-add-folder').disabled=false;$('btn-add-folder').textContent='+ Ajouter';}
  if(r?.ok){setStatus(`Dossier ajouté`);await loadWatchedFolders();await updateCounts();render();}
  else if($('settings-feedback')){$('settings-feedback').textContent=`✗ ${r?.error||'Erreur'}`;setTimeout(()=>{if($('settings-feedback'))$('settings-feedback').textContent='';},3000);}
});

/* ─── Private settings ── */
async function loadPinStatus(){const r=await api('/pin/status');if(!r)return;const s=$('pin-config-status');if(s){s.textContent=r.configured?'✓ PIN configuré':'Aucun PIN';s.style.color=r.configured?'var(--accent2)':'var(--muted)';}if($('btn-change-pin'))$('btn-change-pin').style.display=r.configured?'block':'none';if($('btn-delete-pin'))$('btn-delete-pin').style.display=r.configured?'block':'none';if($('btn-set-pin'))$('btn-set-pin').style.display=r.configured?'none':'block';}
async function loadPrivateFoldersList(){const r=await api('/private-folders');const list=$('private-folders-list');if(!r||!list)return;if(!r.folders.length){list.innerHTML='<div class="settings-folder-loading">Aucun dossier privé</div>';return;}list.innerHTML='';r.folders.forEach(folder=>{const item=document.createElement('div');item.className='settings-folder-item';item.innerHTML=`<span class="settings-folder-dot" style="background:var(--danger)"></span><span class="settings-folder-path" title="${folder}">${folder}</span><button class="settings-folder-remove" data-path="${folder}">✕</button>`;list.appendChild(item);});list.querySelectorAll('.settings-folder-remove').forEach(btn=>{btn.addEventListener('click',async()=>{btn.textContent='…';btn.disabled=true;await api('/private-folders',{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:btn.dataset.path})});await loadPrivateFoldersList();});});}
async function loadPrivateTimeout(){const r=await api('/config');if(!r)return;state.privateTimeout=r.private_timeout??5;if($('timeout-select'))$('timeout-select').value=String(state.privateTimeout);}
$('btn-set-pin')?.addEventListener('click',()=>openPinModal('set'));
$('btn-change-pin')?.addEventListener('click',()=>openPinModal('change'));
$('btn-delete-pin')?.addEventListener('click',async()=>{if(!confirm('Supprimer le PIN ?'))return;await api('/pin/delete',{method:'POST'});lockPrivate();await loadPinStatus();});
$('btn-add-private-folder')?.addEventListener('click',async()=>{const folder=await pickFolder('Dossier privé');if(!folder)return;await api('/private-folders',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({path:folder})});await loadPrivateFoldersList();setStatus('Dossier privé ajouté');});
$('timeout-select')?.addEventListener('change',async()=>{state.privateTimeout=parseInt($('timeout-select').value);const c=await api('/config');if(!c)return;await api('/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tmdb_key:c.tmdb_key||'',private_timeout:state.privateTimeout,backup_enabled:c.backup_enabled,backup_keep:c.backup_keep,backup_dir:c.backup_dir||''})});if(state.privateUnlocked&&state.privateTimeout>0)startLockTimer();});

/* ─── Backup settings ── */
async function loadBackupSettings(){const r=await api('/config');if(!r)return;if($('backup-enabled'))$('backup-enabled').checked=r.backup_enabled!==false;if($('backup-keep'))$('backup-keep').value=String(r.backup_keep||7);if($('backup-dir-display'))$('backup-dir-display').textContent=r.backup_dir||'Documents\\media_indexer_backups';}
async function loadBackupList(){const r=await api('/backup/list');const list=$('backup-list');if(!r||!list)return;if(!r.backups?.length){list.innerHTML='<div class="settings-folder-loading">Aucun backup</div>';return;}list.innerHTML='';r.backups.forEach(b=>{const item=document.createElement('div');item.className='backup-item';item.innerHTML=`<div class="backup-info"><span class="backup-name">${b.nom}</span><span class="backup-date">${b.date} · ${fmt(b.taille_mb)}</span></div><button class="backup-restore-btn" data-nom="${b.nom}">Restaurer</button>`;list.appendChild(item);});list.querySelectorAll('.backup-restore-btn').forEach(btn=>{btn.addEventListener('click',async()=>{if(!confirm(`Restaurer "${btn.dataset.nom}" ?`))return;btn.textContent='…';btn.disabled=true;const r=await api('/backup/restore',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nom:btn.dataset.nom})});if(r?.ok){setStatus('Restauration effectuée — redémarre l\'app');alert('Restauration effectuée. Redémarre l\'application.');}else{setStatus('Erreur');btn.textContent='Restaurer';btn.disabled=false;}});});}
$('btn-backup-now')?.addEventListener('click',async()=>{if($('btn-backup-now')){$('btn-backup-now').textContent='Sauvegarde…';$('btn-backup-now').disabled=true;}const r=await api('/backup/now',{method:'POST'});if($('btn-backup-now')){$('btn-backup-now').disabled=false;$('btn-backup-now').textContent='Sauvegarder maintenant';}if(r?.ok){setStatus('Backup créé !');if($('backup-feedback')){$('backup-feedback').textContent='✓ Backup créé';setTimeout(()=>{if($('backup-feedback'))$('backup-feedback').textContent='';},4000);}await loadBackupList();}else if($('backup-feedback')){$('backup-feedback').textContent='✗ '+(r?.error||'Erreur');}});
$('btn-backup-save-settings')?.addEventListener('click',async()=>{const c=await api('/config');if(!c)return;await api('/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tmdb_key:c.tmdb_key||'',private_timeout:c.private_timeout||5,backup_enabled:$('backup-enabled')?.checked!==false,backup_keep:parseInt($('backup-keep')?.value)||7,backup_dir:c.backup_dir||''})});if($('backup-feedback')){$('backup-feedback').textContent='✓ Options sauvegardées';setTimeout(()=>{if($('backup-feedback'))$('backup-feedback').textContent='';},3000);}});

/* ─── API config ── */
async function loadApiConfig(){const r=await api('/config');if(!r)return;const input=$('tmdb-key-input');if(r.tmdb_key_set){if(input){input.value='••••••••••••••••••••••••';input.dataset.set='true';}if($('tmdb-status')){$('tmdb-status').textContent='✓ Clé configurée';$('tmdb-status').style.color='var(--accent2)';}}else{if(input){input.value='';input.dataset.set='false';}if($('tmdb-status')){$('tmdb-status').textContent='Aucune clé';$('tmdb-status').style.color='var(--muted)';}}await testOllamaConnection();}
$('tmdb-key-input')?.addEventListener('focus',function(){if(this.dataset.set==='true'){this.value='';this.dataset.set='false';}});
$('tmdb-key-save')?.addEventListener('click',async()=>{const key=$('tmdb-key-input')?.value.trim();if(!key)return;const c=await api('/config');await api('/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tmdb_key:key,private_timeout:c?.private_timeout||5,backup_enabled:c?.backup_enabled!==false,backup_keep:c?.backup_keep||7,backup_dir:c?.backup_dir||''})});if($('tmdb-status')){$('tmdb-status').textContent='✓ Clé configurée';$('tmdb-status').style.color='var(--accent2)';}if($('tmdb-key-input')){$('tmdb-key-input').value='••••••••••••••••••••••••';$('tmdb-key-input').dataset.set='true';}});
$('tmdb-key-clear')?.addEventListener('click',async()=>{if(!confirm('Supprimer la clé TMDB ?'))return;const c=await api('/config');await api('/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tmdb_key:'',private_timeout:c?.private_timeout||5,backup_enabled:c?.backup_enabled!==false,backup_keep:c?.backup_keep||7,backup_dir:c?.backup_dir||''})});if($('tmdb-key-input')){$('tmdb-key-input').value='';$('tmdb-key-input').dataset.set='false';}if($('tmdb-status')){$('tmdb-status').textContent='Aucune clé';$('tmdb-status').style.color='var(--muted)';}});
async function testOllamaConnection(){
  const status = $('ollama-status'), sub = $('ollama-status-sub'), dot = $('ollama-status-dot');
  if(status) status.textContent = 'Chargement…';
  if(sub) sub.textContent = 'Test de connexion local';
  if(dot) dot.className = 'api-status-dot';
  const t0 = performance.now();
  const r = await api('/models');
  const dt = Math.round(performance.now() - t0);
  if(r?.models?.length){
    if(status) status.textContent = 'Ollama connecté';
    if(sub) sub.textContent = `${r.models.length} modèle(s) · ${dt} ms · courant : ${r.current || '—'}`;
    if(dot) dot.className = 'api-status-dot ok';
  } else {
    if(status) status.textContent = 'Ollama indisponible';
    if(sub) sub.textContent = 'Aucun modèle détecté';
    if(dot) dot.className = 'api-status-dot err';
  }
}
$('btn-test-ollama')?.addEventListener('click', testOllamaConnection);

/* ═══════════════════════════════════════════════════════════════
   PIN MODAL
═══════════════════════════════════════════════════════════════ */
function initPinModal() {
  $('pin-cancel')?.addEventListener('click', () => closeModal('pin-modal', 'pin-overlay'));
  $('pin-overlay')?.addEventListener('click', () => closeModal('pin-modal', 'pin-overlay'));
  $('pin-input')?.addEventListener('keydown', e => { if(e.key==='Enter')$('pin-confirm')?.click(); if(e.key==='Escape')closeModal('pin-modal','pin-overlay'); });
  $('pin-confirm')?.addEventListener('click', async () => {
    const pin=$('pin-input')?.value.trim(), mode=$('pin-modal')?.dataset.mode;
    if(!pin){if($('pin-error'))$('pin-error').textContent='Entrez un PIN';return;}
    if(mode==='set'||mode==='change'){
      if(pin.length<4){if($('pin-error'))$('pin-error').textContent='Minimum 4 caractères';return;}
      const r=await api('/pin/set',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})});
      if(r?.ok){closeModal('pin-modal','pin-overlay');setStatus('PIN configuré');await loadPinStatus();}
      else if($('pin-error'))$('pin-error').textContent=r?.error||'Erreur';
    } else {
      const r=await api('/pin/verify',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})});
      if(r?.ok){state.privateUnlocked=true;startLockTimer();updateLockBtn();closeModal('pin-modal','pin-overlay');render();setStatus(`Privé déverrouillé (${state.privateTimeout===0?'sans limite':state.privateTimeout+' min'})`);}
      else{if($('pin-error'))$('pin-error').textContent='PIN incorrect';if($('pin-input')){$('pin-input').value='';$('pin-input').focus();$('pin-input').classList.add('shake');setTimeout(()=>$('pin-input')?.classList.remove('shake'),400);}}
    }
  });
}

function openPinModal(mode) {
  if($('pin-modal'))$('pin-modal').dataset.mode=mode;
  if($('pin-input'))$('pin-input').value='';
  if($('pin-error'))$('pin-error').textContent='';
  if($('pin-title'))$('pin-title').textContent=mode==='set'?'Définir un PIN':mode==='change'?'Changer le PIN':'🔒 Accès privé';
  if($('pin-subtitle'))$('pin-subtitle').textContent=mode==='set'?'Minimum 4 caractères':mode==='change'?'Nouveau PIN':'Entrez votre PIN';
  openModal('pin-modal','pin-overlay');
  setTimeout(()=>$('pin-input')?.focus(),100);
}

function lockPrivate() {
  state.privateUnlocked=false;
  if(state.privateLockTimer){clearTimeout(state.privateLockTimer);state.privateLockTimer=null;}
  updateLockBtn();
  if(state.tab==='private')render();
  setStatus('Espace privé verrouillé');
}
function startLockTimer(){if(state.privateLockTimer)clearTimeout(state.privateLockTimer);if(state.privateTimeout===0)return;state.privateLockTimer=setTimeout(lockPrivate,state.privateTimeout*60*1000);}
function updateLockBtn(){const btn=$('btn-lock');if(!btn)return;btn.textContent=state.privateUnlocked?'🔓':'🔒';btn.title=state.privateUnlocked?'Cliquer pour verrouiller':'Accès espace privé';btn.classList.toggle('unlocked',state.privateUnlocked);}

/* ═══════════════════════════════════════════════════════════════
   TAG MODAL
═══════════════════════════════════════════════════════════════ */
function initTagModal() {
  $('tag-cancel')?.addEventListener('click', () => closeModal('tag-modal', 'tag-overlay'));
  $('tag-overlay')?.addEventListener('click', () => closeModal('tag-modal', 'tag-overlay'));
  $('tag-input')?.addEventListener('keydown', e => { if(e.key==='Enter')$('tag-confirm')?.click(); if(e.key==='Escape')closeModal('tag-modal','tag-overlay'); });
  $('tag-confirm')?.addEventListener('click', async () => {
    const newTag=$('tag-input')?.value.trim();if(!newTag)return;
    const existing=state.tagModalCurrent.split(',').map(t=>t.trim()).filter(Boolean);
    if(!existing.includes(newTag))existing.push(newTag);
    const newTags=existing.join(',');
    await api('/tags-manuels',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chemin:state.tagModalChemin,tags_manuels:newTags})});
    if(state.selectedFile){state.selectedFile.tags_manuels=newTags;renderTagsManuels(newTags,state.tagModalChemin);}
    closeModal('tag-modal','tag-overlay');
  });
}

async function openTagModal(chemin, currentTags) {
  state.tagModalChemin=chemin; state.tagModalCurrent=currentTags;
  if($('tag-input'))$('tag-input').value='';
  const sugg=$('tag-suggestions');
  if(sugg){sugg.innerHTML='';const allTags=await api('/tags-manuels');if(allTags?.length){allTags.filter(t=>!currentTags.includes(t)).slice(0,12).forEach(t=>{const chip=document.createElement('button');chip.className='tag-suggestion-chip';chip.textContent=t;chip.addEventListener('click',()=>{if($('tag-input'))$('tag-input').value=t;});sugg.appendChild(chip);});}}
  openModal('tag-modal','tag-overlay');
  setTimeout(()=>$('tag-input')?.focus(),100);
}

/* ═══════════════════════════════════════════════════════════════
   FIX SÉRIE MODAL
═══════════════════════════════════════════════════════════════ */
function initFixSerieModal() {
  $('fix-serie-cancel')?.addEventListener('click', () => closeModal('fix-serie-modal','fix-serie-overlay'));
  $('fix-serie-overlay')?.addEventListener('click', () => closeModal('fix-serie-modal','fix-serie-overlay'));
  $('fix-serie-save')?.addEventListener('click', async () => {
    const chemin=$('fix-serie-chemin')?.value;
    const serie=$('fix-serie-serie')?.value.trim();
    const saison=parseInt($('fix-serie-saison')?.value)||1;
    const episode=parseInt($('fix-serie-episode')?.value)||1;
    const titre=$('fix-serie-titre')?.value.trim();
    if(!chemin||!serie){alert('Remplis le nom de la série.');return;}
    if($('fix-serie-save')){$('fix-serie-save').textContent='Sauvegarde…';$('fix-serie-save').disabled=true;}
    const r=await api('/fix-serie',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chemin,serie,saison,episode,nom_affichage:titre})});
    if($('fix-serie-save')){$('fix-serie-save').disabled=false;$('fix-serie-save').textContent='Sauvegarder';}
    if(r?.ok){setStatus(`Corrigé : ${serie} S${String(saison).padStart(2,'0')}E${String(episode).padStart(3,'0')}`);closeModal('fix-serie-modal','fix-serie-overlay');closeDetail();render();await updateCounts();}
  });
}

function openFixSerieModal(file) {
  if($('fix-serie-chemin'))$('fix-serie-chemin').value=file.chemin;
  if($('fix-serie-nom'))$('fix-serie-nom').textContent=file.nom;
  if($('fix-serie-serie'))$('fix-serie-serie').value=file.serie||'';
  if($('fix-serie-saison'))$('fix-serie-saison').value=file.saison||1;
  if($('fix-serie-episode'))$('fix-serie-episode').value=file.episode||1;
  if($('fix-serie-titre'))$('fix-serie-titre').value=file.titre||'';
  openModal('fix-serie-modal','fix-serie-overlay');
  setTimeout(()=>$('fix-serie-serie')?.focus(),100);
}

/* ═══════════════════════════════════════════════════════════════
   REGROUP MODAL
═══════════════════════════════════════════════════════════════ */
function initRegroupModal() {
  $('regroup-modal-close')?.addEventListener('click', () => closeModal('regroup-modal','regroup-overlay'));
  $('regroup-overlay')?.addEventListener('click', () => closeModal('regroup-modal','regroup-overlay'));
  $('regroup-browse-dest')?.addEventListener('click', async () => { const f=await pickFolder('Dossier de destination');if(f&&$('regroup-dest'))$('regroup-dest').value=f; });
  $('regroup-preview-btn')?.addEventListener('click', async () => {
    const dest=$('regroup-dest')?.value.trim();if(!dest){alert('Renseigne un dossier de destination.');return;}
    if(!state.currentRegroupSuggestion)return;
    const fichiers=state.currentRegroupSuggestion.fichiers.map(f=>f.chemin);
    if($('regroup-preview-btn')){$('regroup-preview-btn').textContent='Chargement…';$('regroup-preview-btn').disabled=true;}
    const r=await api('/regroup/preview',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fichiers,destination:dest,action:'deplacer',organiser_saisons:$('regroup-saisons')?.checked})});
    if($('regroup-preview-btn')){$('regroup-preview-btn').disabled=false;$('regroup-preview-btn').textContent='👁 Aperçu';}
    if(!r)return;
    const list=$('regroup-preview-list');
    if(list)list.innerHTML=r.preview.map(p=>`<div class="regroup-preview-row ${p.existe_deja?'warn':''} ${!p.source_existe?'error':''}"><div class="regroup-preview-nom">${p.nom}</div><div class="regroup-preview-arrow">→</div><div class="regroup-preview-dest">${p.destination}</div>${p.existe_deja?'<span class="regroup-preview-badge warn">Déjà présent</span>':''}${!p.source_existe?'<span class="regroup-preview-badge error">Introuvable</span>':''}</div>`).join('');
    if($('regroup-preview-section'))$('regroup-preview-section').style.display='block';
  });
  $('regroup-execute-btn')?.addEventListener('click', async () => {
    const dest=$('regroup-dest')?.value.trim();if(!dest){alert('Renseigne un dossier de destination.');return;}
    if(!state.currentRegroupSuggestion)return;
    const nb=state.currentRegroupSuggestion.fichiers.length;
    if(!confirm(`Déplacer ${nb} fichier(s) vers :\n${dest}\n\nCette action est irréversible.`))return;
    const fichiers=state.currentRegroupSuggestion.fichiers.map(f=>f.chemin);
    if($('regroup-execute-btn')){$('regroup-execute-btn').textContent='Déplacement…';$('regroup-execute-btn').disabled=true;}
    setStatus('Regroupement…',true);
    const r=await api('/regroup/execute',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fichiers,destination:dest,action:'deplacer',organiser_saisons:$('regroup-saisons')?.checked})});
    if($('regroup-execute-btn')){$('regroup-execute-btn').disabled=false;$('regroup-execute-btn').textContent='▶ Déplacer les fichiers';}
    if(r?.ok){setStatus(`Terminé — ${r['déplacés']} déplacé(s)`);closeModal('regroup-modal','regroup-overlay');await updateCounts();await render();}
    else setStatus('Erreur lors du regroupement');
  });
}

function openRegroupModal(suggestion) {
  state.currentRegroupSuggestion=suggestion;
  if($('regroup-modal-title'))$('regroup-modal-title').textContent=`Regrouper : ${suggestion.titre}`;
  if($('regroup-dest'))$('regroup-dest').value='';
  if($('regroup-preview-section'))$('regroup-preview-section').style.display='none';
  if($('regroup-preview-list'))$('regroup-preview-list').innerHTML='';
  if(suggestion.fichiers?.length){const f=suggestion.fichiers[0];if($('regroup-dest'))$('regroup-dest').placeholder=`Ex: ${f.disque||'E'}:\\Séries\\${suggestion.titre}`;}
  openModal('regroup-modal','regroup-overlay');
}

/* ═══════════════════════════════════════════════════════════════
   RULE MODAL
═══════════════════════════════════════════════════════════════ */
function initRuleModal() {
  $('rule-modal-cancel')?.addEventListener('click', () => closeModal('rule-modal','rule-overlay'));
  $('rule-overlay')?.addEventListener('click', () => closeModal('rule-modal','rule-overlay'));
  $('rule-browse-source')?.addEventListener('click', async () => { const f=await pickFolder('Dossier source');if(f&&$('rule-form-source'))$('rule-form-source').value=f; });
  $('rule-browse-dest')?.addEventListener('click', async () => { const f=await pickFolder('Dossier destination');if(f&&$('rule-form-dest'))$('rule-form-dest').value=f; });
  $('rule-modal-save')?.addEventListener('click', async () => {
    const nom=$('rule-form-nom')?.value.trim(), dest=$('rule-form-dest')?.value.trim(), cval=$('rule-form-cond-val')?.value.trim();
    if(!nom||!dest||!cval){alert('Remplis tous les champs obligatoires.');return;}
    if($('rule-modal-save')){$('rule-modal-save').textContent='Sauvegarde…';$('rule-modal-save').disabled=true;}
    const r=await api('/rules',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({nom,source:$('rule-form-source')?.value.trim()||'',condition_type:$('rule-form-cond-type')?.value||'extension',condition_val:cval,action:$('rule-form-action')?.value||'deplacer',destination:dest,actif:$('rule-form-actif')?.checked!==false})});
    if($('rule-modal-save')){$('rule-modal-save').disabled=false;$('rule-modal-save').textContent='Sauvegarder';}
    if(r?.ok){closeModal('rule-modal','rule-overlay');setStatus(`Règle "${nom}" créée`);if(state.tab==='rules')render();}
  });
}

/* ─── updateCounts ──────────────────────────────────────────── */
async function updateCounts() {
  const stats = await api('/stats'); if (!stats) return;
  const total = stats.par_type.reduce((s,t) => s+t.count, 0);
  if($('count-all'))$('count-all').textContent=total.toLocaleString();
  if($('count-favoris'))$('count-favoris').textContent=(stats.nb_favoris||0).toLocaleString();
  const map={'PDF':'count-pdf','Image':'count-images','Musique':'count-music'};
  stats.par_type.forEach(t=>{const el=$(map[t.type]);if(el)el.textContent=t.count;});
  const seriesR=await api('/series?q=');if(seriesR&&$('count-series'))$('count-series').textContent=seriesR.length;
  const disks=await api('/disks');
  if(disks){const sel=$('disk-filter'),cur=sel?.value;if(sel){sel.innerHTML='<option value="Tous">Tous les disques</option>';disks.forEach(d=>{const opt=document.createElement('option');opt.value=d;opt.textContent=d+':';sel.appendChild(opt);});if(cur)sel.value=cur;}}
}