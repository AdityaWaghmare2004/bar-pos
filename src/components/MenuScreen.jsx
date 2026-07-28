import { useState } from 'react';
import { usePosStore } from '../store/posStore';

export default function MenuScreen() {
  const menuItems = usePosStore((s) => s.menuItems);
  const addMenuItem = usePosStore((s) => s.addMenuItem);
  const editMenuItem = usePosStore((s) => s.editMenuItem);
  const deleteMenuItem = usePosStore((s) => s.deleteMenuItem);

  const setItemTracking = usePosStore((s) => s.setItemTracking);

  const [form, setForm] = useState({ name: '', price: '', category: '', initialStock: '', unlimited: false });
  const [editingItemId, setEditingItemId] = useState(null);
  const [editDraft, setEditDraft] = useState({ name: '', price: '', category: '', unlimited: false, initialStock: '' });

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
    setEditDraft({
      name: item.name,
      price: item.price.toString(),
      category: item.category || '',
      unlimited: !!item.unlimited,
      initialStock: '',
    });
  }

  async function saveEdit(itemId) {
    const original = menuItems.find((i) => i.id === itemId);
    const updates = {};
    if (editDraft.name.trim() && editDraft.name !== original?.name) {
      updates.name = editDraft.name.trim();
    }
    const priceValue = parseFloat(editDraft.price);
    if (!Number.isNaN(priceValue) && priceValue !== original?.price) {
      updates.price = priceValue;
    }
    if (editDraft.category !== original?.category) {
      updates.category = editDraft.category;
    }

    if (Object.keys(updates).length > 0) {
      await editMenuItem(itemId, updates);
    }

    // Tracking type changed — handled separately since switching to
    // "tracked" needs a starting stock count.
    if (!!original?.unlimited !== editDraft.unlimited) {
      await setItemTracking(itemId, {
        unlimited: editDraft.unlimited,
        initialStock: parseInt(editDraft.initialStock || '0', 10),
      });
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
              <td>
                {editingItemId === item.id ? (
                  <div className="type-edit">
                    <label>
                      <input
                        type="checkbox"
                        checked={editDraft.unlimited}
                        onChange={(e) => setEditDraft({ ...editDraft, unlimited: e.target.checked })}
                      />
                      Unlimited
                    </label>
                    {item.unlimited && !editDraft.unlimited && (
                      <input
                        type="number"
                        placeholder="Starting stock"
                        value={editDraft.initialStock}
                        onChange={(e) => setEditDraft({ ...editDraft, initialStock: e.target.value })}
                      />
                    )}
                  </div>
                ) : (
                  item.unlimited ? 'Unlimited' : 'Tracked'
                )}
              </td>
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
