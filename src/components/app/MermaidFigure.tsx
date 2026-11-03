// Mermaid 圖表：離線的 mermaid（打包進前端，動態載入）、strict 安全模式、跟隨深淺色主題；保留原始碼可複製，SVG 可下載。
// 繪圖排成一條佇列（mermaid 全域 initialize 不能同時用不同主題），語法錯誤時退回可閱讀的原始碼。
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useUi } from '@/stores/ui';

let queue: Promise<unknown> = Promise.resolve();
let serial = 0;

async function renderMermaid(source: string, dark: boolean): Promise<string> {
  if (source.length > 30000 || /%%\s*\{/.test(source) || /^[ \t]*---/m.test(source)) throw new Error('圖表過大或含自訂設定，請使用下方原始碼');
  const { default: mermaid } = await import('mermaid');
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: dark ? 'dark' : 'default', fontFamily: 'Segoe UI, Microsoft JhengHei, sans-serif', flowchart: { htmlLabels: false }, maxTextSize: 30000 });
  const { svg } = await mermaid.render(`chat-diagram-${++serial}`, source);
  return svg;
}

export function MermaidFigure({ source }: { source: string }) {
  const dark = useUi((s) => s.dark);
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const preview = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setSvg(null); setError(null);
    const job = queue.then(() => renderMermaid(source, dark)).then((out) => { if (alive) setSvg(out); }, (err) => { if (alive) setError(String(err?.message || err)); });
    queue = job.catch(() => {});
    return () => { alive = false; };
  }, [source, dark]);

  // SVG 是 mermaid（strict 模式）產生的，不是 AI 內容；用 innerHTML 放進預覽。
  useEffect(() => { if (preview.current) preview.current.innerHTML = svg || ''; }, [svg]);

  const copy = async () => {
    try { await navigator.clipboard.writeText(source); toast.success('已複製圖表原始碼'); }
    catch { toast.error('無法複製，請展開原始碼自行選取'); }
  };
  const download = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!svg) return;
    const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
    e.currentTarget.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  };

  return (
    <figure className="my-2 rounded-md border bg-card p-2">
      {error ? (
        <p className="text-xs text-muted-foreground">圖表無法預覽：{error}</p>
      ) : svg ? (
        <div ref={preview} className="overflow-auto [&_svg]:mx-auto [&_svg]:max-w-full" />
      ) : (
        <p className="text-xs text-muted-foreground">正在繪製圖表…</p>
      )}
      <figcaption className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>架構／流程圖</span>
        <Button type="button" size="sm" variant="outline" onClick={copy}>複製 Mermaid</Button>
        {svg && <a className="inline-flex h-7 items-center rounded-md border px-2.5 text-xs font-medium hover:bg-accent" href="#" download={`architecture-${serial}.svg`} onClick={download}>下載 SVG</a>}
      </figcaption>
      <details className="mt-2" open={!!error}>
        <summary className="text-xs text-muted-foreground">Mermaid 原始碼</summary>
        <pre className="md-code mt-1" data-lang="mermaid"><code>{source}</code></pre>
      </details>
    </figure>
  );
}
