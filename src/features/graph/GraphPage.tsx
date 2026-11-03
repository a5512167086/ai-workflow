// 架構圖：專案圖譜（tree-sitter 本機解析）的互動圖（沙箱 iframe）與 GRAPH_REPORT.md。
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Page, PageHeader, Hint } from '@/components/app/Page';
import { Markdown } from '@/components/app/Markdown';
import { usageTime } from '@/lib/format';
import { useProject } from '@/stores/project';
import type { GraphSummary } from '@/types/api';

export function GraphPage() {
  const api = useProject((s) => s.api);
  const [graph, setGraph] = useState<GraphSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [html, setHtml] = useState('');
  const [reportOpen, setReportOpen] = useState(true);
  const htmlRef = useRef('');

  /** 讀取上次建立的圖譜；build 為 true 時先重新建立（只解析改過的檔案）。 */
  const load = useCallback(async (build = false) => {
    setBusy(true);
    setStatus(build ? '正在建立專案圖譜（本機解析，不花 AI token）…' : '');
    try {
      const data = build ? await api<GraphSummary>('/api/graph/build', {}) : await api<GraphSummary>('/api/graph');
      setGraph(data);
      // 互動圖是獨立的頁面（含自己的 script）；內容沒變就不重載，保留使用者的縮放與選取。
      const next = data?.exists ? data.html || '' : '';
      if (next !== htmlRef.current) { htmlRef.current = next; setHtml(next); }
      if (build) setStatus('已重新建立');
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [api]);

  useEffect(() => { load(); }, [load]);

  const s = graph?.stats;
  const summary = graph?.exists && s
    ? `${s.files} 個檔案 · ${s.nodes} 個節點 · ${s.edges} 條關係 · ${s.communities} 個分群 · 建立於 ${usageTime(graph.builtAt)}${graph.commit ? ` · commit ${String(graph.commit).slice(0, 8)}` : ''}`
    : '還沒有建立專案圖譜：按「重新建立」，或在實作任務時自動建立';

  return (
    <Page>
      <PageHeader
        title="專案圖譜"
        description={summary}
        actions={<Button variant="outline" onClick={() => load(true)} disabled={busy}><RefreshCw className={busy ? 'animate-spin' : ''} />重新建立</Button>}
      />
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-4">
        <div className="shrink-0 space-y-1">
          <Hint>以 tree-sitter 在本機解析 Rust、JavaScript、TypeScript、Python、Go、Java 的定義、匯入、呼叫與繼承，不花 AI token；設計參考 <span className="mono">graphify</span>。開啟「設定 → 節省 Token → 專案圖譜」時，每次實作與修正前會自動更新，並依任務內容把相關的節點與關係附給 AI，取代整個專案搜尋。</Hint>
          {status && <Hint role="status">{status}</Hint>}
        </div>
        {graph?.exists && (
          <div className="min-h-[360px] shrink-0 overflow-hidden rounded-lg border bg-card" style={{ height: '60vh' }}>
            <iframe title="專案圖譜互動圖" sandbox="allow-scripts" srcDoc={html} className="h-full w-full border-0 bg-background" />
          </div>
        )}
        {graph?.exists && (
          <Collapsible open={reportOpen} onOpenChange={setReportOpen} className="shrink-0 rounded-lg border bg-card">
            <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left">
              <ChevronDown className={`size-4 transition-transform ${reportOpen ? '' : '-rotate-90'}`} />
              <h2 className="text-[13px] font-semibold">GRAPH_REPORT.md</h2>
              <span className="mono ml-auto truncate text-[11px] text-muted-foreground">{graph.paths?.report || ''}</span>
            </CollapsibleTrigger>
            <CollapsibleContent className="border-t px-3 py-3">
              <Markdown text={graph.report || ''} />
            </CollapsibleContent>
          </Collapsible>
        )}
      </div>
    </Page>
  );
}
