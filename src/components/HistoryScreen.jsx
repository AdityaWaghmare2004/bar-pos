import { useMemo } from 'react';
import { usePosStore } from '../store/posStore';

function formatOrderDate(value) {
  if (!value) return 'Unknown time';
  const date = new Date(value);
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export default function HistoryScreen() {
  const orders = usePosStore((s) => s.orders);
  const settings = usePosStore((s) => s.settings);
  const deleteOrder = usePosStore((s) => s.deleteOrder);
  const currency = settings?.currency || '₹';

  const sortedOrders = useMemo(
    () => [...orders].sort((a, b) => (b.created_at || 0) - (a.created_at || 0)),
    [orders]
  );

  const totalSales = useMemo(
    () => sortedOrders.reduce((sum, order) => sum + Number(order.total || 0), 0),
    [sortedOrders]
  );

  return (
    <section className="history-screen">
      <div className="history-header">
        <div>
          <h2>Order History</h2>
          <p>Completed orders are kept here so the bar can review recent sales and receipts easily.</p>
        </div>
        <div className="history-summary">
          <span>Total sales</span>
          <strong>{currency}{totalSales.toFixed(2)}</strong>
        </div>
      </div>

      {sortedOrders.length === 0 ? (
        <div className="empty-hint">No completed orders yet.</div>
      ) : (
        <div className="history-list">
          {sortedOrders.map((order, index) => {
            const items = order.items || [];
            const subtotal = Number(order.subtotal || 0);
            const tax = Number(order.tax || 0);
            const total = Number(order.total || subtotal + tax);

            const handleDelete = () => {
              const confirmed = window.confirm(
                `Delete this transaction for ${currency}${total.toFixed(2)}? Stock will be restored.`
              );
              if (confirmed) deleteOrder(order.id);
            };

            return (
              <article key={order.id} className="history-card">
                <div className="history-card-top">
                  <div>
                    <div className="history-order-number">#{index + 1}</div>
                    <h3>{formatOrderDate(order.created_at)}</h3>
                    <p>
                      {order.table_name ? `Table: ${order.table_name}` : 'No table assigned'}
                    </p>
                  </div>
                  <div className="history-total-group">
                    <div className="history-total">{currency}{total.toFixed(2)}</div>
                    <button type="button" className="delete-order-btn" onClick={handleDelete}>
                      Delete
                    </button>
                  </div>
                </div>

                <ul className="history-items">
                  {items.map((item, index) => (
                    <li key={`${order.id}-${index}`}>
                      <span>{item.qty} × {item.name}</span>
                      <span>{currency}{(item.price * item.qty).toFixed(2)}</span>
                    </li>
                  ))}
                </ul>

                <div className="history-meta">
                  <span>Subtotal {currency}{subtotal.toFixed(2)}</span>
                  <span>Tax {currency}{tax.toFixed(2)}</span>
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
