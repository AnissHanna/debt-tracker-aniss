// My Debt Tracker 🎀 — Supabase sync layer (local-first).
// The app keeps its own data model and calculation code. This file only maps records to/from Supabase rows,
// pushes local changes, pulls remote changes ("newest edit wins"), mirrors derived allocation snapshots,
// and moves receipt / settlement-letter files to Storage. It never clears local data on its own.
(function () {
  'use strict';
  const SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
  const STATE_PREFIX = 'mdt-sync-v1';
  const TABLES = ['debts', 'personal_borrowings', 'payments', 'vehicle_settlements'];
  const LOC = { debts: 'debts', personal_borrowings: 'borrowings', payments: 'payments', vehicle_settlements: 'settlements' };
  const PREFIX = { debts: 'DEBT-', personal_borrowings: 'BOR-', payments: 'PAY-', vehicle_settlements: 'SET-' };
  const OWN = ['paid_awaiting_letter', 'letter_received', 'ownership_in_progress', 'completed', 'loan_active'];

  const SPEC = {
    debts: { legacy: true, skip: ['id', 'uuid', 'type', 'debtType', 'active', 'needsCheck', 'updatedAt'], cols: [
      ['name', 'name', 't'], ['category', 'category', 't'], ['bank', 'bank', 't'], ['accountNumber', 'account_number', 't'],
      ['monthlyPayment', 'monthly_payment', 'm0'], ['firstDueDate', 'first_due_date', 'd'], ['dueDay', 'due_day', 'day'],
      ['openingArrears', 'opening_arrears', 'm0'], ['arrearsAsOf', 'arrears_as_of', 'd'], ['originalAmount', 'original_amount', 'm0'],
      ['totalLoanAmount', 'total_loan_amount', 'm0'], ['loanStartDate', 'loan_start_date', 'd'], ['loanTermMonths', 'loan_term_months', 'i0'],
      ['remainingTenureMonths', 'remaining_tenure_months', 'i0'], ['estimatedEndDate', 'estimated_end_date', 'd'],
      ['currentBalance', 'current_balance', 'm'], ['minimumPayment', 'minimum_payment', 'm0'], ['interestRate', 'interest_rate', 'n0'],
      ['interestRateUnit', 'interest_rate_unit', 't'], ['amountDue', 'amount_due', 'm0'], ['dueDate', 'due_date', 'd'], ['notes', 'notes', 't']] },
    personal_borrowings: { legacy: true, ref: ['personalDebtId', 'debt_id'], skip: ['id', 'uuid', 'personalDebtId', 'updatedAt'], required: ['borrowed_on', 'amount'], cols: [
      ['date', 'borrowed_on', 'd'], ['amount', 'amount', 'pos'], ['note', 'note', 't']] },
    payments: { legacy: true, ref: ['debtId', 'debt_id'], skip: ['id', 'uuid', 'debtId', 'updatedAt'], required: ['paid_on', 'amount'], cols: [
      ['date', 'paid_on', 'd'], ['amount', 'amount', 'pos'], ['method', 'method', 't'], ['reference', 'reference', 't'], ['notes', 'notes', 't']] },
    vehicle_settlements: { legacy: false, ref: ['debtId', 'debt_id'], skip: ['uuid', 'debtId', 'updatedAt'], required: ['vehicle_kind'], cols: [
      ['vehicleKind', 'vehicle_kind', 'veh'], ['plateNumber', 'plate_number', 't'], ['fullyPaidOn', 'fully_paid_on', 'd'],
      ['ownershipStatus', 'ownership_status', 'own'], ['letterRequestedOn', 'letter_requested_on', 'd'], ['letterReceivedOn', 'letter_received_on', 'd'],
      ['ownershipCompletedOn', 'ownership_completed_on', 'd'], ['reminderDismissedUntil', 'reminder_dismissed_until', 'd'], ['notes', 'notes', 't']] },
  };

  // ── helpers ──
  const hash = s => { let x = 2166136261; for (let i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); } return (x >>> 0).toString(36) + '.' + s.length; };
  const stable = v => Array.isArray(v) ? '[' + v.map(stable).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}' : JSON.stringify(v === undefined ? null : v);
  const newId = () => (crypto && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
  const time = s => s ? Date.parse(s) || 0 : 0;
  const empty = v => v === '' || v == null;
  function conv(v, type) {
    if (empty(v)) return { v: null, ok: true };
    const n = Number(v);
    switch (type) {
      case 't': return { v: String(v), ok: true };
      case 'd': return /^\d{4}-\d{2}-\d{2}/.test(String(v)) ? { v: String(v).slice(0, 10), ok: true } : { v: null, ok: false };
      case 'm': return isFinite(n) ? { v: Math.round(n * 100) / 100, ok: true } : { v: null, ok: false };
      case 'm0': return isFinite(n) && n >= 0 ? { v: Math.round(n * 100) / 100, ok: true } : { v: null, ok: false };
      case 'pos': return isFinite(n) && n > 0 ? { v: Math.round(n * 100) / 100, ok: true } : { v: null, ok: false };
      case 'n0': return isFinite(n) && n >= 0 && n < 1000 ? { v: n, ok: true } : { v: null, ok: false };
      case 'i0': return isFinite(n) && n >= 0 ? { v: Math.round(n), ok: true } : { v: null, ok: false };
      case 'day': return isFinite(n) && n >= 1 && n <= 31 ? { v: Math.round(n), ok: true } : { v: null, ok: false };
      case 'veh': return v === 'car' || v === 'motorcycle' ? { v, ok: true } : { v: null, ok: false };
      case 'own': return OWN.includes(v) ? { v, ok: true } : { v: null, ok: false };
    }
    return { v: null, ok: false };
  }

  // Local record → Supabase row. Returns null when the row can't be stored (e.g. parent not synced yet).
  function toRow(table, rec, uid, debtUuidOf) {
    const sp = SPEC[table], row = { id: rec.uuid, user_id: uid }, extra = {}, mapped = new Set(sp.cols.map(c => c[0]));
    if (!rec.uuid) return null;
    if (sp.legacy) row.legacy_id = rec.id == null ? null : String(rec.id);
    for (const k of Object.keys(rec)) if (!sp.skip.includes(k) && !mapped.has(k) && rec[k] !== undefined) extra[k] = rec[k];
    if (!sp.legacy && rec.id != null) extra.id = rec.id;
    for (const [k, col, type] of sp.cols) { const c = conv(rec[k], type); row[col] = c.v; if (!c.ok) extra[k] = rec[k]; }
    if (sp.ref) { const u = debtUuidOf(rec[sp.ref[0]]); if (!u) return null; row[sp.ref[1]] = u; }
    if (table === 'debts') {
      row.debt_type = rec.type === 'balance' ? 'credit_card' : rec.type;
      if (!['monthly', 'one_time', 'personal', 'credit_card'].includes(row.debt_type)) return null;
      if (!row.name || !row.name.trim()) row.name = 'Untitled debt';
      if (!row.category) row.category = 'Other';
      row.is_active = rec.active !== false; row.needs_check = !!rec.needsCheck;
    }
    if ((sp.required || []).some(c => row[c] == null)) return null;
    row.extra = extra;
    return row;
  }
  // Supabase row → local record (in the app's own shape).
  function fromRow(table, row, localId, debtLocalOf) {
    const sp = SPEC[table], rec = { ...(row.extra || {}) };
    for (const [k, col] of sp.cols) if (row[col] != null) rec[k] = row[col];
    if (sp.ref) { const lid = debtLocalOf(row[sp.ref[1]]); if (!lid) return null; rec[sp.ref[0]] = lid; }
    if (table === 'debts') {
      rec.type = row.debt_type === 'credit_card' ? 'balance' : row.debt_type;
      rec.debtType = row.debt_type; rec.active = row.is_active !== false;
      if (row.needs_check) rec.needsCheck = true; else delete rec.needsCheck;
    }
    rec.id = localId; rec.uuid = row.id;
    return rec;
  }
  const rowHash = row => { if (!row) return null; const { client_updated_at, ...r } = row; return hash(stable(r)); };
  const fileSig = v => hash(v.length + '|' + v.slice(0, 96) + '|' + v.slice(-96));
  function dataUrlToBlob(u) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(u || ''); if (!m) return null;
    const mime = m[1] || 'application/octet-stream', raw = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
    const bytes = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
    const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif', 'application/pdf': 'pdf' })[mime] || 'bin';
    return { blob: new Blob([bytes], { type: mime }), mime, ext };
  }
  // Two rows describe the same record (used to recognise copies of one local record).
  function sameContent(t, a, b) {
    if (t === 'debts') return a.name === b.name && a.debt_type === b.debt_type && (a.category || '') === (b.category || '');
    if (t === 'payments') return a.paid_on === b.paid_on && Number(a.amount) === Number(b.amount) && a.debt_id === b.debt_id;
    if (t === 'personal_borrowings') return a.borrowed_on === b.borrowed_on && Number(a.amount) === Number(b.amount) && a.debt_id === b.debt_id;
    return false;
  }
  const baseLegacy = v => String(v == null ? '' : v).split('@')[0];
  const blobToDataUrl = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
  function loadScript(src) {
    if (document.querySelector(`script[data-mdt-src="${src}"]`)) return window.supabase ? Promise.resolve() : new Promise((res, rej) => { const s = document.querySelector(`script[data-mdt-src="${src}"]`); s.addEventListener('load', res); s.addEventListener('error', rej); });
    return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.async = true; s.dataset.mdtSrc = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s); });
  }
  const freshState = uid => ({ uid, linked: false, sig: {}, files: {}, derived: {}, lastPull: {}, legacyAlt: {}, settingsSig: null });
  // Pending local edits: { recordUuid: ISO time of the edit }. Written by the app the moment a record is saved or deleted,
  // shared by all tabs (localStorage), cleared only after that exact edit reached the cloud or a newer cloud edit replaced it.
  const DIRTY_KEY = 'mdt-dirty-v1';

  class MDTSync {
    constructor(cfg, opts) { this.cfg = cfg; this.store = (opts && opts.store) || (typeof localStorage !== 'undefined' ? localStorage : null); this.client = null; this.st = freshState(null); this.allowMassDelete = false; this.blocked = 0; this._q = Promise.resolve(); }
    async ready() {
      if (this.client) return this.client;
      if (!window.supabase || !window.supabase.createClient) await loadScript(SDK_URL);
      this.client = window.supabase.createClient(this.cfg.supabaseUrl, this.cfg.supabasePublishableKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, storageKey: 'mdt-auth' } });
      return this.client;
    }
    // ── auth ──
    async currentUser() { const c = await this.ready(); const { data } = await c.auth.getSession(); return data && data.session ? data.session.user : null; }
    async signIn(email, password) { const c = await this.ready(); const { data, error } = await c.auth.signInWithPassword({ email, password }); if (error) throw error; return data.user; }
    async signUp(email, password) { const c = await this.ready(); const { data, error } = await c.auth.signUp({ email, password }); if (error) throw error; return { user: data.user, needsConfirm: !data.session }; }
    async signOut() { const c = await this.ready(); await c.auth.signOut(); this.st = freshState(null); }
    // ── per-user sync bookkeeping (localStorage, separate from the app data) ──
    useUser(uid) {
      let st = null; try { st = JSON.parse(this.store.getItem(STATE_PREFIX + ':' + uid) || 'null'); } catch (e) {}
      this.st = st && st.uid === uid ? { ...freshState(uid), ...st } : freshState(uid);
    }
    save() { if (this.st.uid) try { this.store.setItem(STATE_PREFIX + ':' + this.st.uid, JSON.stringify(this.st)); } catch (e) {} }
    static readDirty(store) { try { return JSON.parse(store.getItem(DIRTY_KEY) || '{}') || {}; } catch (e) { return {}; } }
    static markDirty(store, ids, at) {
      if (!ids || !ids.length) return; const m = MDTSync.readDirty(store), base = at ? time(at) : Date.now();
      for (const id of ids) m[id] = new Date(Math.max(base, time(m[id]) + 1)).toISOString(); // always newer than this record's previous edit
      try { store.setItem(DIRTY_KEY, JSON.stringify(m)); } catch (e) {}
    }
    static clearDirty(store, id, ts) { const m = MDTSync.readDirty(store); if (m[id] && (!ts || m[id] === ts)) { delete m[id]; try { store.setItem(DIRTY_KEY, JSON.stringify(m)); } catch (e) {} } }
    isLinked() { return !!this.st.linked; }
    reload() { if (this.st.uid) this.useUser(this.st.uid); } // other tabs may have saved newer bookkeeping
    markLinked() { this.reload(); this.st.linked = true; this.save(); }
    resetForCloudCopy() { const uid = this.st.uid; this.st = freshState(uid); this.st.linked = true; this.save(); }
    restoreMissing(data) {
      this.reload(); const live = new Set(), d = MDTSync.readDirty(this.store);
      ['debts', 'payments', 'borrowings', 'settlements'].forEach(k => ((data || {})[k] || []).forEach(r => r.uuid && live.add(r.uuid)));
      Object.keys(d).forEach(id => { if (!live.has(id)) MDTSync.clearDirty(this.store, id, d[id]); }); // forget pending deletes so they come back
      for (const t of TABLES) this.st.sig[t] = {}; this.st.files = {}; this.st.lastPull = {}; this.blocked = 0; this.save(); }
    // Gives every local record a stable UUID. Returns null when nothing changed.
    static ensureIds(data) {
      let changed = false; const out = {};
      for (const k of ['debts', 'payments', 'borrowings', 'settlements']) out[k] = (data[k] || []).map(r => r.uuid ? r : (changed = true, { ...r, uuid: newId() }));
      return changed ? out : null;
    }
    maps(data) {
      const byLocal = {}, byUuid = {}; (data.debts || []).forEach(d => { if (d.uuid) { byLocal[d.id] = d.uuid; byUuid[d.uuid] = d.id; } });
      return { debtUuidOf: id => byLocal[id], debtLocalOf: u => byUuid[u] };
    }
    pendingCount(data) {
      const dirty = MDTSync.readDirty(this.store); if (!this.st.uid) return Object.keys(dirty).length;
      const { debtUuidOf } = this.maps(data), live = new Set(); let n = 0;
      for (const t of TABLES) { const sig = this.st.sig[t] || {}; for (const r of data[LOC[t]] || []) { if (!r.uuid) { n++; continue; } live.add(r.uuid); const row = toRow(t, r, this.st.uid, debtUuidOf); if (row && (dirty[r.uuid] ? sig[r.uuid] !== rowHash(row) : !sig[r.uuid])) n++; } }
      return n + Object.keys(dirty).filter(id => !live.has(id)).length;
    }
    async cloudDebtCount() { const c = await this.ready(); const { count, error } = await c.from('debts').select('id', { count: 'exact', head: true }).is('deleted_at', null); if (error) throw error; return count || 0; }
    // One sync at a time across ALL open tabs/windows of the app (Web Locks), always starting from the latest saved bookkeeping.
    run(fn) {
      let started = false;
      const go = () => { started = true; this.reload(); return fn(); };
      const locked = () => { // falls back to this tab's own queue where the Locks API isn't available
        try { if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) return navigator.locks.request('mdt-sync', go).catch(e => (started ? Promise.reject(e) : go())); } catch (e) {}
        return go();
      };
      const p = this._q.then(locked, locked); this._q = p.catch(() => {}); return p;
    }
    async fetchLive(table, sel) {
      const c = await this.ready(), rows = [];
      for (let from = 0; ; from += 1000) { const { data, error } = await c.from(table).select(sel).is('deleted_at', null).order('created_at', { ascending: true }).range(from, from + 999); if (error) throw error; rows.push(...data); if (data.length < 1000) break; }
      return rows;
    }
    // Finds exact copies of the same record (same local id + same content) uploaded more than once.
    async countDuplicates() {
      let n = 0;
      const debts = await this.fetchLive('debts', 'id,legacy_id,name,debt_type'); const g = {};
      debts.forEach(d => { const k = baseLegacy(d.legacy_id) + '|' + d.name + '|' + d.debt_type; g[k] = (g[k] || 0) + 1; });
      Object.values(g).forEach(x => { if (x > 1) n += x - 1; });
      return n;
    }
    // Keeps one copy of each duplicated record (preferring the one this device uses), soft-deletes the others (deleted_at, nothing erased),
    // moves any payments / borrowings / files that exist only under a removed copy onto the kept one, then clears derived rows for removed copies.
    async repairDuplicates(data) {
      const c = await this.ready(), now = new Date().toISOString(), localU = new Set();
      ['debts', 'payments', 'borrowings', 'settlements'].forEach(k => (data[k] || []).forEach(r => r.uuid && localU.add(r.uuid)));
      const pick = arr => arr.find(r => localU.has(r.id)) || arr[0];
      const softDelete = async (t, ids) => { for (let i = 0; i < ids.length; i += 100) { const { error } = await c.from(t).update({ deleted_at: now, client_updated_at: now }).in('id', ids.slice(i, i + 100)); if (error) throw error; } };
      const debts = await this.fetchLive('debts', 'id,legacy_id,name,debt_type,created_at'), groups = {};
      debts.forEach(d => { const k = baseLegacy(d.legacy_id) + '|' + d.name + '|' + d.debt_type; (groups[k] = groups[k] || []).push(d); });
      const keepDebt = {}, removedDebts = [];
      Object.values(groups).forEach(g => { const k = pick(g); g.forEach(d => { keepDebt[d.id] = k.id; if (d.id !== k.id) removedDebts.push(d.id); }); });
      const out = { debts: removedDebts.length, payments: 0, personal_borrowings: 0, moved: 0 };
      for (const [t, dc, ac] of [['payments', 'paid_on', 'payment_id'], ['personal_borrowings', 'borrowed_on', 'borrowing_id']]) {
        const rows = await this.fetchLive(t, `id,legacy_id,debt_id,${dc},amount,created_at`), g2 = {};
        rows.forEach(r => { const k = baseLegacy(r.legacy_id) + '|' + r[dc] + '|' + Number(r.amount) + '|' + (keepDebt[r.debt_id] || r.debt_id); (g2[k] = g2[k] || []).push(r); });
        const del = [];
        for (const g of Object.values(g2)) {
          const underKept = g.filter(r => (keepDebt[r.debt_id] || r.debt_id) === r.debt_id), k = pick(underKept.length ? underKept : g);
          if (keepDebt[k.debt_id] && keepDebt[k.debt_id] !== k.debt_id) { const { error } = await c.from(t).update({ debt_id: keepDebt[k.debt_id], client_updated_at: now }).eq('id', k.id); if (error) throw error; out.moved++; }
          for (const r of g) if (r.id !== k.id) { del.push(r.id); await c.from('attachments').update({ [ac]: k.id, client_updated_at: now }).eq(ac, r.id).is('deleted_at', null); }
        }
        await softDelete(t, del); out[t] = del.length;
      }
      const sets = await this.fetchLive('vehicle_settlements', 'id,debt_id');
      for (const s of sets.filter(s => removedDebts.includes(s.debt_id))) {
        if (sets.some(x => x.debt_id === keepDebt[s.debt_id])) await softDelete('vehicle_settlements', [s.id]);
        else await c.from('vehicle_settlements').update({ debt_id: keepDebt[s.debt_id], client_updated_at: now }).eq('id', s.id);
      }
      for (let i = 0; i < removedDebts.length; i += 100) { const ids = removedDebts.slice(i, i + 100); for (const t of ['payment_allocations', 'unallocated_overpayments', 'monthly_obligations']) await c.from(t).delete().in('debt_id', ids); }
      await softDelete('debts', removedDebts);
      return out;
    }
    // Points this device's records at the cloud copies that represent them (same local id + same content). Returns null if nothing changed.
    async adoptCloudIds(data) {
      const uid = this.st.uid, out = { debts: [...data.debts], payments: [...data.payments], borrowings: [...(data.borrowings || [])], settlements: [...(data.settlements || [])] };
      let changed = false;
      for (const t of ['debts', 'personal_borrowings', 'payments']) {
        const rows = await this.fetchLive(t, '*'), arr = out[LOC[t]], m = this.maps(out), taken = new Set(arr.map(r => r.uuid));
        arr.forEach((r, i) => {
          const mine = toRow(t, r, uid, m.debtUuidOf); if (!mine) return;
          if (rows.some(x => x.id === r.uuid)) return;
          const hit = rows.find(x => baseLegacy(x.legacy_id) === String(r.id) && !taken.has(x.id) && sameContent(t, x, mine));
          if (hit) { arr[i] = { ...r, uuid: hit.id }; taken.add(hit.id); changed = true; }
        });
      }
      return changed ? out : null;
    }
    resetBookkeeping() { this.reload(); const keep = { uid: this.st.uid, linked: this.st.linked, files: this.st.files, settingsSig: this.st.settingsSig }; this.st = { ...freshState(keep.uid), ...keep }; this.save(); }

    // ── pull: cloud → local. Runs AFTER push. A record with a pending local edit is only replaced if the cloud copy is newer. ──
    async pull(data, receipts, stale = {}) {
      const c = await this.ready(), uid = this.st.uid, dirty = MDTSync.readDirty(this.store);
      const out = { debts: [...(data.debts || [])], payments: [...(data.payments || [])], borrowings: [...(data.borrowings || [])], settlements: [...(data.settlements || [])] };
      const putReceipts = {}, delReceipts = []; let settingsRow = null;
      const fetchAll = async (table, since) => {
        const rows = []; for (let from = 0; ; from += 1000) {
          let q = c.from(table).select('*').order('updated_at', { ascending: true }).range(from, from + 999); if (since) q = q.gte('updated_at', since);
          const { data: got, error } = await q; if (error) throw error; rows.push(...got); if (got.length < 1000) break;
        } return rows;
      };
      const fetchIds = async (table, ids) => { const rows = []; for (let i = 0; i < ids.length; i += 100) { const { data: got, error } = await c.from(table).select('*').in('id', ids.slice(i, i + 100)); if (error) throw error; rows.push(...got); } return rows; };
      for (const t of TABLES) {
        const arr = out[LOC[t]], sig = this.st.sig[t] || (this.st.sig[t] = {}), rows = await fetchAll(t, this.st.lastPull[t]);
        const last = rows.length ? rows[rows.length - 1].updated_at : this.st.lastPull[t];
        const seen = new Set(rows.map(r => r.id)), more = (stale[t] || []).filter(id => !seen.has(id));
        if (more.length) rows.push(...await fetchIds(t, more)); // copies push found out of date
        for (const row of rows) {
          const m = this.maps(out), idx = arr.findIndex(r => r.uuid === row.id), local = idx >= 0 ? arr[idx] : null, dts = dirty[row.id];
          if (dts && time(dts) >= time(row.client_updated_at || row.updated_at)) continue; // pending local edit is newer: keep it
          if (dts) { MDTSync.clearDirty(this.store, row.id, dts); delete dirty[row.id]; } // cloud edit is newer: newest edit wins
          if (row.deleted_at) { if (local) arr.splice(idx, 1); delete sig[row.id]; continue; }
          let lid = local ? local.id : null;
          if (!lid) { const base = String((SPEC[t].legacy ? row.legacy_id : (row.extra || {}).id) || '').split('@')[0]; lid = base && !arr.some(r => r.id === base) ? base : PREFIX[t] + String(Math.max(0, ...arr.map(r => parseInt(String(r.id).replace(/\D/g, ''), 10) || 0)) + 1).padStart(4, '0'); }
          const rec = fromRow(t, row, lid, m.debtLocalOf); if (!rec) continue;
          if (SPEC[t].legacy && row.legacy_id && row.legacy_id !== lid) this.st.legacyAlt[row.id] = row.legacy_id;
          const h = rowHash(toRow(t, rec, uid, m.debtUuidOf)); sig[row.id] = h;
          if (local && rowHash(toRow(t, local, uid, m.debtUuidOf)) === h) continue; // same content (e.g. our own push coming back)
          if (local) arr[idx] = rec; else arr.push(rec);
        }
        this.st.lastPull[t] = last;
      }
      // files
      const atts = await fetchAll('attachments', this.st.lastPull.attachments); let lastA = this.st.lastPull.attachments;
      for (const a of atts) {
        lastA = a.updated_at;
        const key = a.payment_id ? (out.payments.find(p => p.uuid === a.payment_id) || {}).id : a.borrowing_id ? (out.borrowings.find(b => b.uuid === a.borrowing_id) || {}).id : a.settlement_id ? ((s => s && 'LET-' + s.id)(out.settlements.find(s => s.uuid === a.settlement_id))) : null;
        if (!key) continue; const f = this.st.files[key];
        if (a.deleted_at) { if (f && f.id === a.id) { delReceipts.push(key); delete this.st.files[key]; } continue; }
        if (f && f.id === a.id) continue;
        if (receipts[key] && !f) continue; // local file not uploaded yet: it will replace the remote one
        if (f && time(f.at) >= time(a.created_at)) continue;
        const { data: blob, error } = await c.storage.from(a.bucket).download(a.storage_path); if (error || !blob) continue;
        const url = await blobToDataUrl(blob); putReceipts[key] = url;
        this.st.files[key] = { id: a.id, path: a.storage_path, bucket: a.bucket, sig: fileSig(url), at: a.created_at };
      }
      this.st.lastPull.attachments = lastA;
      { const { data: s } = await c.from('user_settings').select('*').maybeSingle(); if (s && hash(stable({ m: s.payment_methods, p: s.prefs })) !== this.st.settingsSig) { settingsRow = s; this.st.settingsSig = hash(stable({ m: s.payment_methods, p: s.prefs })); } }
      this.save();
      const changes = {};
      for (const k of ['debts', 'payments', 'borrowings', 'settlements']) {
        const before = data[k] || [], refs = new Set(before), uu = new Set(out[k].map(r => r.uuid));
        changes[k] = { up: out[k].filter(r => !refs.has(r)), rm: before.filter(r => r.uuid && !uu.has(r.uuid)).map(r => r.uuid) };
      }
      return { changes, putReceipts, delReceipts, settings: settingsRow ? { methods: settingsRow.payment_methods, prefs: settingsRow.prefs } : null };
    }
    // Applies pulled changes onto the CURRENT app state (not the snapshot the pull started from). Records edited again meanwhile are left alone.
    static applyChanges(cur, changes, dirty) {
      const next = {}; let changed = false;
      for (const k of ['debts', 'payments', 'borrowings', 'settlements']) {
        const ch = changes && changes[k]; if (!ch || (!ch.up.length && !ch.rm.length)) continue;
        const rm = new Set(ch.rm.filter(u => !dirty[u]));
        const arr = (cur[k] || []).filter(r => !(r.uuid && rm.has(r.uuid)));
        for (const rec of ch.up) {
          if (dirty[rec.uuid]) continue;
          const i = arr.findIndex(r => r.uuid === rec.uuid);
          if (i >= 0) arr[i] = rec; else arr.push(rec);
        }
        next[k] = arr; changed = true;
      }
      return changed ? next : null;
    }

    // ── push: local → cloud. Runs FIRST. Only records edited on this device (dirty) or never synced are sent. ──
    async push(data, receipts, ctx) {
      const c = await this.ready(), uid = this.st.uid, now = new Date().toISOString(), m = this.maps(data), dirty = MDTSync.readDirty(this.store); let errors = 0;
      const deletes = {}, remaps = {}, stale = {}, addStale = (t, id) => (stale[t] = stale[t] || []).push(id);
      for (const t of TABLES) {
        const sig = this.st.sig[t] || (this.st.sig[t] = {}), live = new Set(), cand = [];
        for (const r of data[LOC[t]] || []) {
          const row = toRow(t, r, uid, m.debtUuidOf); if (!row) continue; live.add(row.id);
          const h = rowHash(row), dts = dirty[row.id];
          if (sig[row.id] === h) continue; // unchanged since last sync
          if (!dts && sig[row.id]) { addStale(t, row.id); continue; } // differs but wasn't edited here: an old copy, refresh it from the cloud
          cand.push([row, h, dts]);
        }
        // Newest edit wins: never overwrite a cloud row that was edited after this local edit.
        const remoteT = {}, ids = cand.map(x => x[0].id);
        for (let i = 0; i < ids.length; i += 100) { const { data: got, error } = await c.from(t).select('id,client_updated_at,updated_at').in('id', ids.slice(i, i + 100)); if (error) throw error; got.forEach(g => { remoteT[g.id] = time(g.client_updated_at || g.updated_at); }); }
        const rows = [];
        for (const [row, h, dts] of cand) {
          if (row.id in remoteT && remoteT[row.id] > time(dts)) { addStale(t, row.id); continue; }
          if (this.st.legacyAlt[row.id]) row.legacy_id = this.st.legacyAlt[row.id];
          row.client_updated_at = dts || now; row.deleted_at = null; rows.push([row, h, dts]);
        }
        const done = (row, h, dts) => { sig[row.id] = h; if (dts) MDTSync.clearDirty(this.store, row.id, dts); };
        for (let i = 0; i < rows.length; i += 200) {
          const chunk = rows.slice(i, i + 200), { error } = await c.from(t).upsert(chunk.map(x => x[0]), { onConflict: 'id' });
          if (!error) { chunk.forEach(x => done(...x)); continue; }
          for (const [row, h, dts] of chunk) { // retry one by one; a legacy id used on another device gets a suffix
            let { error: e1 } = await c.from(t).upsert(row, { onConflict: 'id' });
            if (e1 && e1.code === '23505' && SPEC[t].legacy) {
              const { data: ex } = await c.from(t).select('*').eq('legacy_id', baseLegacy(row.legacy_id)).is('deleted_at', null).limit(1);
              if (ex && ex[0] && ex[0].id !== row.id && sameContent(t, ex[0], row)) { (remaps[t] = remaps[t] || {})[row.id] = ex[0].id; continue; } // same record already in the cloud: reuse it
              row.legacy_id = String(row.legacy_id).split('@')[0] + '@' + row.id.slice(0, 8); this.st.legacyAlt[row.id] = row.legacy_id; ({ error: e1 } = await c.from(t).upsert(row, { onConflict: 'id' })); }
            if (e1) { errors++; console.warn('[sync]', t, e1.message); } else done(row, h, dts);
          }
        }
        // Only records deleted on this device (dirty) are deleted in the cloud. Missing without a delete = old copy: bring it back.
        deletes[t] = Object.keys(sig).filter(id => !live.has(id) && dirty[id]);
        Object.keys(sig).filter(id => !live.has(id) && !dirty[id]).forEach(id => addStale(t, id));
        if (remaps[t]) { this.save(); return { errors, blocked: 0, remaps, stale }; } // the app re-points these records, then syncs again
      }
      // files that were removed on purpose on this device
      const fileDeletes = ctx.receiptsLoaded ? Object.keys(this.st.files).filter(k => !receipts[k]) : [];
      // mass-delete guard: a reset / restore on one phone must not silently wipe the cloud copy
      const synced = TABLES.reduce((a, t) => a + Object.keys(this.st.sig[t] || {}).length, 0);
      const delCount = TABLES.reduce((a, t) => a + deletes[t].length, 0) + fileDeletes.length;
      this.blocked = 0;
      if (delCount > 3 && delCount > synced * 0.3 && !this.allowMassDelete) this.blocked = delCount;
      else {
        for (const t of ['payments', 'personal_borrowings', 'vehicle_settlements', 'debts']) {
          const ids = deletes[t]; if (!ids.length) continue;
          const { error } = await c.from(t).update({ deleted_at: now, client_updated_at: now }).in('id', ids);
          if (error) errors++; else ids.forEach(id => { delete this.st.sig[t][id]; MDTSync.clearDirty(this.store, id, dirty[id]); });
        }
        for (const k of fileDeletes) { const f = this.st.files[k]; const { error } = await c.from('attachments').update({ deleted_at: now, client_updated_at: now }).eq('id', f.id); if (error) { errors++; continue; } await c.storage.from(f.bucket).remove([f.path]); delete this.st.files[k]; }
        this.allowMassDelete = false;
      }
      // receipts / payment proofs / settlement letters
      if (ctx.receiptsLoaded) for (const key of Object.keys(receipts)) {
        const val = receipts[key]; if (!val) continue;
        const p = data.payments.find(x => x.id === key), b = !p && (data.borrowings || []).find(x => x.id === key), s = !p && !b && key.startsWith('LET-') && (data.settlements || []).find(x => 'LET-' + x.id === key);
        const par = p ? { kind: 'payment_proof', col: 'payment_id', uuid: p.uuid, t: 'payments', bucket: 'payment-proofs' } : b ? { kind: 'borrowing_receipt', col: 'borrowing_id', uuid: b.uuid, t: 'personal_borrowings', bucket: 'payment-proofs' } : s ? { kind: 'settlement_letter', col: 'settlement_id', uuid: s.uuid, t: 'vehicle_settlements', bucket: 'settlement-letters' } : null;
        if (!par || !par.uuid || !(this.st.sig[par.t] || {})[par.uuid]) continue;
        const sg = fileSig(val), f = this.st.files[key]; if (f && f.sig === sg) continue;
        const file = dataUrlToBlob(val); if (!file) continue;
        const attId = newId(), path = `${uid}/${par.uuid}/${attId}.${file.ext}`;
        const up = await c.storage.from(par.bucket).upload(path, file.blob, { contentType: file.mime, upsert: false }); if (up.error) { errors++; console.warn('[sync] upload', up.error.message); continue; }
        const ins = await c.from('attachments').insert({ id: attId, user_id: uid, kind: par.kind, [par.col]: par.uuid, bucket: par.bucket, storage_path: path, mime_type: file.mime, size_bytes: file.blob.size, legacy_key: key, client_updated_at: now });
        if (ins.error) { errors++; await c.storage.from(par.bucket).remove([path]); continue; }
        if (f) { await c.from('attachments').update({ deleted_at: now, client_updated_at: now }).eq('id', f.id); await c.storage.from(f.bucket).remove([f.path]); } // replaced on purpose
        this.st.files[key] = { id: attId, path, bucket: par.bucket, sig: sg, at: now };
      }
      // derived snapshots, built with the app's own allocation logic
      if (ctx.L) for (const d of data.debts) {
        if (!d.uuid || !(this.st.sig.debts || {})[d.uuid]) continue;
        const r = ctx.L.recalculateAllocations(d, data.payments, ctx.today, data.borrowings || []);
        const payU = {}; data.payments.forEach(p => { if (p.debtId === d.id && p.uuid && (this.st.sig.payments || {})[p.uuid]) payU[p.id] = p.uuid; });
        const obl = (r.obligations || []).map(o => ({ user_id: uid, debt_id: d.uuid, kind: o.isArrears ? 'opening_arrears' : 'installment', period_month: o.month + '-01', due_date: o.dueDate || null, label: o.label || null, amount_due: o.due, amount_paid: o.paid, status: o.status, _lid: o.id }));
        const allocs = [], overs = [];
        for (const [pid, a] of Object.entries(r.byPayment || {})) { const pu = payU[pid]; if (!pu) continue; (a.allocations || []).forEach((x, i) => allocs.push({ payment_id: pu, debt_id: d.uuid, _ob: x.obligationId, amount: x.amount, allocation_order: i + 1 })); if (a.unallocated > 0) overs.push({ user_id: uid, payment_id: pu, debt_id: d.uuid, amount: a.unallocated }); }
        const h = hash(stable({ obl, allocs, overs })); if (this.st.derived[d.uuid] === h) continue;
        try {
          const idMap = {};
          if (obl.length) { const { data: got, error } = await c.from('monthly_obligations').upsert(obl.map(({ _lid, ...o }) => o), { onConflict: 'debt_id,kind,period_month' }).select('id,kind,period_month'); if (error) throw error; got.forEach(g => idMap[g.kind + '|' + String(g.period_month).slice(0, 10)] = g.id); }
          const lidU = {}; obl.forEach(o => lidU[o._lid] = idMap[o.kind + '|' + o.period_month]);
          let e = (await c.from('payment_allocations').delete().eq('debt_id', d.uuid)).error; if (e) throw e;
          const keep = Object.values(idMap); let q = c.from('monthly_obligations').delete().eq('debt_id', d.uuid); if (keep.length) q = q.not('id', 'in', `(${keep.join(',')})`); e = (await q).error; if (e) throw e;
          if (allocs.length) { e = (await c.from('payment_allocations').insert(allocs.map(a => ({ user_id: uid, payment_id: a.payment_id, debt_id: a.debt_id, obligation_id: lidU[a._ob] || null, amount: a.amount, allocation_order: a.allocation_order })))).error; if (e) throw e; }
          if (overs.length) { e = (await c.from('unallocated_overpayments').upsert(overs, { onConflict: 'payment_id' })).error; if (e) throw e; } // status / note set by the user are kept
          let dq = c.from('unallocated_overpayments').delete().eq('debt_id', d.uuid); if (overs.length) dq = dq.not('payment_id', 'in', `(${overs.map(o => o.payment_id).join(',')})`); e = (await dq).error; if (e) throw e;
          this.st.derived[d.uuid] = h;
        } catch (err) { errors++; console.warn('[sync] derived', d.name, err.message || err); }
      }
      // settings
      if (ctx.settings) { const sh = hash(stable({ m: ctx.settings.methods, p: ctx.settings.prefs })); if (sh !== this.st.settingsSig) { const { error } = await c.from('user_settings').upsert({ user_id: uid, payment_methods: ctx.settings.methods, prefs: ctx.settings.prefs }, { onConflict: 'user_id' }); if (!error) this.st.settingsSig = sh; } }
      if (ctx.markImport) await c.from('user_settings').upsert({ user_id: uid, local_import_at: now }, { onConflict: 'user_id' });
      this.save();
      return { errors, blocked: this.blocked, stale };
    }

    // Dev-only checks for the mapping layer (run with ?test=1). Pure: no network.
    static selfTest() {
      const T = [], ok = (name, cond) => T.push({ name, pass: !!cond }), uid = '00000000-0000-4000-8000-000000000000';
      const d = { id: 'DEBT-0003', uuid: newId(), name: 'Mazda CX-30', category: 'Car', type: 'monthly', debtType: 'monthly', monthlyPayment: 742.35, firstDueDate: '2026-01-15', active: true, snapshotDate: '2026-10-01', archivedAt: null, weird: { a: 1 } };
      const c = { id: 'DEBT-0009', uuid: newId(), name: 'RHB VS Cash Back', category: 'Credit Card', type: 'balance', debtType: 'credit_card', currentBalance: 1034.66, needsCheck: true, active: true };
      const map = id => ({ 'DEBT-0003': d.uuid, 'DEBT-0009': c.uuid })[id], back = u => ({ [d.uuid]: 'DEBT-0003', [c.uuid]: 'DEBT-0009' })[u];
      const p = { id: 'PAY-0042', uuid: newId(), debtId: 'DEBT-0003', date: '2026-10-15', amount: 800, method: 'Bank Transfer', reference: '', notes: '', applyAdvance: false, createdAt: '2026-10-15T09:00:00Z' };
      const rd = toRow('debts', d, uid, map), rc = toRow('debts', c, uid, map), rp = toRow('payments', p, uid, map);
      ok('Debt maps to row with legacy id', rd.legacy_id === 'DEBT-0003' && rd.debt_type === 'monthly' && rd.monthly_payment === 742.35);
      ok('Credit card maps to credit_card and back', rc.debt_type === 'credit_card' && fromRow('debts', rc, 'DEBT-0009', back).type === 'balance');
      ok('Unmapped fields survive in extra (snapshotDate, archivedAt)', fromRow('debts', rd, 'DEBT-0003', back).snapshotDate === '2026-10-01');
      ok('Round trip does not mark a record dirty', rowHash(toRow('debts', fromRow('debts', rd, 'DEBT-0003', back), uid, map)) === rowHash(rd) && rowHash(toRow('payments', fromRow('payments', rp, 'PAY-0042', back), uid, map)) === rowHash(rp));
      ok('Payment keeps full original amount (RM800)', rp.amount === 800 && rp.debt_id === d.uuid && rp.extra.applyAdvance === false);
      ok('Invalid date is kept in extra, not lost', (r => r.first_due_date === null && r.extra.firstDueDate === 'soon')(toRow('debts', { ...d, firstDueDate: 'soon' }, uid, map)));
      ok('Payment with unsynced debt is held back', toRow('payments', { ...p, debtId: 'DEBT-9999' }, uid, map) === null);
      ok('Stable hash ignores key order', rowHash({ a: 1, b: { c: 2, d: 3 } }) === rowHash({ b: { d: 3, c: 2 }, a: 1 }));
      ok('ensureIds adds UUIDs only where missing', (r => r && r.debts[0].uuid === 'keep' && !!r.payments[0].uuid)(MDTSync.ensureIds({ debts: [{ id: 'A', uuid: 'keep' }], payments: [{ id: 'P' }] })));
      ok('Data URL → file blob', (b => b && b.ext === 'png' && b.blob.size === 3)(dataUrlToBlob('data:image/png;base64,AAEC')));
      ok('Copies of one record are recognised', sameContent('payments', { paid_on: '2026-10-15', amount: 800, debt_id: 'a' }, { paid_on: '2026-10-15', amount: '800.00', debt_id: 'a' }) && !sameContent('payments', { paid_on: '2026-10-15', amount: 800, debt_id: 'a' }, { paid_on: '2026-10-16', amount: 800, debt_id: 'a' }));
      ok('Legacy suffix is ignored when matching', baseLegacy('PAY-0050@1a2b3c4d') === 'PAY-0050');
      return T;
    }
  }
  // ── Sync scenario tests: the real push/pull code against an in-memory stand-in for Supabase. Dev only (?test=1). ──
  function fakeSupabase() {
    const db = { T: {}, clock: Date.now() };
    const tick = () => new Date(db.clock += 1).toISOString(), cp = x => JSON.parse(JSON.stringify(x));
    class Q {
      constructor(t) { this.t = t; this.op = 'select'; this.f = []; this.opts = {}; }
      select(cols, o) { if (this.op === 'select') this.opts = o || {}; return this; }
      eq(c, v) { this.f.push(r => r[c] === v); return this; }
      is(c, v) { this.f.push(r => (r[c] == null ? null : r[c]) === v); return this; }
      in(c, a) { const s = new Set(a); this.f.push(r => s.has(r[c])); return this; }
      gte(c, v) { this.f.push(r => r[c] >= v); return this; }
      not(c, op, list) { const s = new Set(String(list).replace(/[()]/g, '').split(',')); this.f.push(r => !s.has(r[c])); return this; }
      order(c, o) { this.ord = [c, o && o.ascending === false ? -1 : 1]; return this; }
      range(a, b) { this.rg = [a, b]; return this; }
      limit(n) { this.lim = n; return this; }
      maybeSingle() { this.single = true; return this; }
      upsert(rows) { this.op = 'upsert'; this.rows = [].concat(rows); return this; }
      insert(rows) { this.op = 'insert'; this.rows = [].concat(rows); return this; }
      update(p) { this.op = 'update'; this.patch = p; return this; }
      delete() { this.op = 'delete'; return this; }
      then(res, rej) { let out; try { out = this.exec(); } catch (e) { return Promise.reject(e).then(res, rej); } return Promise.resolve(out).then(res, rej); }
      exec() {
        const tbl = db.T[this.t] || (db.T[this.t] = []), match = r => this.f.every(f => f(r));
        if (this.op === 'upsert' || this.op === 'insert') { for (const r of this.rows) { const now = tick(), i = tbl.findIndex(x => x.id === r.id); if (i >= 0) Object.assign(tbl[i], cp(r), { updated_at: now }); else tbl.push({ created_at: now, deleted_at: null, ...cp(r), updated_at: now }); } return { data: cp(this.rows), error: null }; }
        if (this.op === 'update') { tbl.filter(match).forEach(r => Object.assign(r, cp(this.patch), { updated_at: tick() })); return { data: null, error: null }; }
        if (this.op === 'delete') { db.T[this.t] = tbl.filter(r => !match(r)); return { error: null }; }
        let rows = tbl.filter(match);
        if (this.ord) { const [k, d] = this.ord; rows.sort((a, b) => (a[k] > b[k] ? 1 : a[k] < b[k] ? -1 : 0) * d); }
        if (this.opts.head) return { count: rows.length, data: null, error: null };
        if (this.rg) rows = rows.slice(this.rg[0], this.rg[1] + 1);
        if (this.lim) rows = rows.slice(0, this.lim);
        return this.single ? { data: rows[0] ? cp(rows[0]) : null, error: null } : { data: cp(rows), error: null };
      }
    }
    db.client = { from: t => new Q(t), storage: { from: () => ({ upload: async () => ({ error: null }), download: async () => ({ data: null, error: 'none' }), remove: async () => ({ error: null }) }) } };
    return db;
  }
  MDTSync.scenarioTest = async function (L) {
    const T = [], ok = (name, cond) => T.push({ name, pass: !!cond }), uid = '00000000-0000-4000-8000-0000000000aa', db = fakeSupabase();
    const mem = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
    const at = n => new Date(Date.now() + n * 60000).toISOString();
    const dev = (store, data) => { const s = new MDTSync({}, { store }); s.client = db.client; s.useUser(uid); s.st.linked = true; s.save(); return { s, store, data: data || JSON.parse(store.getItem('app')) }; };
    const persist = (d, prev) => { const { delta } = L.diffCollections(prev, d.data); d.store.setItem('app', JSON.stringify(L.mergeStored(JSON.parse(d.store.getItem('app') || 'null'), delta))); };
    const change = (d, fn, when) => { const prev = d.data; d.data = { ...prev, ...fn(prev) }; MDTSync.markDirty(d.store, L.diffCollections(prev, d.data).uuids, when); persist(d, prev); };
    const setAmt = (d, amt, when) => change(d, p => ({ debts: p.debts.map((x, i) => (i ? x : { ...x, monthlyPayment: amt })) }), when);
    const cycle = d => d.s.run(async () => { // same order as the app: ensure ids → push → pull → apply onto current state → save
      const prev = d.data, ids = MDTSync.ensureIds(d.data); if (ids) d.data = { ...d.data, ...ids };
      const res = await d.s.push(d.data, {}, { receiptsLoaded: false });
      const r = await d.s.pull(d.data, {}, res.stale || {});
      const ap = MDTSync.applyChanges(d.data, r.changes, MDTSync.readDirty(d.store)); if (ap) d.data = { ...d.data, ...ap };
      persist(d, prev);
    });
    const cloud = () => (db.T.debts || []).filter(r => !r.deleted_at).map(r => r.monthly_payment);
    const amt = d => d.data.debts[0].monthlyPayment, pending = st => Object.keys(MDTSync.readDirty(st)).length;
    const sA = mem(); sA.setItem('app', JSON.stringify({ debts: [{ id: 'DEBT-0001', name: 'Mazda CX-30', category: 'Car', type: 'monthly', debtType: 'monthly', monthlyPayment: 1600, firstDueDate: '2026-01-15', active: true }], payments: [], borrowings: [], settlements: [] }));
    let A = dev(sA); await cycle(A);
    ok('Setup: cloud has one Mazda at RM1,600', cloud().length === 1 && cloud()[0] === 1600);
    // Regression: the exact old failure — a pull reaches the device before its edit is pushed
    setAmt(A, 1580, at(1)); A.s.st.lastPull = {};
    { const r = await A.s.pull(A.data, {}, {}); const ap = MDTSync.applyChanges(A.data, r.changes, MDTSync.readDirty(sA)); if (ap) A.data = { ...A.data, ...ap }; }
    ok('Regression: local edit must not be overwritten by stale cloud sync', amt(A) === 1580 && pending(sA) === 1);
    await cycle(A); A = dev(sA); await cycle(A);
    ok('Test 1: cloud RM1,600 → edit RM1,580 → save → refresh = RM1,580', amt(A) === 1580 && cloud()[0] === 1580 && pending(sA) === 0);
    setAmt(A, 1600, at(2)); A = dev(sA); await cycle(A); A = dev(sA); await cycle(A);
    ok('Test 2: cloud RM1,580 → edit RM1,600 → save → refresh = RM1,600', amt(A) === 1600 && cloud()[0] === 1600);
    setAmt(A, 1580, at(3)); A = dev(sA);
    ok('Test 3a: offline edit RM1,580 survives close/reopen', amt(A) === 1580 && cloud()[0] === 1600 && pending(sA) === 1);
    await cycle(A);
    ok('Test 3b: back online → cloud = RM1,580, nothing pending', cloud()[0] === 1580 && amt(A) === 1580 && pending(sA) === 0);
    setAmt(A, 1600, at(4)); await cycle(A);
    let tabA = dev(sA, JSON.parse(sA.getItem('app'))), tabB = dev(sA, JSON.parse(sA.getItem('app')));
    setAmt(tabA, 1580, at(5));
    await cycle(tabB);
    ok('Test 4a: stale Tab B (RM1,600) syncs first → Tab A’s RM1,580 is kept', JSON.parse(sA.getItem('app')).debts[0].monthlyPayment === 1580 && pending(sA) === 1 && cloud()[0] === 1600);
    await cycle(tabA); await cycle(tabB);
    ok('Test 4b: after both sync → cloud RM1,580 and Tab B updated to RM1,580', cloud()[0] === 1580 && amt(tabB) === 1580 && amt(tabA) === 1580);
    setAmt(tabA, 1570, at(6));
    change(tabB, p => ({ payments: [...p.payments, { id: 'PAY-0001', debtId: 'DEBT-0001', date: '2026-10-01', amount: 800, method: 'Bank Transfer' }] }));
    { const st = JSON.parse(sA.getItem('app')); ok('Test 4c: stale tab saving its own change cannot revert the other tab’s edit', st.debts[0].monthlyPayment === 1570 && st.payments.length === 1); }
    A = dev(sA); await cycle(A);
    const sC = mem(); sC.setItem('app', JSON.stringify({ debts: [], payments: [], borrowings: [], settlements: [] }));
    let C = dev(sC); await cycle(C);
    ok('Second device downloads RM1,570 + the payment (no duplicates)', amt(C) === 1570 && C.data.payments.length === 1 && cloud().length === 1 && db.T.payments.length === 1);
    setAmt(A, 1590, at(7)); setAmt(C, 1560, at(8)); await cycle(C); await cycle(A);
    ok('Newest edit wins: later edit on device C beats older unsynced edit on A', amt(A) === 1560 && cloud()[0] === 1560 && pending(sA) === 0);
    setAmt(C, 1550, at(9)); setAmt(A, 1545, at(10)); await cycle(C); await cycle(A); await cycle(C);
    ok('Newest edit wins: later edit on A beats C, C updates', cloud()[0] === 1545 && amt(C) === 1545 && amt(A) === 1545);
    setAmt(A, 1530, at(11)); setAmt(C, 1520, at(12)); await cycle(C);
    { const r = await A.s.pull(A.data, {}, {}); setAmt(A, 1510, at(13)); const ap = MDTSync.applyChanges(A.data, r.changes, MDTSync.readDirty(sA)); if (ap) A.data = { ...A.data, ...ap }; }
    ok('Edit made while a sync is running is not lost', amt(A) === 1510);
    await cycle(A);
    ok('…and it reaches the cloud on the next sync', cloud()[0] === 1510);
    change(A, p => ({ payments: [] })); await cycle(A); await cycle(C);
    ok('Deleting a payment soft-deletes it in the cloud and on the other device', db.T.payments[0].deleted_at && C.data.payments.length === 0 && db.T.payments.length === 1);
    change(A, p => ({ payments: [{ id: 'PAY-0002', debtId: 'DEBT-0001', date: '2026-10-02', amount: 742.35, method: 'Cash' }] })); await cycle(A);
    const X = dev(sA, { ...A.data, payments: [] }); await cycle(X);
    ok('A stale copy missing a record does not delete it from the cloud', db.T.payments.filter(p => !p.deleted_at).length === 1 && X.data.payments.length === 1);
    ok('Payment stays its original amount in the cloud', db.T.payments.find(p => !p.deleted_at).amount === 742.35);
    return T;
  };
  MDTSync._internals = { toRow, fromRow, rowHash, stable };
  window.MDTSync = MDTSync;
})();
