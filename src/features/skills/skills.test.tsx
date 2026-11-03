import { render, screen, waitFor, within, act, fireEvent } from '@testing-library/react';
// 註：ResizablePanelGroup 在 jsdom 會攔下 pointer 事件，輸入框與分頁用 fireEvent 直接觸發；按鈕仍用 userEvent。
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { Skill, SkillRun, Snapshot } from '@/types/api';

const calls: { method: string; path: string; body: unknown }[] = [];
let skills: Skill[];
let runs: SkillRun[];
let importError = '';

vi.mock('@/lib/tauri', () => ({
  inTauri: false,
  invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd !== 'api') return null;
    const method = String(args?.method), path = String(args?.path), body = args?.body as Record<string, unknown> | null;
    calls.push({ method, path, body });
    const rest = path.replace(/^\/api\/p\/[0-9a-f]{10}\//, '');
    if (method === 'GET' && rest === 'skills') return { skills, stages: ['interview', 'prd', 'prd_review', 'tasks', 'implement', 'code_review', 'fix', 'handover'], config: { prd: ['to-spec'], implement: ['tdd'] } };
    if (method === 'GET' && rest === 'skills/runs') return { runs };
    if (rest === 'skills/import') { if (importError) throw new Error(importError); return { skill: { name: 'imported', compatible: true } }; }
    if (rest === 'skills/config') return { config: {} };
    if (rest === 'skills/run') {
      const run: SkillRun = { id: `run-new-${runs.length}`, name: String(body?.name), status: 'running', provider: body?.provider as 'claude', previousId: String(body?.previousId || ''), created_at: new Date(Date.now() - 65_000).toISOString(), messages: [{ role: 'user', text: String(body?.input), at: new Date().toISOString() }] };
      runs = [run, ...runs];
      return run;
    }
    return { ok: true };
  }),
  listen: vi.fn(async () => () => {}),
  dialogs: { pickSkillFolder: vi.fn(async () => null) },
  onFileDrop: vi.fn(async () => () => {}),
}));

import { SkillsPage } from '@/features/skills/SkillsPage';
import { useProject } from '@/stores/project';
import { projectApi } from '@/lib/api';
import { useBacklogDraft } from '@/stores/backlog-draft';

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  root: 'C:\\x', dataDir: '', project: { id: '0123456789', name: 'x' },
  config: { mode: 'manual', max_concurrent_runs: 1, max_fix_rounds: 3, max_prd_rounds: 2, num_tasks: 0, branch_prefix: '', roles: { interviewer: 'codex' }, models: {}, runtime: {} },
  runnerAlive: false, prdBusy: false, taskGenBusy: false, skillBusy: false, queue: null, prd: '', tasks: [], taskTag: '', taskRevision: '', taskReferences: null,
  usage: { measuredSessions: 0, unknownSessions: 0, providers: [], recent: [] }, permissions: [],
  state: { prd: { status: 'none', rounds: [] }, pipeline: { status: 'idle' }, control: {}, tasks: {} }, guards: {}, ...over,
});

function setup(over: Partial<Snapshot> = {}) {
  useProject.setState({ id: '0123456789', api: projectApi('0123456789'), snap: snap(over), logs: { 'skill-run-1': '[10:00:00] 🔧 Read SKILL.md' } });
  return render(<MemoryRouter initialEntries={['/p/0123456789/skills']}><SkillsPage /></MemoryRouter>);
}

