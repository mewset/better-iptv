export interface XtreamLink {
  serverUrl: string;
  username: string;
  password: string;
}

/**
 * Reads the credentials out of a full provider link pasted into the server
 * field, e.g. `http://host:8080/player_api.php?username=a&password=b` or a
 * `get.php` M3U link. The server part keeps any path prefix but loses the
 * `.php` file, matching how the backend cuts the address back. Returns null
 * for anything that is not an http(s) link carrying both credentials.
 */
export function parseXtreamLink(text: string): XtreamLink | null {
  let url: globalThis.URL;
  try {
    url = new globalThis.URL(text.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  const username = url.searchParams.get('username');
  const password = url.searchParams.get('password');
  if (!username || password === null) return null;

  const path = url.pathname.replace(/\/[^/]*\.php$/i, '').replace(/\/+$/, '');
  return { serverUrl: url.origin + path, username, password };
}
