/* Pokémon Card Collector — standalone, no build step.
   Data: https://api.pokemontcg.io/v2 (free, no key, 1,000 req/day).
   Storage: localStorage only. Collection starts empty.
   Note: Cosmic Eclipse is set id "sm12" (271 cards, released 2019/10/31).
   "sm9" is Team Up — don't confuse the two. */
'use strict';

const API = 'https://api.pokemontcg.io/v2';
const LS = {
  collection: 'pcc_collection_v1',
  wishlist: 'pcc_wishlist_v1',
  snapshots: 'pcc_snapshots_v1',
  setsCache: 'pcc_sets_cache_v1',
};
const SETS_CACHE_MS = 6 * 60 * 60 * 1000; // 6 hours
const SNAPSHOT_MIN_MS = 24 * 60 * 60 * 1000; // 24 hours
const CONDITIONS = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
const FINISH_LABELS = { normal: 'Normal', holofoil: 'Holofoil', reverseHolofoil: 'Reverse Holofoil', '1stEdition': '1st Edition' };
const FINISH_ORDER = ['normal', 'holofoil', 'reverseHolofoil', '1stEdition'];
const RANGE_DAYS = { '1D': 1, '7D': 7, '1M': 30, '3M': 90, '6M': 180, 'ALL': Infinity };

const state = {
  sets: [],
  cardsCache: new Map(), // setId -> cards[]
  currentSet: null,
  currentCards: [],
  homeMode: 'grid',
  setMode: 'cards',
  rarityFilter: 'All',
  searchResults: [],
  portfolioRange: '6M',
  refreshing: false,
};

let collection = load(LS.collection, []);
let wishlist = load(LS.wishlist, []);
let snapshots = load(LS.snapshots, []);

/* ---------- helpers ---------- */
function $(sel) { return document.querySelector(sel); }
function load(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; }
}
function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage full/blocked */ } }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function money(n) { return '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
function fmtDate(d) { const dt = new Date(d); return isNaN(dt) ? String(d || '') : dt.toLocaleDateString('en-US'); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
let toastTimer = null;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

/* Fetch with retries — the free API occasionally returns 500/502. */
async function fetchJSON(url, attempts) {
  attempts = attempts || 3;
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await sleep(600 * Math.pow(2, i));
    }
  }
  throw lastErr;
}

function marketPrices(card) {
  return (card && card.tcgplayer && card.tcgplayer.prices) || {};
}
function marketPrice(card, finish) {
  const p = marketPrices(card)[finish];
  return p && typeof p.market === 'number' ? p.market : null;
}
function bestPrice(card) {
  for (const f of FINISH_ORDER) { const p = marketPrice(card, f); if (p != null) return p; }
  return 0;
}
function availableFinishes(card) {
  return FINISH_ORDER.filter(f => marketPrices(card)[f]);
}

/* ---------- storage-derived ---------- */
function ownedCardIdsBySet() {
  const map = new Map();
  for (const e of collection) {
    if (!map.has(e.setId)) map.set(e.setId, new Set());
    map.get(e.setId).add(e.cardId);
  }
  return map;
}
function ownedQtyForCard(cardId) {
  return collection.filter(e => e.cardId === cardId).reduce((s, e) => s + e.quantity, 0);
}
function isWished(cardId) { return wishlist.some(w => w.cardId === cardId); }
function collectionValue() {
  return collection.reduce((s, e) => s + (Number(e.price) || 0) * e.quantity, 0);
}
function collectionCardCount() {
  return collection.reduce((s, e) => s + e.quantity, 0);
}

/* ---------- navigation ---------- */
function showView(name) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const el = $('#view-' + name);
  if (el) el.classList.add('active');
  document.querySelectorAll('.bottom-nav button').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  if (name === 'collection') renderCollection();
  if (name === 'wishes') renderWishes();
  if (name === 'portfolio') renderPortfolio();
  window.scrollTo(0, 0);
}