beforeEach(() => {
  calls.length = 0; importError = '';
  skills = [
    { name: 'grill-me', description: '釐清需求', compatible: true, hasBuiltin: true, text: '---\nname: grill-me\ndescription: 釐清需求\n---\n# Grill\n每輪提問。', body: '# Grill\n每輪提問。', files: [] },
    { name: 'tdd', description: '紅綠循環', compatible: true, hasBuiltin: true, dir: 'C:\\skills\\tdd', text: '---\nname: tdd\n---\n# TDD', body: '# TDD', files: [{ path: 'SKILL.md', bytes: 120 }, { path: 'scripts/run.sh', bytes: 40 }] },
    { name: 'my-deploy', description: '部署', compatible: false, extensions: ['allowed-tools'], text: '---\nname: my-deploy\nallowed-tools: Bash\n---\n# Deploy', body: '# Deploy', dir: 'C:\\skills\\my-deploy', files: [] },
  ];
  runs = [
    { id: 'run-1', name: 'grill-me', status: 'done', provider: 'claude', created_at: '2026-11-03T01:00:00Z', updated_at: '2026-11-03T01:05:00Z', messages: [{ role: 'user', text: '我想做匯出報表\n細節', at: '2026-11-03T01:00:00Z' }, { role: 'assistant', text: '1. 誰會用？', at: '2026-11-03T01:05:00Z' }] },
  ];
  useBacklogDraft.setState({ title: '', detail: '', pending: false });
});

