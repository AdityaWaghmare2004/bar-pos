import { useEffect, useRef, useState } from 'react';
import { exportAllData, importAllData } from '../lib/db';
import { runSync } from '../lib/sync';
import { usePosStore } from '../store/posStore';

export default function SettingsScreen() {
  const fileInputRef = useRef();
  const [status, setStatus] = useState('');
  const loadAll = usePosStore((s) => s.loadAll);
  const settings = usePosStore((s) => s.settings);
  const updateSettings = usePosStore((s) => s.updateSettings);
  const [form, setForm] = useState(null);

  const tables = usePosStore((s) => s.tables);
  const addTable = usePosStore((s) => s.addTable);
  const deleteTable = usePosStore((s) => s.deleteTable);
  const [newTableName, setNewTableName] = useState('');

  useEffect(() => {
    if (settings) setForm({ ...settings, tax_rate: (settings.tax_rate * 100).toString() });
  }, [settings]);

  async function handleSaveDetails(e) {
    e.preventDefault();
    await updateSettings({
      bar_name: form.bar_name,
      address: form.address,
      phone: form.phone,
      currency: form.currency,
      tax_rate: parseFloat(form.tax_rate) / 100,
      receipt_footer: form.receipt_footer,
    });
    setStatus('Bar details saved.');
  }

  async function handleAddTable(e) {
    e.preventDefault();
    if (!newTableName.trim()) return;
    await addTable(newTableName.trim());
    setNewTableName('');
  }

  async function handleExport() {
    const data = await exportAllData();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bar-pos-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    const text = await file.text();
    const data = JSON.parse(text);
    await importAllData(data);
    await loadAll();
    setStatus('Import complete.');
  }

  async function handleForceSync() {
    setStatus('Syncing...');
    await runSync();
    setStatus(navigator.onLine ? 'Sync attempted.' : 'Offline — will retry automatically.');
  }

  return (
    <div className="settings-screen">
      <h2>Settings</h2>

      <section className="business-info-card">
        <h3>Business Info</h3>
        {form && (
          <form className="bar-details-form" onSubmit={handleSaveDetails}>
            <label>
              Business Name
              <input value={form.bar_name} onChange={(e) => setForm({ ...form, bar_name: e.target.value })} />
            </label>
            <label>
              Address
              <input value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
            </label>
            <div className="form-row">
              <label>
                Currency
                <input
                  value={form.currency}
                  maxLength={3}
                  onChange={(e) => setForm({ ...form, currency: e.target.value })}
                />
              </label>
              <label>
                Tax Rate (%)
                <input
                  type="number" step="0.1" min="0" max="100"
                  value={form.tax_rate}
                  onChange={(e) => setForm({ ...form, tax_rate: e.target.value })}
                />
              </label>
            </div>
            <label>
              Receipt footer note
              <textarea
                rows={3}
                value={form.receipt_footer}
                onChange={(e) => setForm({ ...form, receipt_footer: e.target.value })}
              />
            </label>
            <label>
              Phone
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
            </label>
            <button type="submit">Save Settings</button>
          </form>
        )}
      </section>

      <section className="business-info-card">
        <h3>Tables</h3>
        <p>Add or remove tables. Deleting a table also discards any in-progress order on it.</p>
        <form className="menu-form" onSubmit={handleAddTable}>
          <input
            placeholder="Table name (e.g. Table 9, Patio 1)"
            value={newTableName}
            onChange={(e) => setNewTableName(e.target.value)}
          />
          <button type="submit">Add Table</button>
        </form>
        <table>
          <thead><tr><th>Name</th><th></th></tr></thead>
          <tbody>
            {tables.map((t) => (
              <tr key={t.id}>
                <td>{t.name}</td>
                <td><button onClick={() => deleteTable(t.id)}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section>
        <h3>Cloud Sync</h3>
        <p>
          Every sale, stock change, and menu edit is saved to this device instantly and
          also backed up to the cloud in the background — even if this device's data is
          later lost, nothing is lost with it.
        </p>
        <p>Status: {navigator.onLine ? 'Online' : 'Offline — changes will sync once reconnected'}</p>
        <button onClick={handleForceSync}>Sync now</button>
      </section>

      <section>
        <h3>Manual Backup (optional, extra safety net)</h3>
        <p>Cloud sync is the primary backup. This local file export is an additional copy you can keep yourself.</p>
        <button onClick={handleExport}>Export backup (.json)</button>
        <input ref={fileInputRef} type="file" accept="application/json" onChange={handleImport} />
      </section>

      {status && <p className="status-msg">{status}</p>}
    </div>
  );
}