/* ---------- sets / home ---------- */
async function loadSets() {
  const cached = load(LS.setsCache, null);
  if (cached && cached.ts && Date.now() - cached.ts < SETS_CACHE_MS && Array.isArray(cached.sets) && cached.sets.length) {
    state.sets = cached.sets;
    renderHome();
    return;
  }
  $('#homeLoading').hidden = false;
  $('#homeError').hidden = true;
  try {
    const data = await fetchJSON(API + '/sets?pageSize=250');
    state.sets = data.data || [];
    save(LS.setsCache, { ts: Date.now(), sets: state.sets });
    renderHome();
  } catch (e) {
    const err = $('#homeError');
    err.hidden = false;
    err.innerHTML = 'Could not load sets from the Pokémon TCG API (' + esc(e.message) + '). <button class="btn small" id="retrySets">Retry</button>';
    const btn = $('#retrySets'); if (btn) btn.addEventListener('click', loadSets);
  } finally {
    $('#homeLoading').hidden = true;
  }
}

function seriesOrder() {
  const bySeries = new Map();
  for (const s of state.sets) {
    if (!bySeries.has(s.series)) bySeries.set(s.series, []);
    bySeries.get(s.series).push(s);
  }
  const groups = [...bySeries.entries()].map(([series, sets]) => {
    sets.sort((a, b) => String(b.releaseDate || '').localeCompare(String(a.releaseDate || '')));
    const latest = sets[0] ? String(sets[0].releaseDate || '') : '';
    return { series, sets, latest };
  });
  groups.sort((a, b) => b.latest.localeCompare(a.latest));
  return groups;
}

function renderHome() {
  const owned = ownedCardIdsBySet();
  const wrap = $('#seriesList');
  wrap.innerHTML = '';
  const groups = seriesOrder();
  groups.forEach((g, gi) => {
    const sec = document.createElement('div');
    sec.className = 'series';
    const head = document.createElement('button');
    head.className = 'series-head';
    head.innerHTML = '<span>' + esc(g.series) + '</span><span class="chev">▾</span>';
    const body = document.createElement('div');
    body.className = 'series-body';
    body.hidden = gi !== 0; // first (newest) series open by default
    head.addEventListener('click', () => {
      body.hidden = !body.hidden;
      head.querySelector('.chev').textContent = body.hidden ? '›' : '▾';
    });
    head.querySelector('.chev').textContent = body.hidden ? '›' : '▾';

    if (state.homeMode === 'grid') {
      const grid = document.createElement('div');
      grid.className = 'set-symbols';
      for (const s of g.sets) {
        const count = owned.get(s.id) ? owned.get(s.id).size : 0;
        const b = document.createElement('button');
        b.className = 'set-symbol';
        b.title = s.name;
        b.innerHTML = '<img src="' + esc(s.images.symbol) + '" alt="' + esc(s.name) + '" loading="lazy">' +
          (count ? '<span class="owned-badge">' + count + '</span>' : '');
        b.addEventListener('click', () => openSet(s));
        grid.appendChild(b);
      }
      body.appendChild(grid);
    } else {
      for (const s of g.sets) {
        const count = owned.get(s.id) ? owned.get(s.id).size : 0;
        const row = document.createElement('button');
        row.className = 'set-row';
        row.innerHTML = '<img src="' + esc(s.images.symbol) + '" alt="" loading="lazy">' +
          '<span><span class="set-name">' + esc(s.name) + '</span><br><span class="set-meta">' +
          esc(s.total) + ' cards · ' + esc(fmtDate(s.releaseDate)) + '</span></span>' +
          '<span class="set-owned">' + count + ' owned</span>';
        row.addEventListener('click', () => openSet(s));
        body.appendChild(row);
      }
    }
    sec.appendChild(head);
    sec.appendChild(body);
    wrap.appendChild(sec);
  });
}

