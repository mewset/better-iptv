import { useCallback, useState } from 'react';
import { hasReported, reportLogoFailure, useLogoFallbackStore } from '../lib/logoFallback';
import type { Channel } from '../types';

/**
 * Resolves the logo URL to render for a channel: the provider logo until it
 * fails, then the session's iptv-org fallback until that fails, then null.
 * Subscribes only to this channel's fallback, never to the whole map.
 */
export function useChannelLogo(channel: Channel): { src: string | null; onError: () => void } {
  const { id, logo } = channel;
  const fallback = useLogoFallbackStore((s) => s.fallbacks[id]);
  // A URL this session already saw fail starts as failed, so a remounted
  // (virtualized) card never requests it again.
  const knownDead = (url: string | null | undefined) => !!url && hasReported(id, url);
  const [providerFailed, setProviderFailed] = useState(() => knownDead(logo));
  const [fallbackFailed, setFallbackFailed] = useState(false);

  // Reset during render (not in an effect) so a recycled card never paints a stale src.
  const [key, setKey] = useState(`${id}|${logo ?? ''}`);
  const currentKey = `${id}|${logo ?? ''}`;
  if (key !== currentKey) {
    setKey(currentKey);
    setProviderFailed(knownDead(logo));
    setFallbackFailed(false);
  }

  // A blank provider logo is no logo: never an <img> with a blank src.
  const hasLogo = !!logo && logo.trim() !== '';
  const showingProvider = hasLogo && !providerFailed && key === currentKey;
  const src = showingProvider ? logo : fallback && !fallbackFailed ? fallback : null;

  const onError = useCallback(() => {
    if (showingProvider && logo) {
      setProviderFailed(true);
      reportLogoFailure(channel, logo);
    } else {
      setFallbackFailed(true);
    }
  }, [showingProvider, logo, channel]);

  return { src, onError };
}
