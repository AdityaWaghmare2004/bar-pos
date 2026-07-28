import { create } from 'zustand';
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

  // Switching an item's tracking type needs special handling:
  // - unlimited -> tracked: there's no existing stock row, so an
  //   initial count must be supplied (defaults to 0 if not given).
  // - tracked -> unlimited: the old inventory row is simply ignored
  //   from then on (harmless to leave behind).
  async setItemTracking(id, { unlimited, initialStock }) {
    const existing = get().menuItems.find((m) => m.id === id);
    await db.upsertMenuItem({ ...existing, id, unlimited });
    if (!unlimited) {
      await db.setInitialStock(id, initialStock ?? 0);
    }
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
