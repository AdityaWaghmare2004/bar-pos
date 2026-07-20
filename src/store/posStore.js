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
  inventory: [], // [{menu_item_id, stock}]
  cart: [], // [{menu_item_id, name, price, qty}]
  orders: [],
  settings: null,

  async loadAll() {
    try {
      const [menuItems, inventory, orders, settings] = await Promise.all([
        db.getAllMenuItems(),
        db.getInventory(),
        db.getAllOrders(),
        db.getSettings(),
      ]);
      set({ menuItems, inventory, orders, settings });
    } catch (err) {
      console.error('[bar-pos] loadAll failed — likely a blocked IndexedDB upgrade. Close other tabs of this app and reload.', err);
    }
  },

  async updateSettings(changes) {
    const settings = await db.updateSettings(changes);
    set({ settings });
  },

  async addMenuItem({ name, price, category, initialStock }) {
    const item = await db.upsertMenuItem({ id: crypto.randomUUID(), name, price, category });
    await db.setInitialStock(item.id, initialStock ?? 0);
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

  addToCart(item) {
    set((state) => {
      const stock = state.inventory.find((i) => i.menu_item_id === item.id)?.stock ?? 0;
      const existing = state.cart.find((c) => c.menu_item_id === item.id);
      const currentQty = existing?.qty ?? 0;
      const available = Math.max(stock - currentQty, 0);
      if (available <= 0) return state;

      if (existing) {
        return {
          cart: state.cart.map((c) =>
            c.menu_item_id === item.id ? { ...c, qty: c.qty + 1 } : c
          ),
        };
      }
      return {
        cart: [
          ...state.cart,
          { menu_item_id: item.id, name: item.name, price: item.price, qty: 1 },
        ],
      };
    });
  },

  updateCartQty(menuItemId, qty) {
    set((state) => {
      if (qty <= 0) {
        return { cart: state.cart.filter((c) => c.menu_item_id !== menuItemId) };
      }

      const stock = state.inventory.find((i) => i.menu_item_id === menuItemId)?.stock ?? 0;
      const clampedQty = Math.min(qty, stock);

      return {
        cart: state.cart.map((c) =>
          c.menu_item_id === menuItemId ? { ...c, qty: clampedQty } : c
        ),
      };
    });
  },

  clearCart() {
    set({ cart: [] });
  },

  cartTotal() {
    const taxRate = get().settings?.tax_rate ?? 0.05;
    const subtotal = get().cart.reduce((sum, c) => sum + c.price * c.qty, 0);
    const tax = subtotal * taxRate;
    return { subtotal, tax, total: subtotal + tax };
  },

  async checkout() {
    const cart = get().cart;
    if (cart.length === 0) return null;
    const { subtotal, tax, total } = get().cartTotal();

    const order = await db.createOrderWithInventoryDeltas(
      {
        items: cart,
        subtotal,
        tax,
        total,
        terminal_id: TERMINAL_ID,
      },
      cart.map((line) => ({
        menu_item_id: line.menu_item_id,
        delta: -line.qty,
        reason: 'sale',
      }))
    );

    set({ cart: [] });
    await get().loadAll();
    return order;
  },
}));

export { TERMINAL_ID };
