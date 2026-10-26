import { describe, it, expect } from 'vitest';
import { parseXtreamLink } from '../../lib/xtreamLink';

describe('parseXtreamLink', () => {
  it('splits a player_api link into server and credentials', () => {
    expect(
      parseXtreamLink('http://host:8080/player_api.php?username=alice&password=s3cret')
    ).toEqual({ serverUrl: 'http://host:8080', username: 'alice', password: 's3cret' });
  });

  it('reads a get.php M3U link the same way', () => {
    expect(
      parseXtreamLink(
        'http://host:8080/get.php?username=alice&password=s3cret&type=m3u_plus&output=ts'
      )
    ).toEqual({ serverUrl: 'http://host:8080', username: 'alice', password: 's3cret' });
  });

  it('keeps a path prefix in front of the .php file', () => {
    expect(
      parseXtreamLink('https://host/panel/player_api.php?username=a&password=b')?.serverUrl
    ).toBe('https://host/panel');
  });

  it('decodes percent-encoded credentials', () => {
    expect(
      parseXtreamLink('http://host/player_api.php?username=me%40mail.se&password=a%26b')
    ).toEqual({
      serverUrl: 'http://host',
      username: 'me@mail.se',
      password: 'a&b',
    });
  });

  it('ignores surrounding whitespace', () => {
    expect(
      parseXtreamLink('  http://host/player_api.php?username=a&password=b \n')?.serverUrl
    ).toBe('http://host');
  });

  it('returns null without both credentials', () => {
    expect(parseXtreamLink('http://host:8080')).toBeNull();
    expect(parseXtreamLink('http://host:8080/player_api.php')).toBeNull();
    expect(parseXtreamLink('http://host/player_api.php?username=a')).toBeNull();
    expect(parseXtreamLink('http://host/player_api.php?password=b')).toBeNull();
  });

  it('returns null for text that is not an http(s) link', () => {
    expect(parseXtreamLink('host:8080')).toBeNull();
    expect(parseXtreamLink('ftp://host/player_api.php?username=a&password=b')).toBeNull();
    expect(parseXtreamLink('')).toBeNull();
  });
});