/* ---------- set view ---------- */
async function openSet(set) {
  state.currentSet = set;
  state.currentCards = [];
  state.rarityFilter = 'All';
  showView('set');
  renderSetHeader();
  $('#setCards').innerHTML = '';
  $('#setError').hidden = true;
  $('#setLoading').hidden = false;
  try {
    if (state.cardsCache.has(set.id)) {
      state.currentCards = state.cardsCache.get(set.id);
    } else {
      let page = 1, all = [], total = Infinity;
      while (all.length < total) {
        const data = await fetchJSON(API + '/cards?q=' + encodeURIComponent('set.id:' + set.id) + '&orderBy=number&pageSize=250&page=' + page);
        total = data.totalCount || 0;
        all = all.concat(data.data || []);
        if (!data.data || !data.data.length) break;
        page++;
        if (page > 10) break; // safety cap
      }
      state.currentCards = all;
      state.cardsCache.set(set.id, all);
    }
    renderSetHeader();
    renderRarityChips();
    renderSetCards();
  } catch (e) {
    const err = $('#setError');
    err.hidden = false;
    err.textContent = 'Could not load cards for ' + set.name + ' (' + e.message + '). Try again.';
  } finally {
    $('#setLoading').hidden = true;
  }
}

function renderSetHeader() {
  const s = state.currentSet;
  if (!s) return;
  const owned = ownedCardIdsBySet().get(s.id) || new Set();
  const total = state.currentCards.length || s.total || 0;
  const pct = total ? Math.round(owned.size / total * 100) : 0;
  // Per-rarity breakdown
  const byRarity = new Map();
  for (const c of state.currentCards) {
    const r = c.rarity || 'Unknown';
    if (!byRarity.has(r)) byRarity.set(r, { total: 0, owned: 0 });
    byRarity.get(r).total++;
    if (owned.has(c.id)) byRarity.get(r).owned++;
  }
  const rarityOrder = ['Common', 'Uncommon', 'Rare', 'Rare Holo', 'Rare Holo GX', 'Rare Holo V', 'Rare Holo VMAX', 'Rare Ultra', 'Rare Secret', 'Rare Rainbow', 'Promo'];
  const rarities = [...byRarity.keys()].sort((a, b) => {
    const ia = rarityOrder.indexOf(a), ib = rarityOrder.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib) || a.localeCompare(b);
  }).slice(0, 6);
  const iconFor = r => r === 'Common' ? '●' : r === 'Uncommon' ? '◆' : '★';
  const breakdown = rarities.map(r => {
    const v = byRarity.get(r);
    return '<div><div class="r-icon">' + iconFor(r) + '</div><div class="r-count">' + v.owned + '<span>/' + v.total + '</span></div><div class="r-name">' + esc(r) + '</div></div>';
  }).join('');
  $('#setHeader').innerHTML =
    '<div class="set-hero">' +
    (s.images.logo ? '<img class="logo" src="' + esc(s.images.logo) + '" alt="' + esc(s.name) + ' logo">' : '') +
    '<h2>' + esc(s.name) + '</h2>' +
    '<div class="release">Release date: ' + esc(fmtDate(s.releaseDate)) + '</div>' +
    '<div class="progress-top"><b>' + owned.size + '</b>/' + total + ' &nbsp;|&nbsp; <b>' + pct + '%</b></div>' +
    '<div class="progress-bar"><div class="progress-fill" style="width:' + pct + '%"></div></div>' +
    '<div class="rarity-breakdown">' + breakdown + '</div>' +
    '</div>';
}

function renderRarityChips() {
  const rarities = [...new Set(state.currentCards.map(c => c.rarity || 'Unknown'))].sort();
  const wrap = $('#rarityChips');
  wrap.innerHTML = '';
  ['All', ...rarities].forEach(r => {
    const chip = document.createElement('button');
    chip.className = 'chip' + (state.rarityFilter === r ? ' active' : '');
    chip.textContent = r;
    chip.addEventListener('click', () => { state.rarityFilter = r; renderRarityChips(); renderSetCards(); });
    wrap.appendChild(chip);
  });
}

