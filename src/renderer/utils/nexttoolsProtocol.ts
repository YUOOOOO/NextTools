/**
 * Resolve app-owned custom-protocol subresource URLs for the current WebView.
 *
 * Tauri 2 serves custom protocols as `http://<scheme>.localhost/...` on
 * Windows, while macOS/Linux continue to use the scheme form. The Rust
 * `attachment_protocol` handler accepts both; renderer code must emit the form
 * the platform WebView can actually load as an <img>/<audio> subresource.
 */

const NEXTTOOLS_RESOURCE_WINDOWS_ORIGIN = 'http://nexttools-resource.localhost';
const NEXTTOOLS_RESOURCE_SCHEME_PREFIX = 'nexttools-resource://';
const LEGACY_NEXTTOOLS_WINDOWS_ORIGIN = 'http://nexttools.localhost';
const LEGACY_NEXTTOOLS_SCHEME_PREFIX = 'nexttools://';

export function isWindowsPlatform(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /Win/i.test(navigator.platform || '') || /Windows/i.test(navigator.userAgent || '');
}

export function resolveNextToolsResourceUrl(pathname: string): string {
  const path = pathname.startsWith('/') ? pathname : `/${pathname}`;
  if (isWindowsPlatform()) {
    return `${NEXTTOOLS_RESOURCE_WINDOWS_ORIGIN}${path}`;
  }
  return `${NEXTTOOLS_RESOURCE_SCHEME_PREFIX}${path.slice(1)}`;
}

/**
 * Rewrite only the two historical WebView resource authorities. This is not
 * an AppRoute parser and must never be used at an OS deep-link boundary.
 */
export function canonicalizeLegacyNextToolsResourceUrl(value: string): string {
  for (const prefix of [LEGACY_NEXTTOOLS_SCHEME_PREFIX, NEXTTOOLS_RESOURCE_SCHEME_PREFIX]) {
    for (const authority of ['attachment/', 'tool-attachment/']) {
      const marker = `${prefix}${authority}`;
      if (value.startsWith(marker)) {
        return resolveNextToolsResourceUrl(`/${value.slice(prefix.length)}`);
      }
    }
  }
  for (const origin of [LEGACY_NEXTTOOLS_WINDOWS_ORIGIN, NEXTTOOLS_RESOURCE_WINDOWS_ORIGIN]) {
    for (const authority of ['/attachment/', '/tool-attachment/']) {
      const marker = `${origin}${authority}`;
      if (value.startsWith(marker)) {
        return resolveNextToolsResourceUrl(value.slice(origin.length));
      }
    }
  }
  return value;
}
