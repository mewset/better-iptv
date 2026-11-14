import { describe, expect, it } from 'vitest';
import { errorText } from '../../lib/errorText';

describe('errorText', () => {
  it('reads a backend error by its details', () => {
    expect(errorText({ code: 'InvalidInput', details: 'Bad URL' })).toBe('Bad URL');
  });

  it('passes a plain string and an Error message through', () => {
    expect(errorText('plain')).toBe('plain');
    expect(errorText(new Error('boom'))).toBe('boom');
  });

  it('names a missing profile or channel, whose details are only a row id', () => {
    expect(errorText({ code: 'PlaylistNotFound', details: 7 })).toBe(
      'That profile no longer exists.'
    );
    expect(errorText({ code: 'ChannelNotFound', details: 7 })).toBe(
      'That channel is no longer in the playlist.'
    );
  });

  it('never shows an object as text', () => {
    expect(errorText({})).toBe('Something went wrong.');
    expect(errorText({ code: 'Http', details: '' })).toBe('Something went wrong.');
    expect(errorText(null)).toBe('Something went wrong.');
    expect(errorText(undefined)).toBe('Something went wrong.');
  });
});
