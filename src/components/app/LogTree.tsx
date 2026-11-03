// 可展開的 log（像 Claude Code：每段工作包成一個區塊）。執行中的區塊預設展開、完成的收合；使用者手動展開／收合過的區塊重畫時保留。
// 捲到最底時自動跟隨新輸出；openAll 由父層的「全部展開／收合」切換。
// live：AI 正在打字的文字（還沒進 log），顯示在執行中的那個區塊最下面，結尾有游標。
import { useLayoutEffect, useMemo, useRef } from 'react';
import { parseLog, segmentLines, groupKey, type LogGroup, type LogLine } from '@/lib/log-parse';
import { PROVIDER_LABEL } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { useThrottled } from '@/hooks/use-throttled';
import { TypingCursor } from '@/components/app/StreamingReply';

function LiveText({ text }: { text: string }) {
  return <div className="whitespace-pre-wrap break-words py-0.5 text-xs" aria-live="polite">{text}<TypingCursor /></div>;
}

const STATUS_ICON = { running: '●', done: '✓', error: '✕' } as const;
const STATUS_TEXT = { running: '執行中', done: '完成', error: '失敗' } as const;

function Lines({ lines }: { lines: LogLine[] }) {
  if (!lines.length) return <p className="text-xs text-muted-foreground">（沒有輸出）</p>;
  return (
    <>
      {segmentLines(lines).map((seg, i) => seg.kind === 'tool' ? (
        <div key={i} className="mono flex gap-2 py-px text-xs"><span className="shrink-0 font-medium text-info">{seg.name}</span><span className="min-w-0 truncate text-muted-foreground" title={seg.arg}>{seg.arg}</span></div>
      ) : (
        <div key={i} className={cn('whitespace-pre-wrap break-words py-0.5 text-xs', seg.warn && 'text-warn')}>{seg.text}</div>
      ))}
    </>
  );
}

function Group({ item, open, onToggle, live }: { item: LogGroup; open: boolean; onToggle: (open: boolean) => void; live?: string }) {
  const tools = item.lines.filter((l) => l.text.startsWith('🔧')).length;
  const meta = [item.result, tools ? `${tools} 個工具呼叫` : '', item.secs != null ? `${item.secs}s` : item.status === 'running' ? '執行中' : '', item.time].filter(Boolean).join(' · ');
  return (
    <details open={open} className={cn('mb-1 rounded-md border bg-card', item.status === 'error' && 'border-danger/50')} onToggle={(e) => { const next = (e.currentTarget as HTMLDetailsElement).open; if (next !== open) onToggle(next); }}>
      <summary className="flex cursor-pointer items-center gap-2 px-2 py-1 text-xs select-none" aria-label={`${item.title}，${STATUS_TEXT[item.status]}`}>
        <span aria-hidden="true" className={cn('w-3 text-center', item.status === 'running' ? 'animate-pulse text-info' : item.status === 'done' ? 'text-ok' : 'text-danger')}>{STATUS_ICON[item.status]}</span>
        <span className="min-w-0 truncate font-medium">{item.title}</span>
        {item.kind === 'agent' ? (
          <>
            <span className={cn('rounded-full px-1.5 text-[10.5px] font-semibold', item.provider === 'codex' ? 'bg-review/15 text-review' : 'bg-info-soft text-info')}>{PROVIDER_LABEL[item.provider || ''] || item.provider}</span>
            <span className="text-muted-foreground">{item.mode}</span>
          </>
        ) : (
          <span className="rounded-full bg-surface-2 px-1.5 text-[10.5px] font-semibold text-muted-foreground">指令</span>
        )}
        <span className="ml-auto shrink-0 text-muted-foreground">{meta}</span>
      </summary>
      <div className="border-t px-2 py-1">
        {item.error && <div className="whitespace-pre-wrap py-0.5 text-xs text-warn">{item.error}</div>}
        {item.lines.length || !live ? <Lines lines={item.lines} /> : null}
        {live && <LiveText text={live} />}
      </div>
    </details>
  );
}

export function LogTree({ text, className, openAll, live: liveProp }: { text: string | null | undefined; className?: string; openAll?: boolean; live?: string }) {
  const live = useThrottled(liveProp || '');
  const box = useRef<HTMLDivElement>(null);
  // 使用者自己切換過的區塊：key → open（程式設定的不算）。
  const toggled = useRef(new Map<string, boolean>());
  const atBottom = useRef(true);
  const items = useMemo(() => parseLog(text), [text]);

  // 「全部展開／收合」：在畫出來之前就套到所有區塊（之後也維持，直到使用者再點）。
  const lastOpenAll = useRef<boolean | undefined>(undefined);
  if (openAll !== undefined && lastOpenAll.current !== openAll) {
    lastOpenAll.current = openAll;
    items.forEach((it, i) => { if (it.kind === 'agent' || it.kind === 'check') toggled.current.set(groupKey(it, i), openAll); });
  }

  // 重畫前記下是否在最底，重畫後跟隨。
  useLayoutEffect(() => {
    const el = box.current;
    if (el && atBottom.current) el.scrollTop = el.scrollHeight;
  }, [items, openAll, live]);
  const onScroll = () => { const el = box.current; if (el) atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 30; };

  if (!items.length) return <div ref={box} className={cn('overflow-auto', className)}>{live ? <LiveText text={live} /> : <p className="text-xs text-muted-foreground">（尚無 log）</p>}</div>;
  // 打字中的文字屬於最後一個還在執行的 AI 區塊；找不到就放在最後面。
  let liveAt = -1;
  if (live) items.forEach((it, i) => { if (it.kind === 'agent' && it.status === 'running') liveAt = i; });

  const out: React.ReactNode[] = [];
  let stray: LogLine[] = [];
  const flush = () => { if (stray.length) { out.push(<div key={`loose-${out.length}`} className="px-1 py-0.5"><Lines lines={stray} /></div>); stray = []; } };
  items.forEach((it, i) => {
    if (it.kind === 'line') { stray.push(it); return; }
    flush();
    if (it.kind === 'header') { out.push(<div key={`h-${i}`} className="mt-2 mb-1 border-b pb-0.5 text-xs font-semibold">{it.text}</div>); return; }
    const key = groupKey(it, i);
    const open = toggled.current.has(key) ? !!toggled.current.get(key) : it.status === 'running';
    out.push(<Group key={key} item={it} open={open || i === liveAt} live={i === liveAt ? live : undefined} onToggle={(o) => { toggled.current.set(key, o); }} />);
  });
  flush();
  if (live && liveAt < 0) out.push(<div key="live" className="px-1"><LiveText text={live} /></div>);
  return <div ref={box} onScroll={onScroll} className={cn('selectable overflow-auto', className)}>{out}</div>;
}
