import { openDB } from 'idb';

// This is the local-first layer. Every write from the UI lands here FIRST,
// synchronously, before any network call. The UI never waits on Supabase.
//
// Three tables, three different sync strategies (this is the design we
// worked out — worth keeping this comment as the "why" doesn't live
// anywhere else):
//
//   menu_items  -> mutable, single-editor, low frequency -> last-write-wins via updated_at
//   inventory   -> mutable, MANY concurrent writers        -> synced as DELTAS, never overwrites
//   orders      -> append-only, one owner (the terminal that created it) -> insert-once, idempotent on uuid

const DB_NAME = 'bar-pos';
const DB_VERSION = 3; // bumped when `tables` and `open_carts` were added

let _dbInstance = null;

export async function getDB() {
  if (_dbInstance) return _dbInstance;

  _dbInstance = await openDB(DB_NAME, DB_VERSION, {
    upgrade(db) {
      // menu_items: id is a UUID we generate client-side, so it's stable
      // whether the item was created online or offline.
      if (!db.objectStoreNames.contains('menu_items')) {
        const store = db.createObjectStore('menu_items', { keyPath: 'id' });
        store.createIndex('synced', 'synced');
      }

      // inventory: keyed by menu_item_id (1 row per item). We store the
      // LOCAL view of stock (for instant UI reads) plus a queue of
      // pending deltas that haven't synced yet.
      if (!db.objectStoreNames.contains('inventory')) {
        const store = db.createObjectStore('inventory', { keyPath: 'menu_item_id' });
        store.createIndex('synced', 'synced');
      }

      // pending_deltas: append-only log of "apply -N to item X" operations.
      // This is what actually gets synced for inventory — never the
      // absolute stock number. Cleared once confirmed applied server-side.
      if (!db.objectStoreNames.contains('pending_deltas')) {
        db.createObjectStore('pending_deltas', { keyPath: 'id' });
      }

      // orders: append-only. Each order has a client-generated UUID so
      // re-sending after a dropped connection is a safe no-op server-side.
      if (!db.objectStoreNames.contains('orders')) {
        const store = db.createObjectStore('orders', { keyPath: 'id' });
        store.createIndex('synced', 'synced');
      }

      // settings: a SINGLETON row (always keyed 'main') — the bar's own
      // name/location/tax rate. Same conflict rule as menu_items
      // (last-write-wins on updated_at), since only an owner edits this,
      // rarely, one device at a time.
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'id' });
      }

      // tables: fixed list (Table 1, Table 2, ...). Local-only for now —
      // not synced to Supabase, so "occupied" status is per-terminal.
      // Known limitation: a second terminal won't see this terminal's
      // open tables. Fine for a single-terminal bar; would need syncing
      // (same LWW pattern as menu_items) if multiple terminals need a
      // shared live view of table status.
      if (!db.objectStoreNames.contains('tables')) {
        db.createObjectStore('tables', { keyPath: 'id' });
      }

      // open_carts: one row per table holding its in-progress order.
      // Persisted (not just React state) so a refresh mid-shift doesn't
      // lose a half-built order for some other table.
      if (!db.objectStoreNames.contains('open_carts')) {
        db.createObjectStore('open_carts', { keyPath: 'table_id' });
      }
    },
    // Fires on THIS tab's existing connection when another tab/window
    // tries to open a newer version. Without closing here, that other
    // tab's upgrade silently blocks forever and every DB call there fails.
    blocking() {
      _dbInstance?.close();
      _dbInstance = null;
    },
    // Fires on the tab trying to upgrade, if an older connection (in
    // another tab) hasn't closed yet. Surface this clearly instead of
    // failing silently — this was the "Business Info form is blank" bug.
    blocked() {
      console.warn(
        '[bar-pos] IndexedDB upgrade is blocked by another open tab of this app. ' +
        'Close all other tabs/windows of this app and reload this one.'
      );
    },
  });

  return _dbInstance;
}

// ---------- Menu ----------

export async function upsertMenuItem(item) {
  const db = await getDB();
  const record = { unlimited: false, ...item, updated_at: Date.now(), synced: false };
  await db.put('menu_items', record);
  return record;
}

export async function getAllMenuItems() {
  const db = await getDB();
  const all = await db.getAll('menu_items');
  return all.filter((item) => !item.deleted);
}

// Sync needs to see deleted rows too (to push the tombstone up and
// recognize remote tombstones pulled down) — normal UI code should use
// getAllMenuItems() above, which filters them out.
export async function getAllMenuItemsIncludingDeleted() {
  const db = await getDB();
  return db.getAll('menu_items');
}

