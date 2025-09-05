import { beforeEach, afterEach, expect, test, vi } from 'vitest';

vi.mock('../src/lib/prompts.js', () => ({ summarizeLogToBug: vi.fn() }));
vi.mock('../src/lib/lock.js', () => ({
  acquireLock: vi.fn(),
  releaseLock: vi.fn(),
}));
vi.mock('../src/lib/state.js', () => ({
  loadState: vi.fn(),
  saveState: vi.fn(),
  appendChangelog: vi.fn(),
  appendDecision: vi.fn(),
}));
vi.mock('../src/lib/vercel.js', () => ({
  getLatestDeployment: vi.fn(),
  getBuildLogs: vi.fn(),
}));
vi.mock('../src/lib/roadmap.js', () => ({ insertRoadmap: vi.fn() }));

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test('ingestLogs only fetches new log entries on repeat runs', async () => {
    const { ingestLogs } = await import('../src/cmds/ingest-logs.ts');
    const { getLatestDeployment, getBuildLogs } = await import('../src/lib/vercel.js');
    const { loadState, saveState } = await import('../src/lib/state.js');
    const { insertRoadmap } = await import('../src/lib/roadmap.js');
    const { summarizeLogToBug } = await import('../src/lib/prompts.js');
    const { acquireLock, releaseLock } = await import('../src/lib/lock.js');

    acquireLock.mockResolvedValue(true);
    releaseLock.mockResolvedValue(undefined);
    summarizeLogToBug.mockResolvedValue('# t\ncontent');

    loadState
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ ingest: { lastDeploymentTimestamp: 1, lastRowIds: ['id1', 'id2'] } })
      .mockResolvedValueOnce({ ingest: { lastDeploymentTimestamp: 1, lastRowIds: ['id2', 'id3'] } });
    getLatestDeployment.mockResolvedValue({ uid: 'dep1', createdAt: 1 });
    getBuildLogs
      .mockImplementationOnce(async function* () {
        yield { id: 'id1', type: 'stderr', level: 'info', text: 'a' };
        yield { id: 'id2', type: 'stderr', level: 'info', text: 'b' };
      })
      .mockImplementationOnce(async function* () {
        yield { id: 'id2', type: 'stderr', level: 'info', text: 'b' };
        yield { id: 'id3', type: 'stderr', level: 'info', text: 'c' };
      })
      .mockImplementationOnce(async function* () {});

    await ingestLogs();
    await ingestLogs();
    await ingestLogs();

    expect(getBuildLogs.mock.calls[0][1]).toEqual(
      expect.objectContaining({ from: new Date(1).toISOString() })
    );
    expect(getBuildLogs.mock.calls[1][1]).toEqual(
      expect.objectContaining({ fromId: 'id2' })
    );
    expect(getBuildLogs.mock.calls[2][1]).toEqual(
      expect.objectContaining({ fromId: 'id3' })
    );
    expect(insertRoadmap).toHaveBeenCalledTimes(2);
    expect(saveState.mock.calls[1][0].ingest.lastRowIds).toEqual(['id2', 'id3']);
    expect(saveState.mock.calls[2][0].ingest.lastRowIds).toEqual(['id2', 'id3']);
  });

test('ingestLogs continues processing groups when summarization fails', async () => {
  const { ingestLogs } = await import('../src/cmds/ingest-logs.ts');
  const { getLatestDeployment, getBuildLogs } = await import('../src/lib/vercel.js');
  const { loadState, saveState, appendChangelog } = await import('../src/lib/state.js');
  const { insertRoadmap } = await import('../src/lib/roadmap.js');
  const { summarizeLogToBug } = await import('../src/lib/prompts.js');
  const { acquireLock, releaseLock } = await import('../src/lib/lock.js');

  acquireLock.mockResolvedValue(true);
  releaseLock.mockResolvedValue(undefined);
  summarizeLogToBug
    .mockRejectedValueOnce(new Error('fail'))
    .mockResolvedValue('# t\ncontent');

  loadState.mockResolvedValue({});
  getLatestDeployment.mockResolvedValue({ uid: 'dep1', createdAt: 1 });
  getBuildLogs.mockImplementation(async function* () {
    yield { id: 'id1', type: 'stderr', level: 'info', text: 'a' };
    yield { id: 'id2', type: 'stderr', level: 'info', text: 'b' };
  });

  await ingestLogs();

  expect(insertRoadmap).toHaveBeenCalledTimes(1);
  expect(insertRoadmap.mock.calls[0][0]).toHaveLength(1);
  expect(saveState).toHaveBeenCalledTimes(1);
  expect(
    appendChangelog.mock.calls.some(call => call[0].includes('Failed to summarize'))
  ).toBe(true);
});
