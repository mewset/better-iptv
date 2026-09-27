import { describe, it, expect } from 'vitest';
import { hasEpgCredentials, maskEpgCredentials } from '../../lib/epgUrl';

const xtream = 'http://provider.example:8080/xmltv.php?username=mattias&password=s3cret';

describe('maskEpgCredentials', () => {
  it('hides the username and password of an Xtream guide URL', () => {
    expect(maskEpgCredentials(xtream)).toBe(
      'http://provider.example:8080/xmltv.php?username=••••&password=••••'
    );
  });

  it('hides path-based Xtream credentials too', () => {
    expect(maskEpgCredentials('http://p.example/live/mattias/s3cret/1.ts')).toBe(
      'http://p.example/live/••••/••••/1.ts'
    );
  });

  it('leaves a plain XMLTV URL alone', () => {
    expect(maskEpgCredentials('https://iptv-epg.org/se.xml.gz')).toBe(
      'https://iptv-epg.org/se.xml.gz'
    );
  });
});

describe('hasEpgCredentials', () => {
  it('is true only when the URL carries a username or password', () => {
    expect(hasEpgCredentials(xtream)).toBe(true);
    expect(hasEpgCredentials('http://p.example/live/mattias/s3cret/1.ts')).toBe(true);
    expect(hasEpgCredentials('https://iptv-epg.org/se.xml.gz')).toBe(false);
    expect(hasEpgCredentials('')).toBe(false);
  });
});
