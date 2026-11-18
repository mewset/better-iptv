import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { loadAppFonts } from './lib/fonts';
import './index.css';
import { applyTheme, applyThemeFromCache } from './lib/theme';
import { applyBackdropSupport } from './lib/glass';
import { getSetting } from './lib/tauri';
import type { Theme } from './components/settings/constants';

// Instant theme from localStorage cache (no flash)
applyThemeFromCache();

// Opaque glass where the web view draws no backdrop filter, before the first paint
applyBackdropSupport();

// Started here so the faces load while App asks the backend for its first answers
void loadAppFonts();

// Then sync with the authoritative SQLite setting
getSetting('theme').then((saved) => {
  applyTheme((saved as Theme) || 'system');
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
