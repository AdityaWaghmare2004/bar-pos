import { useEffect, useState } from 'react';
import { usePosStore } from './store/posStore';
import { startSyncLoop } from './lib/sync';
import POSScreen from './components/POSScreen';
import InventoryScreen from './components/InventoryScreen';
import MenuScreen from './components/MenuScreen';
import SettingsScreen from './components/SettingsScreen';
import './App.css';

export default function App() {
  const [tab, setTab] = useState('pos');
  const loadAll = usePosStore((s) => s.loadAll);

  useEffect(() => {
    loadAll();
    const stop = startSyncLoop();
    return stop;
  }, [loadAll]);

  return (
    <div className="app">
      <header className="app-header no-print">
        <h1>Bar POS</h1>
        <nav>
          {['pos', 'inventory', 'menu', 'settings'].map((t) => (
            <button
              key={t}
              className={tab === t ? 'active' : ''}
              onClick={() => setTab(t)}
            >
              {t[0].toUpperCase() + t.slice(1)}
            </button>
          ))}
        </nav>
      </header>

      <main>
        {tab === 'pos' && <POSScreen />}
        {tab === 'inventory' && <InventoryScreen />}
        {tab === 'menu' && <MenuScreen />}
        {tab === 'settings' && <SettingsScreen />}
      </main>
    </div>
  );
}