function renderSetCards() {
  const wrap = $('#setCards');
  wrap.innerHTML = '';
  const cards = state.currentCards.filter(c => state.rarityFilter === 'All' || (c.rarity || 'Unknown') === state.rarityFilter);
  if (!cards.length) { wrap.innerHTML = '<div class="empty">No cards match this filter.</div>'; return; }
  wrap.className = 'card-grid' + (state.setMode === 'list' ? ' list-mode' : '');
  for (const c of cards) {
    if (state.setMode === 'list') {
      const row = document.createElement('div');
      row.className = 'card-row';
      const qty = ownedQtyForCard(c.id);
      row.innerHTML = '<img src="' + esc(c.images.small) + '" alt="' + esc(c.name) + '" loading="lazy">' +
        '<span><span class="cr-name">' + esc(c.name) + '</span><br><span class="cr-meta">#' + esc(c.number) + ' · ' + esc(c.rarity || '') + (qty ? ' · ' + qty + ' owned' : '') + '</span></span>' +
        '<span class="cr-price">' + money(bestPrice(c)) + '</span>';
      row.addEventListener('click', () => openDetail(c));
      wrap.appendChild(row);
    } else {
      const tile = document.createElement('button');
      tile.className = 'card-tile';
      const qty = ownedQtyForCard(c.id);
      tile.innerHTML = '<img src="' + esc(c.images.small) + '" alt="' + esc(c.name) + '" loading="lazy">' +
        (isWished(c.id) ? '<span class="wish-badge">♡</span>' : '') +
        (qty ? '<span class="owned-badge">' + qty + ' owned</span>' : '');
      tile.addEventListener('click', () => openDetail(c));
      wrap.appendChild(tile);
    }
  }
}

/* ---------- card detail modal ---------- */
let modalCard = null, modalFinish = 'normal', modalCondition = 'Near Mint', modalQty = 1;

function openDetail(card) {
  modalCard = card;
  const finishes = availableFinishes(card);
  modalFinish = finishes.includes('holofoil') ? 'holofoil' : (finishes[0] || 'normal');
  modalCondition = 'Near Mint';
  modalQty = 1;
  renderModal();
  $('#modal').hidden = false;
}
function closeModal() { $('#modal').hidden = true; modalCard = null; }

function renderModal() {
  const c = modalCard;
  if (!c) return;
  const prices = marketPrices(c);
  const rows = FINISH_ORDER.filter(f => prices[f]).map(f =>
    '<tr><td>' + esc(FINISH_LABELS[f] || f) + '</td><td>' + money(prices[f].market) + '</td></tr>'
  ).join('') || '<tr><td>No TCGplayer price listed</td><td>—</td></tr>';
  const finishes = availableFinishes(c);
  const ownedEntry = collection.find(e => e.cardId === c.id && e.finish === modalFinish && e.condition === modalCondition);
  const totalOwned = ownedQtyForCard(c.id);
  const wished = isWished(c.id);
  $('#modalBody').innerHTML =
    '<img class="modal-card-img" src="' + esc(c.images.large || c.images.small) + '" alt="' + esc(c.name) + '">' +
    '<h2>' + esc(c.name) + '</h2>' +
    '<div class="modal-sub">' + esc(c.set.name) + ' · #' + esc(c.number) + ' · ' + esc(c.rarity || '') + (totalOwned ? ' · ' + totalOwned + ' owned' : '') + '</div>' +
    '<table class="price-table">' + rows + '</table>' +
    '<div class="field"><label>Finish</label><select id="mFinish">' +
      finishes.map(f => '<option value="' + f + '"' + (f === modalFinish ? ' selected' : '') + '>' + esc(FINISH_LABELS[f] || f) + ' — ' + money(prices[f].market) + '</option>').join('') +
      (finishes.length ? '' : '<option value="normal">Normal — no price listed</option>') +
    '</select></div>' +
    '<div class="field"><label>Condition</label><select id="mCondition">' +
      CONDITIONS.map(x => '<option' + (x === modalCondition ? ' selected' : '') + '>' + x + '</option>').join('') +
    '</select></div>' +
    '<div class="field"><label>Quantity</label><div class="qty-row"><div class="stepper">' +
      '<button id="mQtyMinus" type="button">−</button><span class="qty-val" id="mQtyVal">' + modalQty + '</span><button id="mQtyPlus" type="button">+</button>' +
    '</div><span class="hint" style="padding:0">' + (ownedEntry ? ownedEntry.quantity + ' of this finish/condition owned' : '') + '</span></div></div>' +
    '<div class="modal-actions">' +
      '<button class="btn" id="mAdd">Add to Collection</button>' +
      '<button class="btn ghost" id="mWish">' + (wished ? '♥ In Wishes' : '♡ Add to Wishes') + '</button>' +
    '</div>' +
    (ownedEntry ? '<div class="modal-actions"><button class="btn danger" id="mRemove" style="flex:1">Remove from Collection</button></div>' : '');

  $('#mFinish').addEventListener('change', e => { modalFinish = e.target.value; renderModal(); });
  $('#mCondition').addEventListener('change', e => { modalCondition = e.target.value; renderModal(); });
  $('#mQtyMinus').addEventListener('click', () => { modalQty = Math.max(1, modalQty - 1); $('#mQtyVal').textContent = modalQty; });
  $('#mQtyPlus').addEventListener('click', () => { modalQty = Math.min(99, modalQty + 1); $('#mQtyVal').textContent = modalQty; });
  $('#mAdd').addEventListener('click', () => {
    addToCollection(c, modalFinish, modalCondition, modalQty);
    closeModal();
    if (state.currentSet) { renderSetHeader(); renderSetCards(); }
  });
  $('#mWish').addEventListener('click', () => { toggleWish(c); renderModal(); });
  const rm = $('#mRemove');
  if (rm) rm.addEventListener('click', () => {
    removeCollectionEntry(c.id, modalFinish, modalCondition);
    closeModal();
    if (state.currentSet) { renderSetHeader(); renderSetCards(); }
  });
}

