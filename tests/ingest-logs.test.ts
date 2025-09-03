import { beforeEach, afterEach, expect, test, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('ingestLogs only fetches new log entries on repeat runs', async () => {
  vi.mock('../src/lib/lock.js', () => ({
    acquireLock: vi.fn().mockResolvedValue(true),
    releaseLock: vi.fn().mockResolvedValue(undefined),
  }));
  vi.mock('../src/lib/state.js', () => ({
    loadState: vi.fn(),
    saveState: vi.fn(),
    appendChangelog: vi.fn(),
    appendDecision: vi.fn(),
  }));
  vi.mock('../src/lib/vercel.js', () => ({
    getLatestDeployment: vi.fn(),
    getRuntimeLogs: vi.fn(),
  }));
  vi.mock('../src/lib/prompts.js', () => ({ summarizeLogToBug: vi.fn().mockResolvedValue('# t\ncontent') }));
  vi.mock('../src/lib/roadmap.js', () => ({ insertRoadmap: vi.fn() }));

  const { ingestLogs } = await import('../src/cmds/ingest-logs.ts');
  const { getLatestDeployment, getRuntimeLogs } = await import('../src/lib/vercel.js');
  const { loadState, saveState } = await import('../src/lib/state.js');
  const { insertRoadmap } = await import('../src/lib/roadmap.js');

  loadState
    .mockResolvedValueOnce({})
    .mockResolvedValueOnce({ ingest: { lastDeploymentTimestamp: 1, lastRowIds: ['id1', 'id2'] } });
  getLatestDeployment.mockResolvedValue({ uid: 'dep1', createdAt: 1 });
  getRuntimeLogs
    .mockResolvedValueOnce([
      { id: 'id1', level: 'error', message: 'a' },
      { id: 'id2', level: 'error', message: 'b' },
    ])
    .mockResolvedValueOnce([
      { id: 'id2', level: 'error', message: 'b' },
      { id: 'id3', level: 'error', message: 'c' },
    ]);

  await ingestLogs();
  await ingestLogs();

  expect(getRuntimeLogs.mock.calls[1][1]).toEqual(
    expect.objectContaining({ fromId: 'id2' })
  );
  expect(insertRoadmap.mock.calls[0][0]).toHaveLength(2);
  expect(insertRoadmap.mock.calls[1][0]).toHaveLength(1);
  expect(saveState.mock.calls[1][0].ingest.lastRowIds).toEqual(['id2', 'id3']);
});
