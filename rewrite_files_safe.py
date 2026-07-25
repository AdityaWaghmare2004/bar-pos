from pathlib import Path

files = {
    'src/lib/db.js': """import { openDB } from 'idb';

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
      if (!db.objectStoreNames.contains('menu_items')) {
        const store = db.createObjectStore('menu_items', { keyPath: 'id' });
        store.createIndex('synced', 'synced');
      }

      if (!db.objectStoreNames.contains('inventory')) {
        const store = db.createObjectStore('inventory', { keyPath: 'menu_item_id' });
        store.createIndex('synced', 'synced');
      }

      if (!db.objectStoreNames.contains('pending_deltas')) {
        db.createObjectStore('pending_deltas', { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains('orders')) {
        const store = db.createObjectStore('orders', { keyPath: 'id' });
        store.createIndex('synced', 'synced');
      }

      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings', { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains('tables')) {
        db.createObjectStore('tables', { keyPath: 'id' });
      }

      if (!db.objectStoreNames.contains('open_carts')) {
        db.createObjectStore('open_carts', { keyPath: 'table_id' });
      }
    },
    blocking() {
      _dbInstance?.close();
      _dbInstance = null;
    },
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

export async function getAllMenuItemsIncludingDeleted() {
  const db = await getDB();
  return db.getAll('menu_items');
}

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

export async function setInitialStock(menuItemId, quantity) {
  if (quantity > 0) {
    await applyStockDelta(menuItemId, quantity, 'initial_stock');
  }
}

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
    reason,
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
      synced: true,
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
  const tables = await database.getAll('tables');
  if (tables.length > 0) return tables;

  if (!_seedingTables) {
    _seedingTables = (async () => {
      const defaults = Array.from({ length: 8 }, (_, i) => ({
        id: crypto.randomUUID(),
        name: `Table ${i + 1}`,
      }));
      const tx = database.transaction('tables', 'readwrite');
      for (const t of defaults) await tx.objectStore('tables').put(t);
      await tx.done;
      return defaults;
    })();
  }
  return _seedingTables;
}

export async function addTable(name) {
  const database = await getDB();
  const table = { id: crypto.randomUUID(), name };
  await database.put('tables', table);
  return table;
}

export async function deleteTable(id) {
  const database = await getDB();
  await database.delete('tables', id);
}

// ---------- Open carts ----------

export async function getAllOpenCarts() {
  const database = await getDB();
  return database.getAll('open_carts');
}

export async function setOpenCart(tableId, cart) {
  const database = await getDB();
  await database.put('open_carts', { table_id: tableId, cart, updated_at: Date.now() });
}

export async function clearOpenCart(tableId) {
  const database = await getDB();
  await database.delete('open_carts', tableId);
}

// ---------- Full DB export/import ----------

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
""",
    'src/lib/sync.js': """import { supabase, hasSupabaseConfig } from './supabase';
import { usePosStore } from '../store/posStore';
import {
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
  if (syncing) return;
  if (!navigator.onLine || !hasSupabaseConfig()) return;
  syncing = true;

  let inventoryChanged = false;
  let menuChanged = false;
  let settingsChanged = false;

  try {
    await syncOrders();
    inventoryChanged = await syncInventory();
    menuChanged = await syncMenuItems();
    settingsChanged = await syncSettings();

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

  const { error } = await supabase
    .from('orders')
    .upsert(rows, { onConflict: 'id', ignoreDuplicates: true });

  if (error) throw error;
  for (const o of unsynced) await markSynced('orders', o.id);
}

async function syncInventory() {
  const deltas = await getPendingDeltas();
  let changed = false;

  for (const d of deltas) {
    const { error } = await supabase.rpc('apply_inventory_delta', {
      p_menu_item_id: d.menu_item_id,
      p_delta: d.delta,
    });
    if (error) throw error;
    await clearPendingDelta(d.id);
    changed = true;
  }

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
          updated_at: remoteUpdatedAt,
          deleted: remoteItem.deleted ?? false,
          unlimited: remoteItem.unlimited ?? false,
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
        p_updated_at: new Date(item.updated_at).toISOString(),
        p_deleted: item.deleted ?? false,
        p_unlimited: item.unlimited ?? false,
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

export function startSyncLoop(intervalMs = 15000) {
  runSync();
  const interval = setInterval(runSync, intervalMs);
  window.addEventListener('online', runSync);
  return () => {
    clearInterval(interval);
    window.removeEventListener('online', runSync);
  };
}
""",
    'src/store/posStore.js': """import { create } from 'zustand';
import * as db from '../lib/db';

const TERMINAL_ID = (() => {
  let id = localStorage.getItem('terminal_id');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('terminal_id', id);
  }
  return id;
})();

export const usePosStore = create((set, get) => ({
  menuItems: [],
  inventory: [],
  orders: [],
  settings: null,
  tables: [],
  activeTableId: null,
  cartsByTable: {},

  async loadAll() {
    try {
      const [menuItems, inventory, orders, settings, tables, openCarts] = await Promise.all([
        db.getAllMenuItems(),
        db.getInventory(),
        db.getAllOrders(),
        db.getSettings(),
        db.getTables(),
        db.getAllOpenCarts(),
      ]);

      const cartsByTable = {};
      for (const oc of openCarts) cartsByTable[oc.table_id] = oc.cart;

      set((state) => ({
        menuItems, inventory, orders, settings, tables, cartsByTable,
        activeTableId: state.activeTableId ?? tables[0]?.id ?? null,
      }));
    } catch (err) {
      console.error('[bar-pos] loadAll failed — likely a blocked IndexedDB upgrade. Close other tabs of this app and reload.', err);
    }
  },

  async updateSettings(changes) {
    const settings = await db.updateSettings(changes);
    set({ settings });
  },

  async addMenuItem({ name, price, category, initialStock, unlimited }) {
    const item = await db.upsertMenuItem({ id: crypto.randomUUID(), name, price, category, unlimited: !!unlimited });
    if (!unlimited) {
      await db.setInitialStock(item.id, initialStock ?? 0);
    }
    await get().loadAll();
  },

  async editMenuItem(id, changes) {
    const existing = get().menuItems.find((m) => m.id === id);
    await db.upsertMenuItem({ ...existing, ...changes, id });
    await get().loadAll();
  },

  async deleteMenuItem(id) {
    await db.deleteMenuItem(id);
    await get().loadAll();
  },

  async adjustStock(menuItemId, delta, reason = 'manual_adjustment') {
    await db.applyStockDelta(menuItemId, delta, reason);
    await get().loadAll();
  },

  async addTable(name) {
    await db.addTable(name);
    await get().loadAll();
  },

  async deleteTable(id) {
    await db.deleteTable(id);
    await db.clearOpenCart(id);
    set((state) => {
      const carts = { ...state.cartsByTable };
      delete carts[id];
      return {
        cartsByTable: carts,
        activeTableId: state.activeTableId === id ? null : state.activeTableId,
      };
    });
    await get().loadAll();
  },

  setActiveTable(tableId) {
    set({ activeTableId: tableId });
  },

  addToCart(item) {
    const tableId = get().activeTableId;
    if (!tableId) return;

    set((state) => {
      const cart = state.cartsByTable[tableId] || [];
      const existing = cart.find((c) => c.menu_item_id === item.id);

      if (!item.unlimited) {
        const stock = state.inventory.find((i) => i.menu_item_id === item.id)?.stock ?? 0;
        const currentQty = existing?.qty ?? 0;
        const available = Math.max(stock - currentQty, 0);
        if (available <= 0) return state;
      }

      const newCart = existing
        ? cart.map((c) => (c.menu_item_id === item.id ? { ...c, qty: c.qty + 1 } : c))
        : [...cart, { menu_item_id: item.id, name: item.name, price: item.price, qty: 1, unlimited: !!item.unlimited }];

      db.setOpenCart(tableId, newCart);
      return { cartsByTable: { ...state.cartsByTable, [tableId]: newCart } };
    });
  },

  updateCartQty(menuItemId, qty) {
    const tableId = get().activeTableId;
    if (!tableId) return;

    set((state) => {
      const cart = state.cartsByTable[tableId] || [];
      let newCart;
      if (qty <= 0) {
        newCart = cart.filter((c) => c.menu_item_id !== menuItemId);
      } else {
        const line = cart.find((c) => c.menu_item_id === menuItemId);
        let clampedQty = qty;
        if (!line?.unlimited) {
          const stock = state.inventory.find((i) => i.menu_item_id === menuItemId)?.stock ?? 0;
          clampedQty = Math.min(qty, stock);
        }
        newCart = cart.map((c) => (c.menu_item_id === menuItemId ? { ...c, qty: clampedQty } : c));
      }

      db.setOpenCart(tableId, newCart);
      return { cartsByTable: { ...state.cartsByTable, [tableId]: newCart } };
    });
  },

  clearCart() {
    const tableId = get().activeTableId;
    if (!tableId) return;
    db.clearOpenCart(tableId);
    set((state) => ({ cartsByTable: { ...state.cartsByTable, [tableId]: [] } }));
  },

  cartTotal() {
    const tableId = get().activeTableId;
    const cart = get().cartsByTable[tableId] || [];
    const taxRate = get().settings?.tax_rate ?? 0.05;
    const subtotal = cart.reduce((sum, c) => sum + c.price * c.qty, 0);
    const tax = subtotal * taxRate;
    return { subtotal, tax, total: subtotal + tax };
  },

  async checkout() {
    const tableId = get().activeTableId;
    if (!tableId) return null;
    const cart = get().cartsByTable[tableId] || [];
    if (cart.length === 0) return null;

    const table = get().tables.find((t) => t.id === tableId);
    const { subtotal, tax, total } = get().cartTotal();

    const order = await db.createOrderWithInventoryDeltas(
      {
        items: cart,
        subtotal,
        tax,
        total,
        terminal_id: TERMINAL_ID,
        table_id: tableId,
        table_name: table?.name ?? null,
      },
      cart
        .filter((line) => !line.unlimited)
        .map((line) => ({
          menu_item_id: line.menu_item_id,
          delta: -line.qty,
          reason: 'sale',
        }))
    );

    await db.clearOpenCart(tableId);
    set((state) => ({ cartsByTable: { ...state.cartsByTable, [tableId]: [] } }));
    await get().loadAll();
    return order;
  },
}));

export { TERMINAL_ID };
""",
    'src/components/POSScreen.jsx': """import { useEffect, useMemo, useState } from 'react';
import { usePosStore } from '../store/posStore';
import Receipt from './Receipt';

const EMPTY_CART = [];

export default function POSScreen() {
  const menuItems = usePosStore((s) => s.menuItems);
  const inventory = usePosStore((s) => s.inventory);
  const tables = usePosStore((s) => s.tables);
  const setActiveTable = usePosStore((s) => s.setActiveTable);
  const cartsByTable = usePosStore((s) => s.cartsByTable);
  const activeTableId = usePosStore((s) => s.activeTableId);
  const cart = useMemo(
    () => cartsByTable?.[activeTableId] ?? EMPTY_CART,
    [cartsByTable, activeTableId]
  );
  const addToCart = usePosStore((s) => s.addToCart);
  const updateCartQty = usePosStore((s) => s.updateCartQty);
  const cartTotal = usePosStore((s) => s.cartTotal);
  const checkout = usePosStore((s) => s.checkout);
  const [lastOrder, setLastOrder] = useState(null);
  const [selectedCategory, setSelectedCategory] = useState('All');

  const settings = usePosStore((s) => s.settings);
  const cur = settings?.currency || '₹';
  const stockFor = (id) => inventory.find((i) => i.menu_item_id === id)?.stock ?? 0;
  const cartQtyFor = (id) => cart.find((c) => c.menu_item_id === id)?.qty ?? 0;
  const availableStockFor = (item) =>
    item.unlimited ? Infinity : Math.max(stockFor(item.id) - cartQtyFor(item.id), 0);
  const isTableOccupied = (tableId) => (cartsByTable?.[tableId] || []).length > 0;

  const categories = useMemo(() => {
    const unique = new Set(menuItems.map((item) => item.category || 'Uncategorized'));
    return ['All', ...Array.from(unique)];
  }, [menuItems]);
  const filteredMenuItems = useMemo(
    () => selectedCategory === 'All'
      ? menuItems
      : menuItems.filter((item) => (item.category || 'Uncategorized') === selectedCategory),
    [menuItems, selectedCategory]
  );
  const { subtotal, tax, total } = cartTotal();

  useEffect(() => {
    if (lastOrder) {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          window.print();
        });
      });
    }
  }, [lastOrder]);

  async function handleCheckout() {
    const order = await checkout();
    if (order) {
      setLastOrder(order);
    }
  }

  return (
    <div className="pos-screen">
      <section className="table-bar no-print">
        {tables.map((table) => (
          <button
            key={table.id}
            type="button"
            className={
              'table-chip' +
              (table.id === activeTableId ? ' active' : '') +
              (isTableOccupied(table.id) ? ' occupied' : '')
            }
            onClick={() => setActiveTable(table.id)}
          >
            {table.name}
            {isTableOccupied(table.id) && <span className="occupied-dot" />}
          </button>
        ))}
        {tables.length === 0 && (
          <p className="empty-hint">No tables yet — add some in Settings.</p>
        )}
      </section>

      <section className="menu-controls no-print">
        <div className="category-tabs">
          {categories.map((category) => (
            <button
              key={category}
              type="button"
              className={category === selectedCategory ? 'tab active' : 'tab'}
              onClick={() => setSelectedCategory(category)}
            >
              {category}
            </button>
          ))}
        </div>
      </section>

      <section className="menu-grid no-print">
        {filteredMenuItems.map((item) => {
          const availableStock = availableStockFor(item);
          return (
            <button
              key={item.id}
              className="menu-tile"
              disabled={availableStock <= 0 || !activeTableId}
              onClick={() => addToCart(item)}
            >
              <span className="tile-name">{item.name}</span>
              <span className="tile-price">{cur}{item.price}</span>
              <span className="tile-stock">
                {item.unlimited
                  ? 'Unlimited'
                  : availableStock <= 0 ? 'Out of stock' : `${availableStock} available`}
              </span>
            </button>
          );
        })}
        {filteredMenuItems.length === 0 && (
          <p className="empty-hint">No items in this category.</p>
        )}
      </section>

      <aside className="cart no-print">
        <h2>{tables.find((t) => t.id === activeTableId)?.name || 'Select a table'}</h2>
        {cart.length === 0 && <p className="empty-hint">Cart is empty</p>}
        {cart.map((line) => (
          <div key={line.menu_item_id} className="cart-line">
            <span>{line.name}</span>
            <div className="qty-control">
              <button onClick={() => updateCartQty(line.menu_item_id, line.qty - 1)}>−</button>
              <input
                type="number"
                min="1"
                max={line.unlimited ? undefined : stockFor(line.menu_item_id)}
                value={line.qty}
                onChange={(e) => {
                  const qty = Number(e.target.value);
                  if (!Number.isNaN(qty) && qty >= 1) {
                    updateCartQty(line.menu_item_id, qty);
                  }
                }}
              />
              <button onClick={() => updateCartQty(line.menu_item_id, line.qty + 1)}>+</button>
            </div>
            <span>{cur}{(line.price * line.qty).toFixed(2)}</span>
          </div>
        ))}
        <div className="cart-totals">
          <div><span>Subtotal</span><span>{cur}{subtotal.toFixed(2)}</span></div>
          <div><span>Tax</span><span>{cur}{tax.toFixed(2)}</span></div>
          <div className="grand-total"><span>Total</span><span>{cur}{total.toFixed(2)}</span></div>
        </div>
        <button className="checkout-btn" disabled={cart.length === 0 || !activeTableId} onClick={handleCheckout}>
          Complete Order
        </button>
      </aside>

      {lastOrder && <Receipt order={lastOrder} />}
    </div>
  );
}
""",
    'src/components/MenuScreen.jsx': """import { useState } from 'react';
import { usePosStore } from '../store/posStore';

export default function MenuScreen() {
  const menuItems = usePosStore((s) => s.menuItems);
  const addMenuItem = usePosStore((s) => s.addMenuItem);
  const editMenuItem = usePosStore((s) => s.editMenuItem);
  const deleteMenuItem = usePosStore((s) => s.deleteMenuItem);

  const [form, setForm] = useState({ name: '', price: '', category: '', initialStock: '', unlimited: false });
  const [editingItemId, setEditingItemId] = useState(null);
  const [editDraft, setEditDraft] = useState({ name: '', price: '', category: '' });

  async function handleAdd(e) {
    e.preventDefault();
    if (!form.name || !form.price) return;
    await addMenuItem({
      name: form.name,
      price: parseFloat(form.price),
      category: form.category,
      initialStock: parseInt(form.initialStock || '0', 10),
      unlimited: form.unlimited,
    });
    setForm({ name: '', price: '', category: '', initialStock: '', unlimited: false });
  }

  function startEditing(item) {
    setEditingItemId(item.id);
    setEditDraft({ name: item.name, price: item.price.toString(), category: item.category || '' });
  }

  async function saveEdit(itemId) {
    const updates = {};
    if (editDraft.name.trim() && editDraft.name !== menuItems.find((i) => i.id === itemId)?.name) {
      updates.name = editDraft.name.trim();
    }
    const priceValue = parseFloat(editDraft.price);
    if (!Number.isNaN(priceValue) && priceValue !== menuItems.find((i) => i.id === itemId)?.price) {
      updates.price = priceValue;
    }
    if (editDraft.category !== menuItems.find((i) => i.id === itemId)?.category) {
      updates.category = editDraft.category;
    }

    if (Object.keys(updates).length > 0) {
      await editMenuItem(itemId, updates);
    }
    setEditingItemId(null);
  }

  function cancelEdit() {
    setEditingItemId(null);
  }

  return (
    <div className="menu-screen">
      <h2>Menu Items</h2>
      <form className="menu-form" onSubmit={handleAdd}>
        <input placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <input placeholder="Price" type="number" step="0.01" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
        <input placeholder="Category" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} />
        <label className="unlimited-toggle">
          <input
            type="checkbox"
            checked={form.unlimited}
            onChange={(e) => setForm({ ...form, unlimited: e.target.checked })}
          />
          Unlimited (not tracked)
        </label>
        {!form.unlimited && (
          <input
            placeholder="Initial stock"
            type="number"
            value={form.initialStock}
            onChange={(e) => setForm({ ...form, initialStock: e.target.value })}
          />
        )}
        <button type="submit">Add Item</button>
      </form>

      <table>
        <thead><tr><th>Name</th><th>Price</th><th>Category</th><th>Type</th><th></th></tr></thead>
        <tbody>
          {menuItems.map((item) => (
            <tr key={item.id}>
              <td>
                {editingItemId === item.id ? (
                  <input
                    value={editDraft.name}
                    onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })}
                  />
                ) : (
                  <span>{item.name}</span>
                )}
              </td>
              <td>
                {editingItemId === item.id ? (
                  <input
                    type="number"
                    step="0.01"
                    value={editDraft.price}
                    onChange={(e) => setEditDraft({ ...editDraft, price: e.target.value })}
                  />
                ) : (
                  <span>{item.price}</span>
                )}
              </td>
              <td>
                {editingItemId === item.id ? (
                  <input
                    value={editDraft.category}
                    onChange={(e) => setEditDraft({ ...editDraft, category: e.target.value })}
                  />
                ) : (
                  <span>{item.category}</span>
                )}
              </td>
              <td>{item.unlimited ? 'Unlimited' : 'Tracked'}</td>
              <td>
                {editingItemId === item.id ? (
                  <>
                    <button type="button" onClick={() => saveEdit(item.id)}>Save</button>
                    <button type="button" onClick={cancelEdit}>Cancel</button>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={() => startEditing(item)}>Edit</button>
                    <button type="button" onClick={() => deleteMenuItem(item.id)}>Delete</button>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
""",
    'src/components/InventoryScreen.jsx': """import { usePosStore } from '../store/posStore';

export default function InventoryScreen() {
  const menuItems = usePosStore((s) => s.menuItems);
  const inventory = usePosStore((s) => s.inventory);
  const adjustStock = usePosStore((s) => s.adjustStock);

  const stockFor = (id) => inventory.find((i) => i.menu_item_id === id)?.stock ?? 0;

  return (
    <div className="inventory-screen">
      <h2>Inventory</h2>
      <table>
        <thead>
          <tr><th>Item</th><th>Stock</th><th>Adjust</th></tr>
        </thead>
        <tbody>
          {menuItems.map((item) => (
            <tr key={item.id}>
              <td>{item.name}</td>
              {item.unlimited ? (
                <>
                  <td className="unlimited-label">Unlimited</td>
                  <td className="empty-hint">Not tracked</td>
                </>
              ) : (
                <>
                  <td className={stockFor(item.id) <= 3 ? 'low-stock' : ''}>{stockFor(item.id)}</td>
                  <td>
                    <div className="qty-control">
                      <button onClick={() => adjustStock(item.id, -1)} title="Decrease by 1">−</button>
                      <span>{stockFor(item.id)}</span>
                      <button onClick={() => adjustStock(item.id, 1)} title="Increase by 1">+</button>
                    </div>
                    <button className="restock-btn" onClick={() => adjustStock(item.id, 10)}>
                      +10 Restock
                    </button>
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
      {menuItems.length === 0 && <p className="empty-hint">Add menu items first.</p>}
    </div>
  );
}
""",
    'src/App.css': """:root {
  --ink: #1c1c1c;
  --paper: #fafaf8;
  --line: #ddd;
  --accent: #2f6f4f;
  --danger: #b3432b;
  font-family: 'Segoe UI', system-ui, sans-serif;
  color-scheme: light;
}

* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); }

button, input { color: var(--ink); font-family: inherit; }

.app { max-width: 1100px; margin: 0 auto; padding: 0 16px 40px; }

.app-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 16px 0; border-bottom: 2px solid var(--ink);
}
.app-header h1 { font-size: 1.3rem; margin: 0; color: var(--ink); }
.app-header nav button {
  margin-left: 8px; padding: 8px 14px; border: 1px solid var(--ink);
  background: none; cursor: pointer; border-radius: 4px; color: var(--ink);
}
.app-header nav button.active { background: var(--ink); color: var(--paper); }

.pos-screen { display: grid; grid-template-columns: 1fr 320px; gap: 20px; margin-top: 20px; }

.table-bar {
  grid-column: 1 / -1;
  display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 4px;
}
.table-chip {
  position: relative; padding: 8px 16px; border: 1px solid var(--line);
  border-radius: 20px; background: white; cursor: pointer; font-weight: 500;
  color: var(--ink);
}
.table-chip.active { background: var(--ink); color: white; border-color: var(--ink); }
.table-chip .occupied-dot {
  display: inline-block; width: 7px; height: 7px; border-radius: 50%;
  background: var(--danger); margin-left: 6px; vertical-align: middle;
}
.table-chip.active .occupied-dot { background: #ffb4a2; }
.menu-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 10px; align-content: start;
}
.menu-tile {
  display: flex; flex-direction: column; align-items: flex-start; gap: 4px;
  padding: 12px; border: 1px solid var(--line); border-radius: 8px;
  background: white; cursor: pointer; text-align: left;
}
.menu-tile:disabled { opacity: 0.4; cursor: not-allowed; }
.tile-name { font-weight: 600; }
.tile-price { color: var(--accent); }
.tile-stock { font-size: 0.75rem; color: #888; }

.cart {
  border: 1px solid var(--line); border-radius: 8px; padding: 16px;
  background: white; height: fit-content;
}
.cart-line { display: flex; justify-content: space-between; align-items: center; margin: 8px 0; gap: 8px; }
.qty-control { display: flex; align-items: center; gap: 6px; }
.qty-control button { width: 26px; height: 26px; border-radius: 4px; border: 1px solid var(--line); background: white; cursor: pointer; }
.cart-totals { margin-top: 12px; border-top: 1px solid var(--line); padding-top: 8px; }
.cart-totals div { display: flex; justify-content: space-between; margin: 4px 0; }
.grand-total { font-weight: 700; font-size: 1.1rem; }
.checkout-btn {
  width: 100%; margin-top: 12px; padding: 12px; background: var(--accent);
  color: white; border: none; border-radius: 6px; font-size: 1rem; cursor: pointer;
}
.checkout-btn:disabled { background: #aaa; cursor: not-allowed; }

table { width: 100%; border-collapse: collapse; margin-top: 12px; background: white; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }
.low-stock { color: var(--danger); font-weight: 700; }

.menu-form { display: flex; gap: 8px; flex-wrap: wrap; margin: 12px 0; }
.menu-form input { padding: 8px; border: 1px solid var(--line); border-radius: 4px; }
.menu-form button { padding: 8px 14px; border: none; background: var(--accent); color: white; border-radius: 4px; cursor: pointer; }
.unlimited-toggle { display: flex; align-items: center; gap: 6px; font-size: 0.9rem; }
.unlimited-label { color: var(--accent); font-weight: 600; }
.restock-btn { margin-left: 8px; }

.business-info-card {
  border: 1px solid var(--line); border-radius: 16px; padding: 24px; background: white;
}
.business-info-card h3 { font-size: 1.4rem; margin: 0 0 16px; }
.bar-details-form { display: flex; flex-direction: column; gap: 16px; max-width: 640px; }
.bar-details-form label { display: flex; flex-direction: column; gap: 6px; font-size: 0.95rem; font-weight: 500; }
.bar-details-form input, .bar-details-form textarea {
  padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px;
  color: var(--ink); font-size: 1rem; font-family: inherit; resize: vertical;
}
.bar-details-form .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.bar-details-form button {
  align-self: flex-start; padding: 12px 22px; border: none; border-radius: 10px;
  background: #0f1729; color: white; font-weight: 600; cursor: pointer; font-size: 0.95rem;
}

.empty-hint { color: #888; font-style: italic; }
.status-msg { margin-top: 10px; color: var(--accent); }

.print-only { display: none; }

@media print {
  @page {
    size: 58mm auto;
    margin: 0;
  }

  .no-print { display: none !important; }
  .print-only { display: block; }

  html, body {
    background: #ffffff !important;
    color: #000000 !important;
  }
  .app { max-width: none; padding: 0; margin: 0; background: #ffffff !important; }

  .receipt {
    width: 58mm;
    font-family: 'Courier New', monospace;
    font-size: 11px;
    padding: 4mm;
    background: #ffffff !important;
    color: #000000 !important;
  }
  .receipt * { background: #ffffff !important; color: #000000 !important; }
  .receipt-header { text-align: center; margin-bottom: 6px; }
  .receipt-line { display: flex; justify-content: space-between; }
  .receipt-line.total { font-weight: 700; font-size: 13px; }
  .receipt-footer { text-align: center; margin-top: 8px; }
}
""",
}

for relpath, content in files.items():
    Path(relpath).write_text(content, encoding='utf-8')
    print(f'Wrote {relpath}')
