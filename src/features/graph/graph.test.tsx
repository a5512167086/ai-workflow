import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { GraphPage } from './GraphPage';
import { useProject } from '@/stores/project';
import { useUi } from '@/stores/ui';

describe('架構圖', () => {
  it('沒有圖譜時提示建立', async () => {
    const api = vi.fn(async () => ({ exists: false }));
    useProject.setState({ api: api as never });
    render(<GraphPage />);
    await waitFor(() => expect(api).toHaveBeenCalledWith('/api/graph'));
    expect(screen.getByText(/還沒有建立專案圖譜/)).toBeInTheDocument();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('有圖譜時顯示統計、報告與沙箱裡的互動圖；重新建立只呼叫 graph/build', async () => {
    const graph = { exists: true, stats: { files: 3, nodes: 10, edges: 12, communities: 2 }, builtAt: '2026-11-01T00:00:00Z', commit: 'abcdef1234567890', paths: { report: 'C:\\x\\GRAPH_REPORT.md' }, report: '# 報告\n\n重點', html: '<html><body>graph</body></html>' };
    const api = vi.fn(async (path: string) => (path === '/api/graph' || path === '/api/graph/build' ? graph : Promise.reject(new Error(path))));
    useProject.setState({ api: api as never });
    render(<GraphPage />);
    await screen.findByText(/3 個檔案 · 10 個節點 · 12 條關係 · 2 個分群/);
    expect(screen.getByText(/commit abcdef12/)).toBeInTheDocument();
    expect(screen.getByText('重點')).toBeInTheDocument();
    const frame = document.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    expect(frame.getAttribute('srcdoc')).toContain('graph');
    api.mockClear();
    await userEvent.click(screen.getByRole('button', { name: '重新建立' }));
    await screen.findByText('已重新建立');
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('/api/graph/build', {});
  });

  it('讀取中顯示轉圈；互動圖的 iframe 載完後拿掉「正在載入互動圖」遮罩', async () => {
    let resolve!: (v: unknown) => void;
    const api = vi.fn(() => new Promise((r) => { resolve = r; }));
    useProject.setState({ api: api as never });
    render(<GraphPage />);
    expect(screen.getByRole('status')).toHaveTextContent('正在讀取專案圖譜…');
    expect(screen.queryByText(/還沒有建立專案圖譜/)).not.toBeInTheDocument();
    resolve({ exists: true, stats: { files: 1, nodes: 1, edges: 0, communities: 1 }, report: '', html: '<html></html>' });
    const frame = await waitFor(() => { const el = document.querySelector('iframe'); if (!el) throw new Error('no iframe'); return el; });
    // jsdom 也可能自己觸發 iframe 的 load；不論哪一個先到，載完後遮罩都要拿掉。
    fireEvent.load(frame);
    await waitFor(() => expect(screen.queryByText('正在載入互動圖…')).not.toBeInTheDocument());
  });

  it('互動圖跟著 App 的主題、記住拖好的側欄寬度（沙箱 iframe 用 postMessage）', async () => {
    localStorage.removeItem('ai-workflow.graph.aside');
    useUi.setState({ dark: true });
    const api = vi.fn(async () => ({ exists: true, stats: { files: 1, nodes: 1, edges: 0, communities: 1 }, report: '', html: '<html></html>' }));
    useProject.setState({ api: api as never });
    render(<GraphPage />);
    const frame = await waitFor(() => { const el = document.querySelector('iframe'); if (!el?.contentWindow) throw new Error('no iframe'); return el; });
    const post = vi.spyOn(frame.contentWindow!, 'postMessage');
    const fromFrame = (data: unknown) => fireEvent(window, new MessageEvent('message', { data, source: frame.contentWindow, origin: 'null' }));
    fromFrame({ type: 'ai-workflow-graph-ready' });
    expect(post).toHaveBeenLastCalledWith({ type: 'ai-workflow-graph', dark: true, aside: undefined }, '*');
    fromFrame({ type: 'ai-workflow-graph-aside', width: 362.4 });
    expect(localStorage.getItem('ai-workflow.graph.aside')).toBe('362');
    // 同一個視窗但來源不是沙箱的不透明來源 "null"：不理會
    fireEvent(window, new MessageEvent('message', { data: { type: 'ai-workflow-graph-aside', width: 777 }, source: frame.contentWindow, origin: 'https://evil.example' }));
    expect(localStorage.getItem('ai-workflow.graph.aside')).toBe('362');
    // 別的來源的訊息不理會
    fireEvent(window, new MessageEvent('message', { data: { type: 'ai-workflow-graph-aside', width: 999 } }));
    expect(localStorage.getItem('ai-workflow.graph.aside')).toBe('362');
    act(() => useUi.setState({ dark: false }));
    expect(post).toHaveBeenLastCalledWith({ type: 'ai-workflow-graph', dark: false, aside: 362 }, '*');
  });
});
