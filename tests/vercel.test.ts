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

  test('getBuildLogs passes paging params', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: undefined } as any);
    vi.stubGlobal('fetch', fetchMock);
    const { getBuildLogs } = await import('../src/lib/vercel.ts');
    const gen = getBuildLogs('dep1', { from: 'a', until: 'b', limit: 5, direction: 'forward' });
    await gen?.next();
    const url = fetchMock.mock.calls[0][0] as URL;
    expect(url.searchParams.get('from')).toBe('a');
    expect(url.searchParams.get('until')).toBe('b');
    expect(url.searchParams.get('limit')).toBe('5');
    expect(url.searchParams.get('direction')).toBe('forward');
  });

  test('getBuildLogs uses fromId when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, body: undefined } as any);
    vi.stubGlobal('fetch', fetchMock);
    const { getBuildLogs } = await import('../src/lib/vercel.ts');
    const gen = getBuildLogs('dep1', { fromId: '123' });
    await gen?.next();
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
    const gen = getBuildLogs('dep1');
    const p = expect(gen?.next()).rejects.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(181_000);
    await p;
  });

test('getBuildLogs yields nothing on 404', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, body: undefined } as any);
  vi.stubGlobal('fetch', fetchMock);
  const { getBuildLogs } = await import('../src/lib/vercel.ts');
  const res: any[] = [];
  for await (const r of getBuildLogs('dep1') || []) res.push(r);
  expect(res).toEqual([]);
});