describe('Skills 頁', () => {
  it('側欄列出技能與來源／相容狀態，點選後右側顯示 frontmatter、資源檔與預覽，搜尋會篩選清單', async () => {
    const user = userEvent.setup();
    setup();
    const list = await screen.findByRole('list', { name: '共用技能' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(within(items[0]).getByText('內建')).toBeInTheDocument();
    expect(within(items[0]).getByText('相容')).toBeInTheDocument();
    expect(within(items[1]).getByText('內建・已修改')).toBeInTheDocument();
    expect(within(items[2]).getByText('匯入')).toBeInTheDocument();
    expect(within(items[2]).getByText('需調整')).toBeInTheDocument();
    // 預設選第一個技能
    expect(screen.getByRole('heading', { level: 2, name: 'grill-me' })).toBeInTheDocument();
    await user.click(within(items[1]).getByRole('button'));
    expect(screen.getByRole('heading', { level: 2, name: 'tdd' })).toBeInTheDocument();
    const meta = screen.getByLabelText('frontmatter');
    expect(within(meta).getByText('name')).toBeInTheDocument();
    expect(within(meta).getByText('Codex／Claude Code 共用')).toBeInTheDocument();
    expect(within(screen.getByLabelText('資源檔')).getByText('scripts/run.sh')).toHaveAttribute('title', '40 bytes');
    expect(within(screen.getByLabelText('SKILL.md 預覽')).getByRole('heading', { name: 'TDD' })).toBeInTheDocument();
    // 執行器專屬欄位
    await user.click(within(items[2]).getByRole('button'));
    expect(within(screen.getByLabelText('frontmatter')).getByText('allowed-tools（執行器專屬）')).toBeInTheDocument();
    expect(screen.getByText('需先轉寫：allowed-tools')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('搜尋技能'), { target: { value: 'tdd' } });
    expect(within(list).getAllByRole('listitem')).toHaveLength(1);
    expect(within(list).getByText('tdd')).toBeInTheDocument();
  });

  it('匯入失敗時顯示後端的拒絕原因並保持原本選取', async () => {
    const user = userEvent.setup();
    importError = '缺少 SKILL.md';
    setup();
    await screen.findByRole('heading', { level: 2, name: 'grill-me' });
    await act(async () => { window.dispatchEvent(new CustomEvent('ai-workflow:import-skills', { detail: { paths: ['C:\\bad'] } })); });
    await waitFor(() => expect(calls.some((c) => c.path.endsWith('skills/import') && (c.body as { path: string }).path === 'C:\\bad')).toBe(true));
    expect(screen.getByRole('heading', { level: 2, name: 'grill-me' })).toBeInTheDocument();
    // toast 內容（sonner 未掛載時只檢查 API 不再變動）
    expect(calls.filter((c) => c.path.endsWith('skills/import'))).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /匯入技能/ }));
  });

  it('工作流技能綁定：＋ 加入、× 移除，只有變更時能儲存，儲存送出全部階段', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByRole('list', { name: '共用技能' });
    await user.click(screen.getByRole('button', { name: /工作流技能綁定/ }));
    const save = screen.getByRole('button', { name: '儲存' });
    expect(save).toBeDisabled();
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(8);
    const prdRow = rows[1];
    expect(within(prdRow).getByText('to-spec')).toBeInTheDocument();
    await user.click(within(prdRow).getByRole('button', { name: '為PRD 起草／修訂加入技能' }));
    const menu = screen.getByRole('menu');
    expect(within(menu).queryByText('my-deploy')).not.toBeInTheDocument(); // 不相容的不列
    expect(within(menu).queryByText('to-spec')).not.toBeInTheDocument(); // 已綁定的不列
    await user.click(within(menu).getByRole('menuitem', { name: 'tdd' }));
    expect(within(prdRow).getByText('tdd')).toBeInTheDocument();
    expect(screen.getByText('有未儲存的變更。')).toBeInTheDocument();
    expect(save).toBeUsable();
    await user.click(within(rows[4]).getByRole('button', { name: '從實作移除 tdd' }));
    expect(within(rows[4]).queryByText('tdd')).not.toBeInTheDocument();
    await user.click(save);
    const call = calls.find((c) => c.path.endsWith('skills/config'));
    expect(call?.body).toEqual({ skills: { interview: [], prd: ['to-spec', 'tdd'], prd_review: [], tasks: [], implement: [], code_review: [], fix: [], handover: [] } });
    await waitFor(() => expect(screen.getByRole('button', { name: '儲存' })).toBeDisabled());
  });

  it('技能會議：送出只呼叫 skills/run 並帶 AI 與接續 id，回覆中顯示持續時間；完成的會議以 Markdown 顯示', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByRole('heading', { level: 2, name: 'grill-me' });
    fireEvent.mouseDown(screen.getByRole('tab', { name: /會議/ }), { button: 0 });
    // 預設顯示最近一場會議（已完成），AI 訊息是 Markdown
    expect(screen.getByRole('log')).toHaveTextContent('我想做匯出報表');
    // AI 訊息以 Markdown 渲染：「1. 誰會用？」變成有序清單
    expect(within(screen.getByRole('log')).getByRole('listitem')).toHaveTextContent('誰會用？');
    const select = screen.getByLabelText('會議') as HTMLSelectElement;
    expect(select.value).toBe('run-1');
    // 預設 AI 是需求釐清角色（codex）
    expect((screen.getByLabelText('會議使用的 AI') as HTMLSelectElement).value).toBe('codex');
    fireEvent.change(screen.getByLabelText('需求或回答'), { target: { value: '我要加欄位' } });
    await user.click(screen.getByRole('button', { name: '送出' }));
    const call = calls.find((c) => c.path.endsWith('skills/run'));
    expect(call?.body).toEqual({ name: 'grill-me', input: '我要加欄位', provider: 'codex', previousId: 'run-1' });
    expect(calls.some((c) => /prd|tasks\/generate|run\/start/.test(c.path))).toBe(false);
    await waitFor(() => expect(screen.getByLabelText('會議')).toHaveValue('run-new-1'), { timeout: 3000 });
    expect(screen.getByText(/正在回覆 · 查看執行紀錄（已 1 分 \d+ 秒）/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '送出' })).toBeDisabled();
    expect(screen.getByText(/AI 正在回覆/)).toBeInTheDocument();
  });

  it('「帶入需求待辦」把會議紀錄放進需求草稿', async () => {
    const user = userEvent.setup();
    setup();
    await screen.findByRole('heading', { level: 2, name: 'grill-me' });
    fireEvent.mouseDown(screen.getByRole('tab', { name: /會議/ }), { button: 0 });
    await user.click(screen.getByRole('button', { name: '帶入需求待辦' }));
    const draft = useBacklogDraft.getState();
    expect(draft.pending).toBe(true);
    expect(draft.title).toBe('我想做匯出報表');
    expect(draft.detail).toContain('user: 我想做匯出報表');
    expect(draft.detail).toContain('assistant: 1. 誰會用？');
  });
});