function addToCollection(card, finish, condition, qty) {
  const price = marketPrice(card, finish);
  const existing = collection.find(e => e.cardId === card.id && e.finish === finish && e.condition === condition);
  if (existing) {
    existing.quantity += qty;
    if (price != null) existing.price = price;
  } else {
    collection.push({
      cardId: card.id, name: card.name, setId: card.set.id, setName: card.set.name,
      image: card.images.small, finish, condition, quantity: qty,
      priceAtAdd: price == null ? 0 : price, price: price == null ? 0 : price,
      addedAt: new Date().toISOString(),
    });
  }
  save(LS.collection, collection);
  maybeSnapshot();
  toast('Added ' + card.name + ' ×' + qty + ' to collection');
}

function removeCollectionEntry(cardId, finish, condition) {
  collection = collection.filter(e => !(e.cardId === cardId && e.finish === finish && e.condition === condition));
  save(LS.collection, collection);
  maybeSnapshot();
  toast('Removed from collection');
}

function toggleWish(card) {
  const i = wishlist.findIndex(w => w.cardId === card.id);
  if (i >= 0) { wishlist.splice(i, 1); toast('Removed from wishlist'); }
  else {
    wishlist.push({ cardId: card.id, name: card.name, setId: card.set.id, setName: card.set.name, image: card.images.small, price: bestPrice(card), addedAt: new Date().toISOString() });
    toast('Added to wishlist');
  }
  save(LS.wishlist, wishlist);
}

/* ---------- search ---------- */
async function runSearch(term) {
  term = term.trim();
  if (!term) return;
  $('#searchLoading').hidden = false;
  $('#searchError').hidden = true;
  $('#searchResults').innerHTML = '';
  try {
    const data = await fetchJSON(API + '/cards?q=' + encodeURIComponent('name:*' + term + '*') + '&pageSize=50');
    state.searchResults = data.data || [];
    renderSearchResults();
    if (!state.searchResults.length) $('#searchError').hidden = false, $('#searchError').textContent = 'No cards found for "' + term + '".';
  } catch (e) {
    const err = $('#searchError');
    err.hidden = false;
    err.textContent = 'Search failed (' + e.message + '). Try again.';
  } finally {
    $('#searchLoading').hidden = true;
  }
}
function renderSearchResults() {
  const wrap = $('#searchResults');
  wrap.innerHTML = '';
  for (const c of state.searchResults) {
    const tile = document.createElement('button');
    tile.className = 'card-tile';
    const qty = ownedQtyForCard(c.id);
    tile.innerHTML = '<img src="' + esc(c.images.small) + '" alt="' + esc(c.name) + '" loading="lazy">' +
      (qty ? '<span class="owned-badge">' + qty + ' owned</span>' : '');
    tile.title = c.name + ' — ' + c.set.name + ' — ' + money(bestPrice(c));
    tile.addEventListener('click', () => openDetail(c));
    wrap.appendChild(tile);
  }
}

