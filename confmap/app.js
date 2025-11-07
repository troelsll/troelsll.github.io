// app.js
(() => {
  // ---------- Utilities ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const uid = () => crypto.randomUUID ? crypto.randomUUID() : (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));

  const fileToDataURL = (file) => new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const dataURLToBlob = (dataURL) => {
    const [header, data] = dataURL.split(',');
    const mime = header.match(/:(.*?);/)[1];
    const bin = atob(data);
    const len = bin.length;
    const u8 = new Uint8Array(len);
    for (let i = 0; i < len; i++) u8[i] = bin.charCodeAt(i);
    return new Blob([u8], { type: mime });
  };

  // ---------- IndexedDB ----------
  const DB_NAME = 'conference-map-builder';
  const DB_VERSION = 1;
  let db;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = (e) => {
        const db = req.result;
        if (!db.objectStoreNames.contains('maps')) {
          const s = db.createObjectStore('maps', { keyPath: 'id' });
          s.createIndex('by_name', 'name', { unique: false });
        }
        if (!db.objectStoreNames.contains('categories')) {
          const s = db.createObjectStore('categories', { keyPath: 'id' });
          s.createIndex('by_name', 'name', { unique: true });
        }
        if (!db.objectStoreNames.contains('pois')) {
          const s = db.createObjectStore('pois', { keyPath: 'id' });
          s.createIndex('by_name', 'name', { unique: false });
          s.createIndex('by_category', 'categoryId', { unique: false });
        }
        if (!db.objectStoreNames.contains('eventMaps')) {
          const s = db.createObjectStore('eventMaps', { keyPath: 'id' });
          s.createIndex('by_name', 'name', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function txStore(storeName, mode = 'readonly') {
    const tx = db.transaction(storeName, mode);
    return tx.objectStore(storeName);
  }

  const idb = {
    async add(store, value) {
      return new Promise((resolve, reject) => {
        const req = txStore(store, 'readwrite').add(value);
        req.onsuccess = () => resolve(value);
        req.onerror = () => reject(req.error);
      });
    },
    async put(store, value) {
      return new Promise((resolve, reject) => {
        const req = txStore(store, 'readwrite').put(value);
        req.onsuccess = () => resolve(value);
        req.onerror = () => reject(req.error);
      });
    },
    async get(store, key) {
      return new Promise((resolve, reject) => {
        const req = txStore(store).get(key);
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => reject(req.error);
      });
    },
    async getAll(store) {
      return new Promise((resolve, reject) => {
        const req = txStore(store).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => reject(req.error);
      });
    },
    async delete(store, key) {
      return new Promise((resolve, reject) => {
        const req = txStore(store, 'readwrite').delete(key);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    }
  };

  // ---------- State ----------
  const state = {
    maps: [],
    categories: [],
    pois: [],
    eventMaps: [],
    activeBaseMapId: null,
    currentEventMapId: null,
    placements: [], // { id, poiId, xPct, yPct }
    zoom: 1
  };

  // ---------- Rendering Helpers ----------
  function renderMapsList() {
    const list = $('#maps-list');
    list.innerHTML = '';
    state.maps.forEach(m => {
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="row">
          <strong>${m.name}</strong>
          <span class="inline-actions">
            <button data-act="select" data-id="${m.id}">Vælg</button>
            <button data-act="delete" data-id="${m.id}" class="danger">Slet</button>
          </span>
        </div>
      `;
      list.appendChild(li);
    });
    const select = $('#active-map-select');
    select.innerHTML = '<option value="">Vælg basiskort…</option>';
    state.maps.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = m.name;
      if (state.activeBaseMapId === m.id) opt.selected = true;
      select.appendChild(opt);
    });
    updateBaseMapImage();
  }

  function renderCategories() {
    const list = $('#categories-list');
    list.innerHTML = '';
    state.categories.forEach(c => {
      const li = document.createElement('li');
      li.innerHTML = `
        <div class="row">
          <strong>${c.name}</strong>
          <span class="badge"><span class="swatch" style="background:${c.color}"></span>${c.color}</span>
        </div>
        <div class="inline-actions">
          <button data-act="delete-cat" data-id="${c.id}" class="danger">Slet</button>
        </div>
      `;
      list.appendChild(li);
    });
    const sel = $('#poi-category');
    sel.innerHTML = '';
    state.categories.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      sel.appendChild(opt);
    });
    renderLegend();
  }

  function renderPOIs() {
    const list = $('#pois-list');
    list.innerHTML = '';
    state.pois.forEach(p => {
      const cat = state.categories.find(c => c.id === p.categoryId);
      const li = document.createElement('li');
      li.draggable = true;
      li.dataset.poiId = p.id;
      const iconPreview = p.iconDataURL ? `<img src="${p.iconDataURL}" alt="" style="width:18px;height:18px;border-radius:4px;object-fit:cover;border:1px solid var(--border)"/>` : `<span class="swatch" style="background:${cat ? cat.color : '#999'}"></span>`;
      li.innerHTML = `
        <div class="row">
          <strong>${p.name}</strong>
          <span class="badge">${iconPreview} ${cat ? cat.name : '—'}</span>
        </div>
        <div class="inline-actions">
          <button data-act="delete-poi" data-id="${p.id}" class="danger">Slet</button>
        </div>
      `;
      list.appendChild(li);
    });
    renderLegend();
  }

  function renderLegend() {
    const list = $('#legend-list');
    list.innerHTML = '';
    const catsInUse = new Map();
    state.pois.forEach(p => {
      const cat = state.categories.find(c => c.id === p.categoryId);
      if (cat) catsInUse.set(cat.id, cat);
    });
    catsInUse.forEach(c => {
      const li = document.createElement('li');
      li.className = 'legend-item';
      li.innerHTML = `<span class="swatch" style="background:${c.color}"></span>${c.name}`;
      list.appendChild(li);
    });
  }

  function renderEventMapsList(filter = '') {
    const list = $('#eventmaps-list');
    list.innerHTML = '';
    const q = filter.trim().toLowerCase();
    state.eventMaps
      .filter(em => em.name.toLowerCase().includes(q))
      .forEach(em => {
        const li = document.createElement('li');
        const active = em.id === state.currentEventMapId ? ' (aktiv)' : '';
        li.innerHTML = `
          <div class="row">
            <strong>${em.name}${active}</strong>
            <span class="inline-actions">
              <button data-act="load-em" data-id="${em.id}">Indlæs</button>
              <button data-act="rename-em" data-id="${em.id}">Omdøb</button>
              <button data-act="dup-em" data-id="${em.id}">Duplikér</button>
              <button data-act="del-em" data-id="${em.id}" class="danger">Slet</button>
            </span>
          </div>
          <div class="meta">
            <span class="badge">Placeringer: ${em.placements.length}</span>
            <span class="badge">Kort: ${getMapName(em.baseMapId)}</span>
          </div>
        `;
        list.appendChild(li);
      });
  }

  function getMapName(mapId) {
    const m = state.maps.find(x => x.id === mapId);
    return m ? m.name : '—';
  }

  // ---------- Base Map Handling ----------
  const baseMapImg = $('#base-map-img');
  const overlay = $('#overlay');
  const stage = $('#map-stage');

  async function updateBaseMapImage() {
    const id = state.activeBaseMapId;
    if (!id) {
      baseMapImg.src = '';
      baseMapImg.style.display = 'none';
      overlay.style.display = 'none';
      return;
    }
    const map = state.maps.find(m => m.id === id);
    if (!map) return;
    baseMapImg.src = map.imageDataURL;
    baseMapImg.onload = () => {
      baseMapImg.style.display = 'block';
      overlay.style.display = 'block';
      applyZoom();
      renderPlacements();
      updatePrintPreview(); // keep print view in sync
    };
  }

  function applyZoom() {
    baseMapImg.style.transform = `scale(${state.zoom})`;
    overlay.style.transform = `scale(${state.zoom})`;
    overlay.style.transformOrigin = 'top left';
    overlay.style.width = baseMapImg.naturalWidth + 'px';
    overlay.style.height = baseMapImg.naturalHeight + 'px';
    // Stage scroll keeps view reasonable
  }

  // ---------- Placements (markers on map) ----------
  function createMarkerEl(placement) {
    const poi = state.pois.find(p => p.id === placement.poiId);
    const cat = poi ? state.categories.find(c => c.id === poi.categoryId) : null;

    const el = document.createElement('div');
    el.className = 'marker';
    el.dataset.pid = placement.id;
    el.style.left = placement.xPct + '%';
    el.style.top = placement.yPct + '%';

    const pin = document.createElement('div');
    pin.className = 'pin';
    if (poi && poi.iconDataURL) {
      pin.innerHTML = `<img src="${poi.iconDataURL}" alt="">`;
      pin.style.background = 'transparent';
      pin.style.border = 'none';
    } else {
      pin.style.background = cat ? cat.color : '#22c55e';
    }

    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = poi ? poi.name : 'POI';

    el.appendChild(pin);
    el.appendChild(label);

    // drag handling
    let dragging = false;
    let startX = 0, startY = 0;

    const onDown = (e) => {
      e.preventDefault();
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      el.classList.add('selected');
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    };

    const onMove = (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      startX = e.clientX;
      startY = e.clientY;

      const rect = overlay.getBoundingClientRect();
      const overlayW = overlay.offsetWidth * state.zoom; // visual size
      const overlayH = overlay.offsetHeight * state.zoom;

      // current px position from percent
      const currentX = (placement.xPct / 100) * overlayW;
      const currentY = (placement.yPct / 100) * overlayH;

      let newX = currentX + dx;
      let newY = currentY + dy;

      // clamp
      newX = Math.max(0, Math.min(overlayW, newX));
      newY = Math.max(0, Math.min(overlayH, newY));

      // convert back to %
      placement.xPct = (newX / overlayW) * 100;
      placement.yPct = (newY / overlayH) * 100;

      el.style.left = placement.xPct + '%';
      el.style.top = placement.yPct + '%';
    };

    const onUp = () => {
      dragging = false;
      el.classList.remove('selected');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
      // persist if on current event map
      if (state.currentEventMapId) {
        persistCurrentEventMapPlacements();
      }
      updatePrintPreview();
    };

    el.addEventListener('mousedown', onDown);

    // delete on double click
    el.addEventListener('dblclick', () => {
      const idx = state.placements.findIndex(p => p.id === placement.id);
      if (idx >= 0) {
        state.placements.splice(idx, 1);
        el.remove();
        if (state.currentEventMapId) persistCurrentEventMapPlacements();
        updatePrintPreview();
        refreshEventMapBadge();
      }
    });

    return el;
  }

  function renderPlacements() {
    overlay.innerHTML = '';
    state.placements.forEach(pl => {
      overlay.appendChild(createMarkerEl(pl));
    });
    refreshEventMapBadge();
  }

  function refreshEventMapBadge() {
    renderEventMapsList($('#search-eventmaps').value || '');
  }

  function addPlacementFromPOI(poiId, clientX, clientY) {
    if (!state.activeBaseMapId) return;
    const rect = overlay.getBoundingClientRect();
    const overlayW = overlay.offsetWidth * state.zoom;
    const overlayH = overlay.offsetHeight * state.zoom;

    const xPx = clientX - rect.left;
    const yPx = clientY - rect.top;

    const xPct = Math.max(0, Math.min(100, (xPx / overlayW) * 100));
    const yPct = Math.max(0, Math.min(100, (yPx / overlayH) * 100));

    const placement = { id: uid(), poiId, xPct, yPct };
    state.placements.push(placement);
    overlay.appendChild(createMarkerEl(placement));
    if (state.currentEventMapId) persistCurrentEventMapPlacements();
    updatePrintPreview();
    refreshEventMapBadge();
  }

  // ---------- Drag & Drop from POI list ----------
  function setupPOIDragDrop() {
    $('#pois-list').addEventListener('dragstart', (e) => {
      const li = e.target.closest('li');
      if (!li) return;
      e.dataTransfer.setData('text/plain', li.dataset.poiId);
    });

    stage.addEventListener('dragover', (e) => {
      e.preventDefault();
    });

    stage.addEventListener('drop', (e) => {
      e.preventDefault();
      const poiId = e.dataTransfer.getData('text/plain');
      const imgRect = baseMapImg.getBoundingClientRect();
      if (!poiId || !imgRect.width || !imgRect.height) return;
      addPlacementFromPOI(poiId, e.clientX, e.clientY);
    });
  }

  // ---------- Forms / CRUD ----------
  async function addBaseMap(name, file) {
    const dataURL = await fileToDataURL(file);
    const rec = { id: uid(), name, imageDataURL: dataURL, createdAt: Date.now() };
    await idb.add('maps', rec);
    state.maps.push(rec);
    state.activeBaseMapId = rec.id;
    renderMapsList();
  }

  async function deleteBaseMap(id) {
    // prevent deletion if used by current event map
    const used = state.eventMaps.some(em => em.baseMapId === id);
    if (used) {
      alert('Dette basiskort bruges af mindst én event-map og kan ikke slettes.');
      return;
    }
    await idb.delete('maps', id);
    state.maps = state.maps.filter(m => m.id !== id);
    if (state.activeBaseMapId === id) {
      state.activeBaseMapId = state.maps[0]?.id || null;
      updateBaseMapImage();
    }
    renderMapsList();
  }

  async function addCategory(name, color) {
    const rec = { id: uid(), name, color };
    await idb.add('categories', rec);
    state.categories.push(rec);
    renderCategories();
  }

  async function deleteCategory(id) {
    // prevent deletion if used by POIs
    const used = state.pois.some(p => p.categoryId === id);
    if (used) {
      alert('Denne kategori bruges af mindst én POI og kan ikke slettes.');
      return;
    }
    await idb.delete('categories', id);
    state.categories = state.categories.filter(c => c.id !== id);
    renderCategories();
  }

  async function addPOI(name, categoryId, iconFile) {
    let iconDataURL = null;
    if (iconFile) {
      iconDataURL = await fileToDataURL(iconFile);
    }
    const rec = { id: uid(), name, categoryId, iconDataURL };
    await idb.add('pois', rec);
    state.pois.push(rec);
    renderPOIs();
  }

  async function deletePOI(id) {
    // remove placements referencing this poi
    const hasPlacement = state.placements.some(pl => pl.poiId === id);
    if (hasPlacement && !confirm('Denne POI er placeret på kortet. Slette alligevel? Placeringer fjernes.')) return;
    state.placements = state.placements.filter(pl => pl.poiId !== id);
    renderPlacements();
    // update any saved event maps containing this poi
    for (const em of state.eventMaps) {
      const newPl = em.placements.filter(pl => pl.poiId !== id);
      if (newPl.length !== em.placements.length) {
        em.placements = newPl;
        await idb.put('eventMaps', em);
      }
    }
    await idb.delete('pois', id);
    state.pois = state.pois.filter(p => p.id !== id);
    renderPOIs();
    renderEventMapsList($('#search-eventmaps').value || '');
    updatePrintPreview();
  }

  async function createEventMap(name) {
    if (!state.activeBaseMapId) {
      alert('Vælg eller opret et basiskort først.');
      return;
    }
    const rec = {
      id: uid(),
      name,
      baseMapId: state.activeBaseMapId,
      placements: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await idb.add('eventMaps', rec);
    state.eventMaps.push(rec);
    state.currentEventMapId = rec.id;
    state.placements = [];
    renderPlacements();
    renderEventMapsList($('#search-eventmaps').value || '');
  }

  async function loadEventMap(id) {
    const em = state.eventMaps.find(x => x.id === id);
    if (!em) return;
    state.currentEventMapId = em.id;
    state.activeBaseMapId = em.baseMapId;
    state.placements = em.placements.map(p => ({ ...p })); // copy
    renderMapsList();
    renderPlacements();
    renderEventMapsList($('#search-eventmaps').value || '');
    updatePrintPreview();
  }

  async function renameEventMap(id, newName) {
    const em = state.eventMaps.find(x => x.id === id);
    if (!em) return;
    em.name = newName;
    em.updatedAt = Date.now();
    await idb.put('eventMaps', em);
    renderEventMapsList($('#search-eventmaps').value || '');
    updatePrintPreview();
  }

  async function duplicateEventMap(id) {
    const em = state.eventMaps.find(x => x.id === id);
    if (!em) return;
    const copy = {
      ...em,
      id: uid(),
      name: em.name + ' (kopi)',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    await idb.add('eventMaps', copy);
    state.eventMaps.push(copy);
    renderEventMapsList($('#search-eventmaps').value || '');
  }

  async function deleteEventMap(id) {
    await idb.delete('eventMaps', id);
    state.eventMaps = state.eventMaps.filter(x => x.id !== id);
    if (state.currentEventMapId === id) {
      state.currentEventMapId = null;
      state.placements = [];
      renderPlacements();
    }
    renderEventMapsList($('#search-eventmaps').value || '');
  }

  async function persistCurrentEventMapPlacements() {
    if (!state.currentEventMapId) return;
    const em = state.eventMaps.find(x => x.id === state.currentEventMapId);
    if (!em) return;
    em.placements = state.placements.map(p => ({ ...p }));
    em.updatedAt = Date.now();
    await idb.put('eventMaps', em);
  }

  // ---------- Print (PDF via browser) ----------
  function updatePrintPreview() {
    const title = $('#print-title');
    const base = $('#print-base-map');
    const overlayEl = $('#print-overlay');
    const legendList = $('#print-legend-list');

    const em = state.eventMaps.find(x => x.id === state.currentEventMapId);
    title.textContent = em ? em.name : 'Event Map';

    const baseMap = state.maps.find(m => m.id === (em ? em.baseMapId : state.activeBaseMapId));
    base.src = baseMap ? baseMap.imageDataURL : '';
    overlayEl.innerHTML = '';

    // Build markers in print overlay (no zoom, work in absolute based on natural size)
    if (baseMap) {
      const img = new Image();
      img.onload = () => {
        overlayEl.style.width = img.width + 'px';
        overlayEl.style.height = img.height + 'px';
        const placements = em ? em.placements : state.placements;
        placements.forEach(pl => {
          const poi = state.pois.find(p => p.id === pl.poiId);
          const cat = poi ? state.categories.find(c => c.id === poi.categoryId) : null;

          const mk = document.createElement('div');
          mk.className = 'marker';
          mk.style.left = pl.xPct + '%';
          mk.style.top = pl.yPct + '%';
          mk.style.transform = 'translate(-50%, -100%)';

          const pin = document.createElement('div');
          pin.className = 'pin';
          if (poi && poi.iconDataURL) {
            pin.innerHTML = `<img src="${poi.iconDataURL}" alt="">`;
            pin.style.background = 'transparent';
            pin.style.border = 'none';
          } else {
            pin.style.background = cat ? cat.color : '#22c55e';
          }
          const label = document.createElement('div');
          label.className = 'label';
          label.textContent = poi ? poi.name : 'POI';
          mk.appendChild(pin);
          mk.appendChild(label);
          overlayEl.appendChild(mk);
        });
      };
      img.src = baseMap.imageDataURL;
    }

    legendList.innerHTML = '';
    const catsSet = new Map();
    state.pois.forEach(p => {
      const cat = state.categories.find(c => c.id === p.categoryId);
      if (cat) catsSet.set(cat.id, cat);
    });
    catsSet.forEach(c => {
      const li = document.createElement('li');
      li.innerHTML = `<span style="display:inline-block;width:12px;height:12px;border:1px solid #999;margin-right:6px;background:${c.color}"></span>${c.name}`;
      legendList.appendChild(li);
    });
  }

  function exportAsPDF() {
    // We use browser's print-to-PDF. This opens the print dialogue; user chooses "Gem som PDF".
    updatePrintPreview();
    window.print();
  }

  // ---------- Event Bindings ----------
  function bindUI() {
    // Tabs
    $$('.tab').forEach(btn => {
      btn.addEventListener('click', () => {
        $$('.tab').forEach(b => b.classList.remove('active'));
        $$('.tab-panel').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        $('#' + btn.dataset.tab).classList.add('active');
      });
    });

    // Add base map
    $('#form-add-map').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('#map-name').value.trim();
      const file = $('#map-image').files[0];
      if (!name || !file) return;
      await addBaseMap(name, file);
      e.target.reset();
    });

    $('#maps-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const id = btn.dataset.id;
      if (btn.dataset.act === 'select') {
        state.activeBaseMapId = id;
        renderMapsList();
      } else if (btn.dataset.act === 'delete') {
        await deleteBaseMap(id);
      }
    });

    // Categories
    $('#form-add-category').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('#cat-name').value.trim();
      const color = $('#cat-color').value;
      if (!name) return;
      await addCategory(name, color);
      e.target.reset();
    });

    $('#categories-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.act === 'delete-cat') {
        await deleteCategory(btn.dataset.id);
      }
    });

    // POIs
    $('#form-add-poi').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = $('#poi-name').value.trim();
      const categoryId = $('#poi-category').value;
      const iconFile = $('#poi-icon').files[0] || null;
      if (!name || !categoryId) return;
      await addPOI(name, categoryId, iconFile);
      e.target.reset();
    });

    $('#pois-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      if (btn.dataset.act === 'delete-poi') {
        await deletePOI(btn.dataset.id);
      }
    });

    // Event maps
    $('#btn-new-event-map').addEventListener('click', () => {
      $('#dlg-new-event-map').showModal();
      $('#new-event-map-name').focus();
    });

    $('#form-new-event-map').addEventListener('close', async (e) => {
      // not used; dialog submit uses method="dialog"
    });

    $('#form-new-event-map').addEventListener('submit', async (e) => {
      e.preventDefault();
      const dlg = $('#dlg-new-event-map');
      const name = $('#new-event-map-name').value.trim();
      if (name) await createEventMap(name);
      dlg.close();
    });

    $('#eventmaps-list').addEventListener('click', async (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      const id = btn.dataset.id;
      const act = btn.dataset.act;
      if (act === 'load-em') {
        await loadEventMap(id);
      } else if (act === 'rename-em') {
        const em = state.eventMaps.find(x => x.id === id);
        if (!em) return;
        $('#rename-event-map-name').value = em.name;
        $('#dlg-rename-event-map').dataset.id = id;
        $('#dlg-rename-event-map').showModal();
      } else if (act === 'dup-em') {
        await duplicateEventMap(id);
      } else if (act === 'del-em') {
        if (confirm('Slet event-map?')) await deleteEventMap(id);
      }
    });

    $('#form-rename-event-map').addEventListener('submit', async (e) => {
      e.preventDefault();
      const dlg = $('#dlg-rename-event-map');
      const id = dlg.dataset.id;
      const newName = $('#rename-event-map-name').value.trim();
      if (newName) await renameEventMap(id, newName);
      dlg.close();
    });

    $('#search-eventmaps').addEventListener('input', (e) => {
      renderEventMapsList(e.target.value);
    });

    // Active base map select
    $('#active-map-select').addEventListener('change', (e) => {
      state.activeBaseMapId = e.target.value || null;
      if (state.currentEventMapId) {
        // If current event map exists, align its base map to selected (optional behavior)
        const em = state.eventMaps.find(x => x.id === state.currentEventMapId);
        if (em && state.activeBaseMapId) {
          em.baseMapId = state.activeBaseMapId;
          idb.put('eventMaps', em);
        }
      }
      renderMapsList();
    });

    // Zoom
    const zoomRange = $('#zoom-range');
    const zoomLabel = $('#zoom-label');
    zoomRange.addEventListener('input', (e) => {
      const v = Number(e.target.value);
      state.zoom = v / 100;
      zoomLabel.textContent = `${v}%`;
      applyZoom();
    });

    // Clear placements
    $('#btn-clear-placements').addEventListener('click', async () => {
      if (!state.placements.length) return;
      if (!confirm('Fjern alle placeringer fra dette kort?')) return;
      state.placements = [];
      renderPlacements();
      if (state.currentEventMapId) await persistCurrentEventMapPlacements();
      updatePrintPreview();
    });

    // Export
    $('#btn-export-pdf').addEventListener('click', exportAsPDF);

    // Save
    $('#btn-save-event-map').addEventListener('click', async () => {
      if (!state.currentEventMapId) {
        alert('Opret eller indlæs en event-map først.');
        return;
      }
      await persistCurrentEventMapPlacements();
      alert('Event-map gemt.');
    });

    // Drag-and-drop
    setupPOIDragDrop();
  }

  // ---------- Initial Load ----------
  async function init() {
    db = await openDB();
    state.maps = await idb.getAll('maps');
    state.categories = await idb.getAll('categories');
    state.pois = await idb.getAll('pois');
    state.eventMaps = await idb.getAll('eventMaps');

    // Default selects
    state.activeBaseMapId = state.maps[0]?.id || null;

    renderMapsList();
    renderCategories();
    renderPOIs();
    renderEventMapsList('');

    bindUI();

    // if there is at least one event map, load the last updated one
    if (state.eventMaps.length) {
      const latest = [...state.eventMaps].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
      await loadEventMap(latest.id);
    } else {
      updateBaseMapImage();
      updatePrintPreview();
    }
  }

  // Start
  init();
})();
