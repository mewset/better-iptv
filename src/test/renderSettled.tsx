import type { ReactElement } from 'react';
import { act, render, type RenderOptions, type RenderResult } from '@testing-library/react';

/**
 * `render`, then lets what the mount asked for arrive before the test goes
 * on. A screen that asks the backend for things on mount gets the mocked
 * answers a tick after `render` returns: a test that looks at it at once
 * checks a screen that is still changing, and React reports every late
 * update as "not wrapped in act(...)".
 *
 * Answers a test holds back (a promise it resolves itself) and timers stay
 * pending, so "while it loads" is still the state the test sees.
 */
export async function renderSettled(
  ui: ReactElement,
  options?: RenderOptions
): Promise<RenderResult> {
  let result!: RenderResult;
  await act(async () => {
    result = render(ui, options);
  });
  return result;
}

/** Lets pending answers and their updates land, e.g. after an event whose handler asks the backend. */
export async function settle(): Promise<void> {
  await act(async () => {});
}