/* ---------- collection ---------- */
function renderCollection() {
  $('#collectionTotal').textContent = money(collectionValue());
  $('#collectionCount').textContent = collectionCardCount() + ' cards · ' + collection.length + ' unique';
  $('#collectionEmpty').hidden = collection.length > 0;
  const sort = $('#collectionSort').value;
  const items = [...collection];
  if (sort === 'value') items.sort((a, b) => (b.price * b.quantity) - (a.price * a.quantity));
  else if (sort === 'name') items.sort((a, b) => a.name.localeCompare(b.name));
  else items.sort((a, b) => String(b.addedAt).localeCompare(String(a.addedAt)));
  const wrap = $('#collectionList');
  wrap.innerHTML = '';
  for (const e of items) {
    const div = document.createElement('div');
    div.className = 'coll-item';
    div.innerHTML = '<img src="' + esc(e.image) + '" alt="' + esc(e.name) + '" loading="lazy">' +
      '<span><span class="ci-name">' + esc(e.name) + '</span><br>' +
      '<span class="ci-meta">' + esc(e.setName) + ' · ' + esc(FINISH_LABELS[e.finish] || e.finish) + ' · ' + esc(e.condition) + '</span><br>' +
      '<span class="stepper"><button data-act="minus">−</button><span>' + e.quantity + '</span><button data-act="plus">+</button></span></span>' +
      '<span class="ci-price">' + money(e.price * e.quantity) + '<small>' + money(e.price) + ' each</small></span>' +
      '<button class="icon-btn" data-act="remove" title="Remove">✕</button>';
    div.querySelector('[data-act="minus"]').addEventListener('click', () => changeQty(e, -1));
    div.querySelector('[data-act="plus"]').addEventListener('click', () => changeQty(e, 1));
    div.querySelector('[data-act="remove"]').addEventListener('click', () => {
      collection = collection.filter(x => x !== e);
      save(LS.collection, collection); maybeSnapshot(); renderCollection();
    });
    wrap.appendChild(div);
  }
}
function changeQty(entry, delta) {
  entry.quantity += delta;
  if (entry.quantity <= 0) collection = collection.filter(x => x !== entry);
  save(LS.collection, collection);
  maybeSnapshot();
  renderCollection();
}

/* ---------- wishes ---------- */
function renderWishes() {
  $('#wishesEmpty').hidden = wishlist.length > 0;
  const wrap = $('#wishesList');
  wrap.innerHTML = '';
  for (const w of wishlist) {
    const div = document.createElement('div');
    div.className = 'coll-item';
    div.innerHTML = '<img src="' + esc(w.image) + '" alt="' + esc(w.name) + '" loading="lazy">' +
      '<span><span class="ci-name">' + esc(w.name) + '</span><br><span class="ci-meta">' + esc(w.setName) + '</span></span>' +
      '<span class="ci-price">' + money(w.price) + '</span>' +
      '<button class="icon-btn" data-act="move" title="Move to collection">＋</button>' +
      '<button class="icon-btn" data-act="remove" title="Remove">✕</button>';
    div.querySelector('[data-act="move"]').addEventListener('click', async () => {
      try {
        const data = await fetchJSON(API + '/cards/' + encodeURIComponent(w.cardId));
        addToCollection(data.data, availableFinishes(data.data)[0] || 'normal', 'Near Mint', 1);
      } catch (e) {
        toast('Could not fetch that card right now');
        return;
      }
      wishlist = wishlist.filter(x => x !== w);
      save(LS.wishlist, wishlist);
      renderWishes();
    });
    div.querySelector('[data-act="remove"]').addEventListener('click', () => {
      wishlist = wishlist.filter(x => x !== w);
      save(LS.wishlist, wishlist);
      renderWishes();
    });
    wrap.appendChild(div);
  }
}

