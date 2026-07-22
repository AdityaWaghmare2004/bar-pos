import { useEffect, useMemo, useState } from 'react';
import { usePosStore } from '../store/posStore';
import Receipt from './Receipt';

const EMPTY_CART = [];

export default function POSScreen() {
  const menuItems = usePosStore((s) => s.menuItems);
  const inventory = usePosStore((s) => s.inventory);
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
  const availableStockFor = (id) => Math.max(stockFor(id) - cartQtyFor(id), 0);
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
      // Wait for an actual paint before printing. Firing window.print()
      // synchronously here can run before the browser has painted the
      // receipt — especially on slower mobile devices — which is what
      // caused printing/exporting a blank page.
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
          const availableStock = availableStockFor(item.id);
          return (
            <button
              key={item.id}
              className="menu-tile"
              disabled={availableStock <= 0}
              onClick={() => addToCart(item)}
            >
              <span className="tile-name">{item.name}</span>
              <span className="tile-price">{cur}{item.price}</span>
              <span className="tile-stock">
                {availableStock <= 0 ? 'Out of stock' : `${availableStock} available`}
              </span>
            </button>
          );
        })}
        {filteredMenuItems.length === 0 && (
          <p className="empty-hint">No items in this category.</p>
        )}
      </section>

      <aside className="cart no-print">
        <h2>Current Order</h2>
        {cart.length === 0 && <p className="empty-hint">Cart is empty</p>}
        {cart.map((line) => (
          <div key={line.menu_item_id} className="cart-line">
            <span>{line.name}</span>
            <div className="qty-control">
              <button onClick={() => updateCartQty(line.menu_item_id, line.qty - 1)}>−</button>
              <input
                type="number"
                min="1"
                max={stockFor(line.menu_item_id)}
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
        <button className="checkout-btn" disabled={cart.length === 0} onClick={handleCheckout}>
          Complete Order
        </button>
      </aside>

      {lastOrder && <Receipt order={lastOrder} />}
    </div>
  );
}
