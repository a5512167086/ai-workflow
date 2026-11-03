// 安全的 Markdown 渲染：react-markdown 不會輸出原始 HTML（AI 產生的內容一律當文字）；連結只允許 http(s)／mailto／相對路徑。
// ```mermaid 區塊交給 MermaidFigure（離線繪圖，strict 模式）。
import { lazy, Suspense, type ComponentProps } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cn } from '@/lib/utils';

const MermaidFigure = lazy(() => import('@/components/app/MermaidFigure').then((m) => ({ default: m.MermaidFigure })));

function safeUrl(raw?: string) {
  const url = (raw || '').replace(/[\u0000- \u007f]/g, '');
  if (/^(https?:|mailto:)/i.test(url)) return url;
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return null;
  return url;
}

function makeComponents(streaming: boolean): ComponentProps<typeof ReactMarkdown>['components'] {
  return {
  a: ({ href, children, title }) => {
    const url = safeUrl(href);
    if (url === null) return <>{children}</>;
    const external = /^(https?:|mailto:)/i.test(url);
    return <a href={url} title={title} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined}>{children}</a>;
  },
  // 離線工具：圖片不載入，改成連結文字。
  img: ({ src, alt }) => <span className="text-muted-foreground">圖片：{alt || String(src || '')}</span>,
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, ...rest }) => {
    const lang = /language-(\w+)/.exec(className || '')?.[1];
    const source = String(children ?? '').replace(/\n$/, '');
    const block = !!lang || source.includes('\n');
    if (!block) return <code className={className} {...rest}>{children}</code>;
    // 打字中的圖表可能還沒寫完，先顯示原始碼。
    if (lang === 'mermaid' && !streaming) return <Suspense fallback={<pre><code>{source}</code></pre>}><MermaidFigure source={source} /></Suspense>;
    return <pre className="md-code" data-lang={lang || ''}><code className={className}>{source}</code></pre>;
  },
  };
}
const components = makeComponents(false);
const streamingComponents = makeComponents(true);

export function Markdown({ text, className, small, streaming }: { text: string; className?: string; small?: boolean; streaming?: boolean }) {
  return (
    <div className={cn('md selectable', small && 'md-sm', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={streaming ? streamingComponents : components} skipHtml>
        {text || ''}
      </ReactMarkdown>
    </div>
  );
}