/* ---------- portfolio ---------- */
function maybeSnapshot(force) {
  const value = collectionValue();
  const last = snapshots[snapshots.length - 1];
  if (force || !last || Date.now() - new Date(last.date).getTime() > SNAPSHOT_MIN_MS) {
    snapshots.push({ date: new Date().toISOString(), value: Math.round(value * 100) / 100 });
    save(LS.snapshots, snapshots);
  }
}
function snapshotsInRange() {
  const days = RANGE_DAYS[state.portfolioRange];
  if (!isFinite(days)) return [...snapshots];
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const inRange = snapshots.filter(s => new Date(s.date).getTime() >= cutoff);
  // Always include the current value as the latest point
  return inRange;
}
function renderPortfolio() {
  maybeSnapshot();
  const total = collectionValue();
  $('#portfolioTotal').textContent = money(total);
  const pts = snapshotsInRange();
  let gainText = '—';
  if (pts.length >= 1) {
    const first = pts[0].value;
    const gain = total - first;
    const pct = first ? gain / first * 100 : 0;
    gainText = (gain >= 0 ? '+' : '−') + money(Math.abs(gain)) + ' (' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%) in the last ' + state.portfolioRange;
    if (pts.length === 1 && first === total) gainText = '$0.00 (0.00%) — add cards or refresh prices to build history';
  }
  const gainEl = $('#portfolioGain');
  gainEl.textContent = gainText;
  gainEl.classList.toggle('neg', gainText.includes('−'));
  drawChart(pts, total);
  // Most Valuable — top 10 by line value
  const top = [...collection]
    .map(e => ({ ...e, line: (Number(e.price) || 0) * e.quantity }))
    .sort((a, b) => b.line - a.line)
    .slice(0, 10);
  const mv = $('#mostValuable');
  if (!top.length) { mv.innerHTML = '<div class="empty">No cards yet — your most valuable cards will show here.</div>'; }
  else {
    mv.innerHTML = top.map(e => {
      const base = Number(e.priceAtAdd) || 0;
      const pct = base ? ((Number(e.price) - base) / base * 100) : 0;
      return '<div class="mv-row"><div><div class="mv-name">' + esc(e.name) + '</div><div class="mv-meta">' +
        esc(e.condition) + ' · ' + esc(FINISH_LABELS[e.finish] || e.finish) + (e.quantity > 1 ? ' ×' + e.quantity : '') +
        '</div></div><div class="mv-price">' + money(e.line) +
        '<span class="pct' + (pct < 0 ? ' neg' : '') + '">' + (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%</span></div></div>';
    }).join('');
  }
  $('#snapshotNote').textContent = snapshots.length + ' value snapshot' + (snapshots.length === 1 ? '' : 's') + ' recorded. Prices refresh from TCGplayer; history builds as you refresh.';
}

function drawChart(pts, currentTotal) {
  const canvas = $('#portfolioChart');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#1e293b'; ctx.fillRect(0, 0, W, H);
  const points = pts.length ? pts.map(p => ({ t: new Date(p.date).getTime(), v: p.value })) : [];
  // Append current value as the live endpoint if it differs from the last snapshot
  if (points.length && Math.abs(points[points.length - 1].v - currentTotal) > 0.005) {
    points.push({ t: Date.now(), v: currentTotal });
  } else if (!points.length) {
    points.push({ t: Date.now() - 86400000, v: currentTotal }, { t: Date.now(), v: currentTotal });
  }
  const values = points.map(p => p.v);
  let min = Math.min(...values), max = Math.max(...values);
  if (max === min) { max = min + 1; min = Math.max(0, min - 1); }
  const pad = (max - min) * 0.15 || 1;
  min -= pad; max += pad;
  const t0 = points[0].t, t1 = points[points.length - 1].t || t0 + 1;
  const x = t => 24 + (t1 === t0 ? W / 2 : (t - t0) / (t1 - t0) * (W - 48));
  const y = v => H - 28 - (v - min) / (max - min) * (H - 56);
  // Gridlines + labels
  ctx.strokeStyle = '#334155'; ctx.fillStyle = '#94a3b8'; ctx.font = '20px sans-serif'; ctx.lineWidth = 1;
  for (let i = 0; i <= 2; i++) {
    const v = min + (max - min) * i / 2;
    const yy = y(v);
    ctx.beginPath(); ctx.moveTo(24, yy); ctx.lineTo(W - 24, yy); ctx.stroke();
    ctx.fillText('$' + Math.round(v), 28, yy - 6);
  }
  // Area fill
  const grad = ctx.createLinearGradient(0, 0, 0, H);
  grad.addColorStop(0, 'rgba(45,212,191,0.45)');
  grad.addColorStop(1, 'rgba(45,212,191,0.02)');
  ctx.beginPath();
  ctx.moveTo(x(points[0].t), y(points[0].v));
  for (const p of points) ctx.lineTo(x(p.t), y(p.v));
  ctx.lineTo(x(points[points.length - 1].t), H - 28);
  ctx.lineTo(x(points[0].t), H - 28);
  ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();
  // Line
  ctx.beginPath();
  ctx.moveTo(x(points[0].t), y(points[0].v));
  for (const p of points) ctx.lineTo(x(p.t), y(p.v));
  ctx.strokeStyle = '#2dd4bf'; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.stroke();
  // Last point dot
  const last = points[points.length - 1];
  ctx.beginPath(); ctx.arc(x(last.t), y(last.v), 6, 0, Math.PI * 2); ctx.fillStyle = '#2dd4bf'; ctx.fill();
  if (pts.length < 2) {
    ctx.fillStyle = '#94a3b8'; ctx.font = '18px sans-serif';
    ctx.fillText('Not enough history yet — refresh prices over time to grow the chart.', 28, 30);
  }
}

