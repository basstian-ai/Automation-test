import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { ENV } from '../src/lib/env';

beforeEach(() => {
  ENV.VERCEL_PROJECT_ID = 'proj';
  ENV.VERCEL_TOKEN = 'token';
  ENV.VERCEL_TEAM_ID = 'team';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  ENV.VERCEL_PROJECT_ID = '';
  ENV.VERCEL_TOKEN = '';
  ENV.VERCEL_TEAM_ID = '';
});

  test('getBuildLogs passes paging params', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' } as any);
    vi.stubGlobal('fetch', fetchMock);
    const { getBuildLogs } = await import('../src/lib/vercel.ts');
    await getBuildLogs('dep1', { from: 'a', until: 'b', limit: 5, direction: 'forward' });
  const url = fetchMock.mock.calls[0][0] as URL;
  expect(url.searchParams.get('from')).toBe('a');
  expect(url.searchParams.get('until')).toBe('b');
  expect(url.searchParams.get('limit')).toBe('5');
  expect(url.searchParams.get('direction')).toBe('forward');
});

  test('getBuildLogs uses fromId when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' } as any);
    vi.stubGlobal('fetch', fetchMock);
    const { getBuildLogs } = await import('../src/lib/vercel.ts');
    await getBuildLogs('dep1', { fromId: '123' });
  const url = fetchMock.mock.calls[0][0] as URL;
  expect(url.searchParams.get('from')).toBe('123');
});

  test('getBuildLogs rejects on timeout', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, opts) => {
    return new Promise((_, reject) => {
      opts?.signal?.addEventListener('abort', () => {
        const err = new Error('aborted');
        (err as any).name = 'AbortError';
        reject(err);
      });
    });
  }));
    const { getBuildLogs } = await import('../src/lib/vercel.ts');
    const p = expect(getBuildLogs('dep1')).rejects.toMatchObject({ name: 'AbortError' });
  await vi.advanceTimersByTimeAsync(31_000);
  await p;
});
