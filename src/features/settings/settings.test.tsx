import { render, screen, waitFor, within, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { SettingsPage } from './SettingsPage';
import { useModels } from '@/stores/models';
import type { GlobalConfig, ModelOptions } from '@/types/api';

const apiMock = vi.fn();
vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, api: (...args: unknown[]) => apiMock(...args) };
});

const config = (): GlobalConfig => ({
  mode: 'manual', max_concurrent_runs: 1, max_fix_rounds: 3, max_prd_rounds: 2, num_tasks: 0, branch_prefix: 'ai-workflow/',
  roles: { interviewer: 'claude', author: 'claude', reviewer: 'both', task_planner: 'claude', implementer: 'claude', fixer: 'claude', code_reviewer: 'both', handover: 'claude', chat: 'claude' },
  models: {}, runtime: { claude: 'auto', codex: 'wsl' }, claude: {}, codex: {},
  token_saving: { review_diff_filter: true, terse: { reviewer: true } },
});
const options: ModelOptions = {
  claude: { models: [{ id: 'opus', name: 'Opus', efforts: ['low', 'high'] }], error: null },
  codex: { models: [{ id: 'gpt-5.1-codex', name: 'gpt-5.1-codex', efforts: ['low', 'medium'], default: true }], error: null },
};

let current: GlobalConfig;
function setup() {
  current = config();
  apiMock.mockReset();
  apiMock.mockImplementation(async (path: string, body?: Record<string, unknown>) => {
    if (path === '/api/config') return { config: current, home: 'C:\\Users\\me\\.ai-workflow', text: '{}', queue: { max: 1, running: [], waiting: [] } };
    if (path === '/api/config/mode') { current = { ...current, mode: body!.mode as 'auto' }; return { config: current }; }
    if (path === '/api/config/models') { current = { ...current, roles: body!.roles as GlobalConfig['roles'], models: body!.models as GlobalConfig['models'] }; return { config: current }; }
    if (path === '/api/config/token_saving') { current = { ...current, token_saving: body!.token_saving as GlobalConfig['token_saving'] }; return { config: current }; }
    return { config: current };
  });
  useModels.setState({ options, loading: false, error: null, load: async () => {} });
  return render(<SettingsPage />);
}

describe('全域設定', () => {
  beforeEach(() => { vi.useRealTimers(); });

  it('九個角色依序排成小卡，雙人審查顯示兩個 AI 的模型列', async () => {
    setup();
    const grid = await screen.findByTestId('role-grid');
    const cards = within(grid).getAllByRole('group');
    expect(cards.map((c) => c.getAttribute('data-role'))).toEqual(['interviewer', 'author', 'reviewer', 'task_planner', 'implementer', 'fixer', 'code_reviewer', 'handover', 'chat']);
    expect(within(cards[2]).getByLabelText('PRD 審查：Claude 模型')).toBeInTheDocument();
    expect(within(cards[2]).getByLabelText('PRD 審查：Codex 模型')).toBeInTheDocument();
    expect(within(cards[1]).queryByLabelText('PRD 作者：Codex 模型')).toBeNull();
  });

  it('模型輸入在重畫後保留，儲存只送 /api/config/models 並帶整份草稿，推理強度跟著模型', async () => {
    const user = userEvent.setup();
    setup();
    const model = await screen.findByLabelText('PRD 作者：Claude 模型');
    await user.type(model, 'opus');
    // 模擬其他卡片觸發的重畫（切換模式會重新載入 config）
    await user.click(screen.getByRole('radio', { name: '自動' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/config/mode', { mode: 'auto' }));
    expect((screen.getByLabelText('PRD 作者：Claude 模型') as HTMLInputElement).value).toBe('opus');
    const effort = screen.getByLabelText('PRD 作者：Claude 推理強度') as HTMLSelectElement;
    expect([...effort.options].map((o) => o.value)).toEqual(['', 'low', 'high']);
    await user.selectOptions(effort, 'high');
    apiMock.mockClear();
    const rolesCard = screen.getByText('AI 角色與模型').closest('section')!;
    await user.click(within(rolesCard).getByRole('button', { name: '儲存' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledTimes(1));
    const [path, body] = apiMock.mock.calls[0] as [string, { roles: Record<string, string>; models: Record<string, Record<string, { model: string; effort: string }>> }];
    expect(path).toBe('/api/config/models');
    expect(body.models.author.claude).toEqual({ model: 'opus', effort: 'high' });
    expect(body.roles.reviewer).toBe('both');
    expect(Object.keys(body.roles)).toHaveLength(9);
  });

  it('節省 Token：勾選反映設定，儲存送整份 token_saving，未儲存的勾選不會被重畫蓋掉', async () => {
    const user = userEvent.setup();
    setup();
    const lock = await screen.findByLabelText('審查略過 lockfile 與產生檔');
    expect(lock).toBeChecked();
    const prd = screen.getByLabelText('實作只附相關的 PRD');
    expect(prd).not.toBeChecked();
    await user.click(prd);
    await act(async () => { await screen.getByRole('radio', { name: '自動' }).click(); });
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/config/mode', { mode: 'auto' }));
    expect(screen.getByLabelText('實作只附相關的 PRD')).toBeChecked();
    const card = screen.getByText('節省 Token').closest('section')!;
    await user.click(within(card).getByRole('button', { name: '儲存' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/config/token_saving', {
      token_saving: { review_diff_filter: true, prd_excerpt: true, dedupe_skills: false, code_map: false, terse: { reviewer: true, implementer: false, fixer: false, code_reviewer: false } },
    }));
  });

  it('切換模式與執行上限直接儲存到全域路由', async () => {
    const user = userEvent.setup();
    setup();
    await user.click(await screen.findByRole('radio', { name: '自動' }));
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/config/mode', { mode: 'auto' }));
    await user.selectOptions(screen.getByLabelText('上限'), '3');
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/queue/config', { max: 3 }));
  });
});