/* Refresh prices for owned cards, then snapshot. */
async function refreshPrices() {
  if (state.refreshing) return;
  if (!collection.length) { toast('Collection is empty — nothing to refresh'); return; }
  state.refreshing = true;
  const btn = $('#refreshPrices');
  if (btn) { btn.disabled = true; btn.textContent = 'Refreshing…'; }
  try {
    const ids = [...new Set(collection.map(e => e.cardId))];
    let updated = 0;
    for (const id of ids) {
      try {
        const data = await fetchJSON(API + '/cards/' + encodeURIComponent(id));
        const card = data.data;
        for (const e of collection.filter(x => x.cardId === id)) {
          const p = marketPrice(card, e.finish);
          if (p != null) { e.price = p; updated++; }
        }
        await sleep(120); // stay well under the free rate limit
      } catch (e) { /* keep the old price for this card */ }
    }
    save(LS.collection, collection);
    maybeSnapshot(true);
    renderPortfolio();
    if (document.querySelector('#view-collection.active')) renderCollection();
    toast('Prices refreshed (' + updated + ' entries updated)');
  } finally {
    state.refreshing = false;
    if (btn) { btn.disabled = false; btn.textContent = 'Refresh Prices'; }
  }
}

/* ---------- wiring ---------- */
function bindEvents() {
  document.querySelectorAll('.bottom-nav button').forEach(b =>
    b.addEventListener('click', () => showView(b.dataset.view)));
  $('#homeViewToggle').addEventListener('click', e => {
    const btn = e.target.closest('button'); if (!btn) return;
    state.homeMode = btn.dataset.mode;
    document.querySelectorAll('#homeViewToggle button').forEach(b => b.classList.toggle('active', b === btn));
    renderHome();
  });
  $('#setViewToggle').addEventListener('click', e => {
    const btn = e.target.closest('button'); if (!btn) return;
    state.setMode = btn.dataset.mode;
    document.querySelectorAll('#setViewToggle button').forEach(b => b.classList.toggle('active', b === btn));
    renderSetCards();
  });
  $('#backHome').addEventListener('click', () => showView('home'));
  $('#searchForm').addEventListener('submit', e => { e.preventDefault(); runSearch($('#searchInput').value); });
  $('#collectionSort').addEventListener('change', renderCollection);
  $('#refreshCollectionPrices').addEventListener('click', refreshPrices);
  $('#refreshPrices').addEventListener('click', refreshPrices);
  $('#rangePills').addEventListener('click', e => {
    const btn = e.target.closest('button'); if (!btn) return;
    state.portfolioRange = btn.dataset.range;
    document.querySelectorAll('#rangePills button').forEach(b => b.classList.toggle('active', b === btn));
    renderPortfolio();
  });
  $('#modalClose').addEventListener('click', closeModal);
  $('#modalBackdrop').addEventListener('click', closeModal);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
}

bindEvents();
loadSets();
maybeSnapshot();
