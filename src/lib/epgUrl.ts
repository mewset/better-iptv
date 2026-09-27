/**
 * The EPG URL setting holds an Xtream provider's guide address verbatim,
 * credentials included (`…/xmltv.php?username=U&password=P`). Settings must
 * never show those in the clear; these helpers decide when to mask and how.
 */

const MASK = '••••';
const QUERY_CREDENTIALS = /([?&](?:username|password)=)[^&#]*/gi;
// Xtream stream paths carry the credentials as two path segments.
const PATH_CREDENTIALS = /(\/(?:live|movie|series)\/)[^/]+\/[^/]+(\/)/i;

/** Username and password replaced by dots; anything else returned unchanged. */
export function maskEpgCredentials(url: string): string {
  return url
    .replace(QUERY_CREDENTIALS, `$1${MASK}`)
    .replace(PATH_CREDENTIALS, `$1${MASK}/${MASK}$2`);
}

// Non-global copies for the boolean check: a global regex's `test()` keeps
// `lastIndex` between calls and would alternate between true and false.
const HAS_QUERY_CREDENTIALS = /[?&](?:username|password)=/i;
const HAS_PATH_CREDENTIALS = /\/(?:live|movie|series)\/[^/]+\/[^/]+\//i;

/** Whether the URL carries provider credentials in its query or path. */
export function hasEpgCredentials(url: string): boolean {
  return HAS_QUERY_CREDENTIALS.test(url) || HAS_PATH_CREDENTIALS.test(url);
}