// Soft delete: mark the row deleted rather than removing it. A hard
// local delete has no way to tell other devices "this is gone" — the
// next sync would just see "missing locally" and re-create it from the
// still-existing remote row. Marking `deleted: true` turns the delete
// into a normal field change that syncs (and can propagate to other
// devices) the same way a price or name edit does.
export async function deleteMenuItem(id) {
  const db = await getDB();
  const existing = await db.get('menu_items', id);
  if (!existing) return;
  await db.put('menu_items', { ...existing, deleted: true, updated_at: Date.now(), synced: false });
}

// ---------- Inventory ----------

export async function getInventory() {
  const db = await getDB();
  return db.getAll('inventory');
}

// Sets the STARTING stock for a brand-new tracked item. This goes through
// the same delta mechanism as sales/adjustments (queues a +N pending
// delta) instead of writing the local row directly — a direct write was
// the bug: it never told Supabase this item's stock existed at all, so
// the next sync pull could silently overwrite it with a missing/stale
// remote value. Routing it through applyStockDelta means Supabase's
// row gets created correctly the first time it syncs.
export async function setInitialStock(menuItemId, quantity) {
  if (quantity > 0) {
    await applyStockDelta(menuItemId, quantity, 'initial_stock');
  }
}

// The ONLY way stock should change. Never write an absolute number here —
// always a signed delta. Negative for sales, positive for restocks/manual
// corrections. This is what makes concurrent terminals safe to merge.
export async function applyStockDelta(menuItemId, delta, reason) {
  const db = await getDB();
  const tx = db.transaction(['inventory', 'pending_deltas'], 'readwrite');

  const current = await tx.objectStore('inventory').get(menuItemId);
  const newStock = (current?.stock ?? 0) + delta;
  await tx.objectStore('inventory').put({
    menu_item_id: menuItemId,
    stock: newStock,
    synced: false,
  });

  await tx.objectStore('pending_deltas').add({
    id: crypto.randomUUID(),
    menu_item_id: menuItemId,
    delta,
    reason, // 'sale' | 'manual_adjustment' | 'restock'
    created_at: Date.now(),
  });

  await tx.done;
  return newStock;
}

export async function getPendingDeltas() {
  const db = await getDB();
  return db.getAll('pending_deltas');
}

export async function clearPendingDelta(id) {
  const db = await getDB();
  await db.delete('pending_deltas', id);
}

// ---------- Orders ----------

export async function createOrder(order) {
  const database = await getDB();
  const record = {
    ...order,
    id: crypto.randomUUID(),
    created_at: Date.now(),
    synced: false,
  };
  await database.put('orders', record);
  return record;
}

// Wraps the order insert + every stock delta it causes into a SINGLE
// IndexedDB transaction. Without this, a crash mid-checkout could leave
// an order recorded with stock never deducted (or the reverse).
export async function createOrderWithInventoryDeltas(order, deltas) {
  const database = await getDB();
  const record = {
    ...order,
    id: crypto.randomUUID(),
    created_at: Date.now(),
    synced: false,
  };

  const tx = database.transaction(['orders', 'inventory', 'pending_deltas'], 'readwrite');
  await tx.objectStore('orders').put(record);

  for (const delta of deltas) {
    const current = await tx.objectStore('inventory').get(delta.menu_item_id);
    const newStock = (current?.stock ?? 0) + delta.delta;
    await tx.objectStore('inventory').put({
      menu_item_id: delta.menu_item_id,
      stock: newStock,
      synced: false,
    });

    await tx.objectStore('pending_deltas').add({
      id: crypto.randomUUID(),
      menu_item_id: delta.menu_item_id,
      delta: delta.delta,
      reason: delta.reason,
      created_at: Date.now(),
    });
  }

  await tx.done;
  return record;
}

export async function getAllOrders() {
  const db = await getDB();
  return db.getAll('orders');
}

export async function deleteOrderAndRestoreInventory(orderId) {
  const database = await getDB();
  const tx = database.transaction(['orders', 'inventory', 'pending_deltas'], 'readwrite');
  const order = await tx.objectStore('orders').get(orderId);

  if (!order) {
    await tx.done;
    return false;
  }

  for (const item of order.items || []) {
    if (item.unlimited || !item.menu_item_id) continue;

    const current = await tx.objectStore('inventory').get(item.menu_item_id);
    const quantity = Number(item.qty || 0);
    await tx.objectStore('inventory').put({
      menu_item_id: item.menu_item_id,
      stock: (current?.stock ?? 0) + quantity,
      synced: false,
    });
    await tx.objectStore('pending_deltas').add({
      id: crypto.randomUUID(),
      menu_item_id: item.menu_item_id,
      delta: quantity,
      reason: 'sale_reversal',
      created_at: Date.now(),
    });
  }

  await tx.objectStore('orders').delete(orderId);
  await tx.done;
  return true;
}

export async function markSynced(storeName, id) {
  const db = await getDB();
  const record = await db.get(storeName, id);
  if (record) {
    record.synced = true;
    await db.put(storeName, record);
  }
}

