// 架構圖：專案圖譜（tree-sitter 本機解析）的互動圖（沙箱 iframe）與 GRAPH_REPORT.md。
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Page, PageHeader, Hint, Loading } from '@/components/app/Page';
import { Markdown } from '@/components/app/Markdown';
import { usageTime } from '@/lib/format';
import { readStorage, writeStorage } from '@/lib/storage';
import { useUi } from '@/stores/ui';
import { useProject } from '@/stores/project';
import type { GraphSummary } from '@/types/api';

const ASIDE_KEY = 'ai-workflow.graph.aside';

/**
 * 互動圖在沙箱 iframe 裡（不能讀 App 的主題，也不能用 localStorage）：
 * App 把主題與記住的側欄寬度用 postMessage 傳進去，互動圖拖好寬度後再傳回來記住。
 */
function useGraphFrame(frame: React.RefObject<HTMLIFrameElement | null>) {
  const dark = useUi((s) => s.dark);
  const send = useCallback(() => {
    const aside = Number(readStorage(ASIDE_KEY)) || undefined;
    // 沙箱 iframe（沒有 allow-same-origin）的來源是不透明的 "null"，沒有可以指定的 targetOrigin，只能用 '*'；
    // 傳的只有主題與側欄寬度，不含任何敏感資料。
    frame.current?.contentWindow?.postMessage({ type: 'ai-workflow-graph', dark, aside }, '*'); // NOSONAR：不透明來源無法指定 targetOrigin，內容不敏感
  }, [frame, dark]);
  useEffect(() => { send(); }, [send]);
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      // 只接受我們自己的沙箱 iframe：視窗是它、來源是沙箱的不透明來源 "null"。
      if (e.origin !== 'null' || !frame.current || e.source !== frame.current.contentWindow) return;
      if (e.data?.type === 'ai-workflow-graph-ready') send();
      if (e.data?.type === 'ai-workflow-graph-aside' && typeof e.data.width === 'number') writeStorage(ASIDE_KEY, String(Math.round(e.data.width)));
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [frame, send]);
  return send;
}

/** 標題下的一行說明：統計與建立時間；還沒有圖譜或讀取中時給提示。 */
function graphSummary(graph: GraphSummary | null): string {
  if (!graph) return '讀取中…';
  const s = graph.stats;
  if (!graph.exists || !s) return '還沒有建立專案圖譜：按「重新建立」，或在實作任務時自動建立';
  const commit = graph.commit ? ' · commit ' + String(graph.commit).slice(0, 8) : '';
  return `${s.files} 個檔案 · ${s.nodes} 個節點 · ${s.edges} 條關係 · ${s.communities} 個分群 · 建立於 ${usageTime(graph.builtAt)}${commit}`;
}

export function GraphPage() {
  const api = useProject((s) => s.api);
  const [graph, setGraph] = useState<GraphSummary | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [html, setHtml] = useState('');
  const [reportOpen, setReportOpen] = useState(true);
  // 互動圖的 iframe 載完（約 1 MB 的頁面要解析）之前蓋一層讀取中；排版中的轉圈由互動圖自己顯示。
  const [frameReady, setFrameReady] = useState(false);
  const htmlRef = useRef('');
  const frameRef = useRef<HTMLIFrameElement>(null);
  const sendToFrame = useGraphFrame(frameRef);

  /** 讀取上次建立的圖譜；build 為 true 時先重新建立（只解析改過的檔案）。 */
  const load = useCallback(async (build = false) => {
    setBusy(true);
    setStatus(build ? '正在建立專案圖譜（本機解析，不花 AI token）…' : '');
    try {
      const data = build ? await api<GraphSummary>('/api/graph/build', {}) : await api<GraphSummary>('/api/graph');
      setGraph(data);
      // 互動圖是獨立的頁面（含自己的 script）；內容沒變就不重載，保留使用者的縮放與選取。
      const next = data?.exists ? data.html || '' : '';
      if (next !== htmlRef.current) { htmlRef.current = next; setHtml(next); setFrameReady(false); }
      if (build) setStatus('已重新建立');
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      setBusy(false);
    }
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const building = busy && status.startsWith('正在');
  const summary = graphSummary(graph);

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
          {building ? <Loading inline label={status} /> : status && <Hint role="status">{status}</Hint>}
        </div>
        {!graph && busy && <Loading label="正在讀取專案圖譜…" className="min-h-[360px] rounded-lg border bg-card" />}
        {graph?.exists && (
          <div className="relative min-h-[360px] shrink-0 overflow-hidden rounded-lg border bg-card" style={{ height: '60vh' }}>
            <iframe title="專案圖譜互動圖" sandbox="allow-scripts" srcDoc={html} ref={frameRef} onLoad={() => { setFrameReady(true); sendToFrame(); }} className="h-full w-full border-0 bg-background" />
            {!frameReady && <Loading label="正在載入互動圖…" className="absolute inset-0 bg-card" />}
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
