import { describe, expect, it, vi, beforeEach } from 'vitest';

const invoke = vi.fn();
vi.mock('@/lib/tauri', () => ({ invoke: (...args: unknown[]) => invoke(...args), inTauri: false }));

import { api, projectApi, act } from '@/lib/api';

describe('api', () => {
  // 注意：hook 回傳函式會被當成清理函式，所以不能寫成 () => invoke.mockClear()。
  beforeEach(() => { invoke.mockClear(); });

  it('沒有 body 是 GET，有 body 是 POST，都走 Tauri command api', async () => {
    invoke.mockResolvedValue({ ok: true });
    await api('/api/projects');
    expect(invoke).toHaveBeenLastCalledWith('api', { method: 'GET', path: '/api/projects', body: null });
    await api('/api/projects/add', { path: 'C:\\x' });
    expect(invoke).toHaveBeenLastCalledWith('api', { method: 'POST', path: '/api/projects/add', body: { path: 'C:\\x' } });
  });

  it('專案範圍的 API 自動加上 /api/p/<id>，全域路由不變', async () => {
    invoke.mockResolvedValue({});
    const call = projectApi('0123456789');
    await call('/api/state');
    expect(invoke).toHaveBeenLastCalledWith('api', expect.objectContaining({ path: '/api/p/0123456789/state' }));
    await call('/api/projects/open', { id: '0123456789' });
    expect(invoke).toHaveBeenLastCalledWith('api', expect.objectContaining({ path: '/api/projects/open' }));
    await call('/api/queue/config', { max: 2 });
    expect(invoke).toHaveBeenLastCalledWith('api', expect.objectContaining({ path: '/api/queue/config' }));
  });

  it('act 失敗時回傳 null 並把錯誤訊息交給 toast', async () => {
    invoke.mockImplementation(() => Promise.reject(new Error('後端拒絕')));
    const result = await act(api, '/api/run/start', {}, '流程已開始');
    expect(result).toBeNull();
  });
});