// ---------- Settings (singleton) ----------

const SETTINGS_ID = 'main';

export async function getSettings() {
  const db = await getDB();
  const existing = await db.get('settings', SETTINGS_ID);
  return (
    existing || {
      id: SETTINGS_ID,
      bar_name: 'My Bar',
      address: '',
      phone: '',
      currency: '₹',
      tax_rate: 0.05,
      receipt_footer: 'Thank you!',
      updated_at: 0,
      synced: true, // nothing to sync until the owner actually edits it
    }
  );
}

export async function updateSettings(changes) {
  const db = await getDB();
  const current = await getSettings();
  const record = { ...current, ...changes, id: SETTINGS_ID, updated_at: Date.now(), synced: false };
  await db.put('settings', record);
  return record;
}

// ---------- Tables ----------

let _seedingTables = null;

export async function getTables() {
  const database = await getDB();
  const all = await database.getAll('tables');
  const active = all.filter((t) => !t.deleted);
  if (all.length > 0) return active;

  // Two near-simultaneous loadAll() calls at startup (App.jsx's mount
  // effect + sync.js's immediate first runSync()) can both see an empty
  // `tables` store and each try to seed their own fresh batch. This
  // guard makes every concurrent caller await the SAME single seed.
  //
  // Also: seed with DETERMINISTIC ids (table-1, table-2, ...) rather
  // than random UUIDs. A second device, even before its first sync,
  // then already agrees on what "Table 2" refers to — random IDs would
  // make every device's "Table 2" a completely unrelated record,
  // which was the root cause of one device's table orders never
  // showing up on another.
  if (!_seedingTables) {
    _seedingTables = (async () => {
      const defaults = Array.from({ length: 8 }, (_, i) => ({
        id: `table-${i + 1}`,
        name: `Table ${i + 1}`,
        updated_at: Date.now(),
        deleted: false,
        synced: false,
      }));
      const tx = database.transaction('tables', 'readwrite');
      for (const t of defaults) await tx.objectStore('tables').put(t);
      await tx.done;
      return defaults;
    })();
  }
  return _seedingTables;
}

export async function getAllTablesIncludingDeleted() {
  const database = await getDB();
  return database.getAll('tables');
}

export async function addTable(name) {
  const database = await getDB();
  const table = {
    id: crypto.randomUUID(),
    name,
    updated_at: Date.now(),
    deleted: false,
    synced: false,
  };
  await database.put('tables', table);
  return table;
}

// Soft delete, same reasoning as menu items: a hard local delete gives
// other devices no way to know the table is gone.
export async function deleteTable(id) {
  const database = await getDB();
  const existing = await database.get('tables', id);
  if (!existing) return;
  await database.put('tables', { ...existing, deleted: true, updated_at: Date.now(), synced: false });
}

// ---------- Open carts (one per table, persisted so a refresh doesn't
// lose an in-progress order, AND now synced so other devices see it) ----------

export async function getAllOpenCarts() {
  const database = await getDB();
  return database.getAll('open_carts');
}

export async function setOpenCart(tableId, cart) {
  const database = await getDB();
  await database.put('open_carts', {
    table_id: tableId,
    cart,
    updated_at: Date.now(),
    synced: false,
  });
}

// Clearing a table's cart (e.g. after checkout) writes an EMPTY cart
// rather than deleting the local row outright. A hard local delete
// leaves the old, non-empty remote row untouched — the next sync on
// another device would then pull that stale remote cart back down,
// resurrecting an order that was already checked out. Writing an empty
// cart (with a fresh updated_at) propagates the "this table is now
// clear" fact the same way any other change does.
export async function clearOpenCart(tableId) {
  await setOpenCart(tableId, []);
}

// ---------- Full DB export/import (last-resort manual backup, kept
// as a safety net even though Supabase sync is now the primary backup) ----------

export async function exportAllData() {
  const db = await getDB();
  const [menu_items, inventory, orders, pending_deltas] = await Promise.all([
    db.getAll('menu_items'),
    db.getAll('inventory'),
    db.getAll('orders'),
    db.getAll('pending_deltas'),
  ]);
  return { menu_items, inventory, orders, pending_deltas, exported_at: new Date().toISOString() };
}

export async function importAllData(data) {
  const db = await getDB();
  const tx = db.transaction(['menu_items', 'inventory', 'orders', 'pending_deltas'], 'readwrite');
  for (const item of data.menu_items || []) await tx.objectStore('menu_items').put(item);
  for (const item of data.inventory || []) await tx.objectStore('inventory').put(item);
  for (const item of data.orders || []) await tx.objectStore('orders').put(item);
  for (const item of data.pending_deltas || []) await tx.objectStore('pending_deltas').put(item);
  await tx.done;
}
