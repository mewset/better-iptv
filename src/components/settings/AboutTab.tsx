import { useState, useEffect } from 'react';
import { getVersion } from '@tauri-apps/api/app';
import { appLogDir } from '@tauri-apps/api/path';
import { openPath, openUrl } from '@tauri-apps/plugin-opener';
import { Copy, Check, FolderOpen } from 'lucide-react';
import { truncateAddress } from '../../lib/truncateAddress';
import { logger } from '../../lib/logger';
import logoImage from '../../assets/logo/logo-256.webp';

const CRYPTO_ADDRESSES = [
  { currency: 'BTC', address: 'bc1qth40h9t8r7hvp4czqvf20f3w72jdg4epd5mjq8' },
  { currency: 'ETH', address: '0x47183F4e4FEAeE4BF52d95E68893e950125b1B44' },
  { currency: 'SOL', address: '3waxf6r2tmaaADuBGYoVD5qz4z8VnFNEGGafbXZ6Jf2j' },
] as const;

export default function AboutTab() {
  const [version, setVersion] = useState('');
  const [cryptoOpen, setCryptoOpen] = useState(false);
  const [copiedCurrency, setCopiedCurrency] = useState<string | null>(null);

  useEffect(() => {
    getVersion()
      .then(setVersion)
      .catch((err) => {
        logger.warn('Failed to get app version:', err);
      });
  }, []);

  const handleCopy = async (currency: string, address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      setCopiedCurrency(currency);
      setTimeout(() => setCopiedCurrency(null), 2000);
    } catch {
      // Clipboard write failed silently
    }
  };

  const handleOpenLogs = async () => {
    try {
      const dir = await appLogDir();
      await openPath(dir);
    } catch (err) {
      logger.error('Failed to open logs folder:', err);
    }
  };

  return (
    <div className="space-y-6 py-4">
      {/* App identity */}
      <div className="flex items-center gap-4">
        <img src={logoImage} alt="Better IPTV" className="h-12 w-12 rounded-xl" />
        <div>
          <h3 className="text-lg font-semibold text-text">Better IPTV</h3>
          <div className="mt-0.5 flex items-center gap-2">
            {version && (
              <>
                <span className="text-sm text-text-faint">v{version}</span>
                <span className="text-xs text-text-faint">·</span>
              </>
            )}
            <span className="text-xs text-text-faint">GPL-2.0</span>
          </div>
        </div>
      </div>

      {/* Support copy */}
      <p className="text-pretty text-sm leading-relaxed text-text-muted">
        Better IPTV is built and maintained by a single developer in their spare time — no ads, no
        subscriptions, no commercial backing. If you find it useful, consider supporting its
        development.
      </p>

      {/*
        Donation buttons: Ko-fi, GitHub and PayPal each have a fixed brand colour that
        must render the same regardless of app theme, so they intentionally keep literal
        Tailwind classes instead of design tokens — same exception as LoadingScreen.
      */}
      <div className="flex flex-wrap gap-3">
        <button
          onClick={() => {
            openUrl('https://ko-fi.com/R6R21I53PD').catch((err) =>
              logger.error('Failed to open Ko-fi URL:', err)
            );
          }}
          className="inline-flex items-center gap-2 rounded-lg bg-[#FF5E5B] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#e54f4d]"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M23.881 8.948c-.773-4.085-4.859-4.593-4.859-4.593H.723c-.604 0-.679.798-.679.798s-.082 7.324-.022 11.822c.164 2.424 2.586 2.672 2.586 2.672s8.267-.023 11.966-.049c2.438-.426 2.683-2.566 2.658-3.734 4.352.24 7.422-2.831 6.649-6.916zm-11.062 3.511c-1.246 1.453-4.011 3.976-4.011 3.976s-.121.119-.31.023c-.076-.057-.108-.09-.108-.09-.443-.441-3.368-3.049-4.034-3.954-.709-.965-1.041-2.7-.091-3.71.951-1.01 3.005-1.086 4.363.407 0 0 1.565-1.494 3.468-.947 1.904.547 1.832 2.51.723 4.295zm6.173.478c-.928.116-1.682.028-1.682.028V7.284h1.77s1.971.551 1.971 2.638c0 1.913-.985 2.667-2.059 3.015z" />
          </svg>
          Support on Ko-fi
        </button>
        <button
          onClick={() => {
            openUrl('https://github.com/sponsors/mewset').catch((err) =>
              logger.error('Failed to open GitHub Sponsors URL:', err)
            );
          }}
          className="inline-flex items-center gap-2 rounded-lg bg-gray-900 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-gray-700 dark:bg-gray-700 dark:hover:bg-gray-600"
        >
          <svg className="h-4 w-4" fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
          </svg>
          GitHub Sponsors
        </button>
        <button
          onClick={() => {
            openUrl('https://paypal.me/MattiasAndersson59').catch((err) =>
              logger.error('Failed to open PayPal URL:', err)
            );
          }}
          className="inline-flex items-center gap-2 rounded-lg bg-[#003087] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#002070]"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <path d="M7.076 21.337H2.47a.641.641 0 0 1-.633-.74L4.944.901C5.026.382 5.474 0 5.998 0h7.46c2.57 0 4.578.543 5.69 1.81 1.01 1.15 1.304 2.42 1.012 4.287-.023.143-.047.288-.077.437-.983 5.05-4.349 6.797-8.647 6.797h-2.19c-.524 0-.968.382-1.05.9l-1.12 7.106zm14.146-14.42a3.35 3.35 0 0 0-.607-.541c-.013.076-.026.175-.041.254-.93 4.778-4.005 7.201-9.138 7.201h-2.19a.563.563 0 0 0-.556.479l-1.187 7.527h-.506l-.24 1.516a.56.56 0 0 0 .554.647h3.882c.46 0 .85-.334.922-.788.06-.26.76-4.852.816-5.09a.932.932 0 0 1 .923-.788h.58c3.76 0 6.705-1.528 7.565-5.946.36-1.847.174-3.388-.777-4.471z" />
          </svg>
          PayPal
        </button>
      </div>

      {/* Crypto accordion */}
      <div className="overflow-hidden rounded-lg border border-border">
        <button
          onClick={() => setCryptoOpen((o) => !o)}
          aria-expanded={cryptoOpen}
          aria-controls="crypto-addresses"
          className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium text-text-muted transition-colors hover:text-text"
        >
          Donate with crypto
          <svg
            className={`h-4 w-4 transition-transform ${cryptoOpen ? 'rotate-180' : ''}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
          </svg>
        </button>
        {cryptoOpen && (
          <div id="crypto-addresses" className="space-y-3 border-t border-border px-4 pb-4 pt-3">
            {CRYPTO_ADDRESSES.map(({ currency, address }) => (
              <div key={currency}>
                <p className="mb-1 text-xs font-semibold uppercase text-text-faint">{currency}</p>
                <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2">
                  <span className="flex-1 font-mono text-xs text-text-muted">
                    {truncateAddress(address)}
                  </span>
                  <button
                    onClick={() => handleCopy(currency, address)}
                    aria-label={`Copy ${currency} address`}
                    className="flex-shrink-0 text-text-faint transition-colors hover:text-accent-text"
                  >
                    {copiedCurrency === currency ? (
                      <Check className="h-4 w-4 text-success" aria-hidden="true" />
                    ) : (
                      <Copy className="h-4 w-4" aria-hidden="true" />
                    )}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Open logs folder */}
      <div className="border-t border-border pt-4">
        <button
          onClick={handleOpenLogs}
          className="inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-text-muted transition-colors hover:bg-surface-hover"
        >
          <FolderOpen className="h-4 w-4" aria-hidden="true" />
          Open logs folder
        </button>
      </div>
    </div>
  );
}
