import { beforeEach, afterEach, expect, test, vi } from 'vitest';

const envVars = {
  TARGET_REPO: 'o/r',
  SUPABASE_URL: 'https://supabase.local',
  SUPABASE_SERVICE_ROLE_KEY: 'key',
};

let saveState: ReturnType<typeof vi.fn>;

vi.mock('../src/lib/lock.js', () => ({
  acquireLock: vi.fn().mockResolvedValue(true),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../src/lib/github.js', () => ({
  parseRepo: vi.fn().mockReturnValue({ owner: 'o', repo: 'r' }),
  gh: { rest: { repos: { listCommits: vi.fn().mockResolvedValue({ data: [{ sha: '1234567', commit: { message: 'msg' } }] }) } } },
}));

vi.mock('../src/lib/prompts.js', () => ({
  reviewToSummary: vi.fn().mockResolvedValue('summary'),
  reviewToIdeas: vi.fn().mockResolvedValue('queue:\n  - id: 1\n    title: "Test'),
}));

vi.mock('../src/lib/state.js', () => {
  saveState = vi.fn();
  return {
    loadState: vi.fn().mockResolvedValue({ lastReviewedSha: 'old' }),
    saveState,
    appendChangelog: vi.fn(),
    appendDecision: vi.fn(),
  };
});

vi.mock('../src/lib/supabase.js', () => ({
  sbRequest: vi.fn().mockResolvedValue([]),
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  process.env.TARGET_REPO = envVars.TARGET_REPO;
  process.env.SUPABASE_URL = envVars.SUPABASE_URL;
  process.env.SUPABASE_SERVICE_ROLE_KEY = envVars.SUPABASE_SERVICE_ROLE_KEY;
});

afterEach(() => {
  delete process.env.TARGET_REPO;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});

test('reviewRepo throws on invalid ideas YAML', async () => {
  const { reviewRepo } = await import('../src/cmds/review-repo.ts');
  await expect(reviewRepo()).rejects.toThrow('Failed to parse ideas YAML');
  expect(saveState).not.toHaveBeenCalled();
});

