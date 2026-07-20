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
const DB_VERSION = 2; // bumped when the `settings` store was added

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
  const record = { ...item, updated_at: Date.now(), synced: false };
  await db.put('menu_items', record);
  return record;
}

export async function getAllMenuItems() {
  const db = await getDB();
  return db.getAll('menu_items');
}

export async function deleteMenuItem(id) {
  const db = await getDB();
  await db.delete('menu_items', id);
}

// ---------- Inventory ----------

export async function getInventory() {
  const db = await getDB();
  return db.getAll('inventory');
}

export async function setInitialStock(menuItemId, quantity) {
  const db = await getDB();
  await db.put('inventory', { menu_item_id: menuItemId, stock: quantity, synced: false });
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
  const db = await getDB();
  const record = {
    ...order,
    id: crypto.randomUUID(),
    created_at: Date.now(),
    synced: false,
  };
  await db.put('orders', record);
  return record;
}

export async function createOrderWithInventoryDeltas(order, deltas) {
  const db = await getDB();
  const record = {
    ...order,
    id: crypto.randomUUID(),
    created_at: Date.now(),
    synced: false,
  };

  const tx = db.transaction(['orders', 'inventory', 'pending_deltas'], 'readwrite');
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
