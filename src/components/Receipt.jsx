import { usePosStore } from '../store/posStore';

export default function Receipt({ order }) {
  const settings = usePosStore((s) => s.settings);
  const cur = settings?.currency || '₹';
  const date = new Date(order.created_at);
  return (
    <div className="receipt print-only">
      <div className="receipt-header">
        <strong>{settings?.bar_name || 'BAR / RESTAURANT'}</strong>
        {settings?.address && <div>{settings.address}</div>}
        {settings?.phone && <div>{settings.phone}</div>}
        <div>{date.toLocaleString()}</div>
        <div>Order #{order.id.slice(0, 8)}</div>
      </div>
      <hr />
      {order.items.map((line) => (
        <div className="receipt-line" key={line.menu_item_id}>
          <span>{line.qty} x {line.name}</span>
          <span>{cur}{(line.price * line.qty).toFixed(2)}</span>
        </div>
      ))}
      <hr />
      <div className="receipt-line"><span>Subtotal</span><span>{cur}{order.subtotal.toFixed(2)}</span></div>
      <div className="receipt-line"><span>Tax</span><span>{cur}{order.tax.toFixed(2)}</span></div>
      <div className="receipt-line total"><span>TOTAL</span><span>{cur}{order.total.toFixed(2)}</span></div>
      <hr />
      <div className="receipt-footer">{settings?.receipt_footer || 'Thank you!'}</div>
    </div>
  );
}
