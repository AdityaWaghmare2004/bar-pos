import { usePosStore } from '../store/posStore';

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
