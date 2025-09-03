import { afterEach, beforeEach, expect, test, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  process.env.VERCEL_PROJECT_ID = 'proj';
  process.env.VERCEL_TOKEN = 'token';
  process.env.VERCEL_TEAM_ID = 'team';
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  delete process.env.VERCEL_PROJECT_ID;
  delete process.env.VERCEL_TOKEN;
  delete process.env.VERCEL_TEAM_ID;
});

test('getRuntimeLogs passes paging params', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' } as any);
  vi.stubGlobal('fetch', fetchMock);
  const { getRuntimeLogs } = await import('../src/lib/vercel.ts');
  await getRuntimeLogs('dep1', { from: 'a', until: 'b', limit: 5, direction: 'forward' });
  const url = fetchMock.mock.calls[0][0] as URL;
  expect(url.searchParams.get('from')).toBe('a');
  expect(url.searchParams.get('until')).toBe('b');
  expect(url.searchParams.get('limit')).toBe('5');
  expect(url.searchParams.get('direction')).toBe('forward');
});

test('getRuntimeLogs times out', async () => {
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
  const { getRuntimeLogs } = await import('../src/lib/vercel.ts');
  const p = getRuntimeLogs('dep1');
  p.catch(() => {});
  await vi.advanceTimersByTimeAsync(31_000);
  await expect(p).rejects.toThrow('timed out');
});
