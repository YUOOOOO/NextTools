import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  canonicalizeLegacyNextToolsResourceUrl,
  resolveNextToolsResourceUrl,
} from './nexttoolsProtocol';

const originalPlatform = navigator.platform;
const originalUserAgent = navigator.userAgent;

function setNavigator(platform: string, userAgent: string) {
  vi.spyOn(navigator, 'platform', 'get').mockReturnValue(platform);
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent);
}

afterEach(() => {
  vi.restoreAllMocks();
  void originalPlatform;
  void originalUserAgent;
});

describe('nexttools-resource protocol projection', () => {
  it('emits the canonical scheme on macOS and Linux', () => {
    setNavigator('MacIntel', 'Mozilla/5.0 (Macintosh)');
    expect(resolveNextToolsResourceUrl('/attachment/s/file.png')).toBe(
      'nexttools-resource://attachment/s/file.png',
    );
  });

  it('emits the WebView2 custom-protocol host on Windows', () => {
    setNavigator('Win32', 'Mozilla/5.0 (Windows NT 10.0)');
    expect(resolveNextToolsResourceUrl('/tool-attachment/s/t/file.png')).toBe(
      'http://nexttools-resource.localhost/tool-attachment/s/t/file.png',
    );
  });

  it('rewrites only historical resource authorities through the platform projection', () => {
    setNavigator('MacIntel', 'Mozilla/5.0 (Macintosh)');
    expect(canonicalizeLegacyNextToolsResourceUrl('nexttools://attachment/s/file.png')).toBe(
      'nexttools-resource://attachment/s/file.png',
    );
    expect(canonicalizeLegacyNextToolsResourceUrl('nexttools://tool-attachment/s/t/file.png')).toBe(
      'nexttools-resource://tool-attachment/s/t/file.png',
    );
    expect(canonicalizeLegacyNextToolsResourceUrl('nexttools://open/v1/spaces/a/issues/b')).toBe(
      'nexttools://open/v1/spaces/a/issues/b',
    );
  });
});
