import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { applyTheme, applyThemeFromCache } from './lib/theme';
import { getSetting } from './lib/tauri';
import type { Theme } from './components/settings/constants';

// Instant theme from localStorage cache (no flash)
applyThemeFromCache();

// Then sync with the authoritative SQLite setting
getSetting('theme').then((saved) => {
  applyTheme((saved as Theme) || 'system');
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
