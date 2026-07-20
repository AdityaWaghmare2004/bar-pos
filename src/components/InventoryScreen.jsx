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
              <td className={stockFor(item.id) <= 3 ? 'low-stock' : ''}>{stockFor(item.id)}</td>
              <td className="px-4 py-3 align-middle">
  <div className="flex items-center gap-3">
    {/* Core Quantity Controls */}
    <div className="inline-flex items-center rounded-lg border border-gray-200 bg-gray-50 p-1 shadow-sm">
      <button 
        onClick={() => adjustStock(item.id, -1)}
        className="flex h-8 w-8 items-center justify-center rounded-md text-gray-600 hover:bg-white hover:text-gray-900 hover:shadow-sm transition-all active:scale-95"
        title="Decrease by 1"
      >
        <span className="text-lg font-medium">−</span>
      </button>
      
      <span className="w-8 text-center font-semibold text-gray-700">
        {stockFor(item.id)} {/* Assuming you display the current stock here */}
      </span>

      <button 
        onClick={() => adjustStock(item.id, 1)}
        className="flex h-8 w-8 items-center justify-center rounded-md text-gray-600 hover:bg-white hover:text-gray-900 hover:shadow-sm transition-all active:scale-95"
        title="Increase by 1"
      >
        <span className="text-lg font-medium">+</span>
      </button>
    </div>

    {/* Quick Restock Action */}
    <button 
      onClick={() => adjustStock(item.id, 10)}
      className="rounded-lg bg-blue-50 px-3 py-1.5 text-xs font-semibold text-blue-600 border border-blue-100 hover:bg-blue-100 transition-colors active:scale-95"
    >
      +10 Restock
    </button>
  </div>
</td>
            </tr>
          ))}
        </tbody>
      </table>
      {menuItems.length === 0 && <p className="empty-hint">Add menu items first.</p>}
    </div>
  );
}
