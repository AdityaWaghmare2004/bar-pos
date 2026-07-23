import { supabase, hasSupabaseConfig } from './supabase';
import { usePosStore } from '../store/posStore';
import {
  getAllMenuItems,
  getAllMenuItemsIncludingDeleted,
  getAllOrders,
  getPendingDeltas,
  clearPendingDelta,
  markSynced,
  getSettings,
  getDB,
} from './db';

let syncing = false;

export async function runSync() {
  if (syncing) return; // don't overlap runs
  if (!navigator.onLine || !hasSupabaseConfig()) return;
  syncing = true;

  let inventoryChanged = false;
  let menuChanged = false;
  let settingsChanged = false;

  try {
    await syncOrders(); // append-only, insert-once
    inventoryChanged = await syncInventory(); // deltas, never overwrite
    menuChanged = await syncMenuItems(); // bidirectional menu item sync
    settingsChanged = await syncSettings(); // bidirectional settings sync

    if (inventoryChanged || menuChanged || settingsChanged) {
      await usePosStore.getState().loadAll();
    }
  } catch (err) {
    console.warn('sync failed, will retry:', err.message);
  } finally {
    syncing = false;
  }
}

async function syncOrders() {
  const orders = await getAllOrders();
  const unsynced = orders.filter((o) => !o.synced);
  if (unsynced.length === 0) return;

  const rows = unsynced.map((o) => ({
    id: o.id,
    items: o.items,
    total: o.total,
    created_at: new Date(o.created_at).toISOString(),
    terminal_id: o.terminal_id,
    table_id: o.table_id,
    table_name: o.table_name,
  }));

  // upsert + ignoreDuplicates makes a re-sent order after a dropped
  // connection a safe no-op — it can never double-count revenue.
  const { error } = await supabase
    .from('orders')
    .upsert(rows, { onConflict: 'id', ignoreDuplicates: true });

  if (error) throw error;
  for (const o of unsynced) await markSynced('orders', o.id);
}

async function syncInventory() {
  const deltas = await getPendingDeltas();
  let changed = false;

  // Push: apply every local delta atomically server-side.
  for (const d of deltas) {
    const { error } = await supabase.rpc('apply_inventory_delta', {
      p_menu_item_id: d.menu_item_id,
      p_delta: d.delta,
    });
    if (error) throw error;
    await clearPendingDelta(d.id);
    changed = true;
  }

  // Pull: fetch the merged, authoritative stock counts (now reflecting
  // every device's deltas, not just this one) and overwrite local
  // values. Without this step, a stock change made on one device never
  // shows up on another — each device only ever saw its OWN deltas
  // applied locally, never anyone else's.
  const { data: remoteInventory, error: pullError } = await supabase
    .from('inventory')
    .select('*');
  if (pullError) throw pullError;

  if (remoteInventory?.length > 0) {
    const db = await getDB();
    const tx = db.transaction('inventory', 'readwrite');
    for (const row of remoteInventory) {
      const local = await tx.objectStore('inventory').get(row.menu_item_id);
      if (local?.stock !== row.stock) {
        await tx.objectStore('inventory').put({
          menu_item_id: row.menu_item_id,
          stock: row.stock,
          synced: true,
        });
        changed = true;
      }
    }
    await tx.done;
  }

  return changed;
}

async function syncMenuItems() {
  const items = await getAllMenuItemsIncludingDeleted();
  const db = await getDB();

  const { data: remoteItems, error: pullError } = await supabase
    .from('menu_items')
    .select('*');

  if (pullError) throw pullError;

  let baseChangeMade = false;

  if (remoteItems?.length > 0) {
    const tx = db.transaction('menu_items', 'readwrite');
    for (const remoteItem of remoteItems) {
      const localItem = items.find((item) => item.id === remoteItem.id);
      const remoteUpdatedAt = new Date(remoteItem.updated_at).getTime();

      if (!localItem || remoteUpdatedAt > (localItem.updated_at || 0)) {
        await tx.objectStore('menu_items').put({
          id: remoteItem.id,
          name: remoteItem.name,
          price: Number(remoteItem.price),
          category: remoteItem.category,
          deleted: Boolean(remoteItem.deleted),
          updated_at: remoteUpdatedAt,
          synced: true,
        });
        baseChangeMade = true;
      }
    }
    await tx.done;
  }

  const unsynced = items.filter((i) => !i.synced);
  if (unsynced.length > 0) {
    for (const item of unsynced) {
      const { error } = await supabase.rpc('upsert_menu_item', {
        p_id: item.id,
        p_name: item.name,
        p_price: item.price,
        p_category: item.category ?? null,
        p_deleted: Boolean(item.deleted),
        p_updated_at: new Date(item.updated_at).toISOString(),
      });
      if (error) throw error;
      await markSynced('menu_items', item.id);
    }
    baseChangeMade = true;
  }

  return baseChangeMade;
}

async function syncSettings() {
  const localSettings = await getSettings();
  const db = await getDB();

  const { data: remoteSettings, error: pullError } = await supabase
    .from('bar_settings')
    .select('*')
    .eq('id', 'main')
    .maybeSingle();

  if (pullError) throw pullError;

  let settingsChanged = false;

  if (remoteSettings) {
    const remoteUpdatedAt = new Date(remoteSettings.updated_at).getTime();
    if (remoteUpdatedAt > localSettings.updated_at) {
      await db.put('settings', {
        id: 'main',
        bar_name: remoteSettings.bar_name,
        address: remoteSettings.address,
        phone: remoteSettings.phone,
        currency: remoteSettings.currency,
        tax_rate: Number(remoteSettings.tax_rate),
        receipt_footer: remoteSettings.receipt_footer,
        updated_at: remoteUpdatedAt,
        synced: true,
      });
      settingsChanged = true;
    }
  }

  if (!localSettings.synced) {
    const { error: pushError } = await supabase.rpc('upsert_bar_settings', {
      p_bar_name: localSettings.bar_name,
      p_address: localSettings.address,
      p_phone: localSettings.phone,
      p_currency: localSettings.currency,
      p_tax_rate: localSettings.tax_rate,
      p_receipt_footer: localSettings.receipt_footer,
      p_updated_at: new Date(localSettings.updated_at).toISOString(),
    });
    if (pushError) throw pushError;

    const updated = { ...localSettings, synced: true };
    await db.put('settings', updated);
    settingsChanged = true;
  }

  return settingsChanged;
}

// Call once at app startup: sync immediately, then on an interval, and
// whenever the browser regains connectivity.
export function startSyncLoop(intervalMs = 15000) {
  runSync();
  const interval = setInterval(runSync, intervalMs);
  window.addEventListener('online', runSync);
  return () => {
    clearInterval(interval);
    window.removeEventListener('online', runSync);
  };
}
