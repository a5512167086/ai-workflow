// 任務 diff 檢視：GitHub 風格（左右並排或單欄、行號、檔案清單）。內容一律是文字節點，不會執行 diff 裡的 HTML。
import { useMemo, useState } from 'react';
import { parseUnifiedDiff, splitRows, DIFF_STATUS_TEXT, type DiffFile, type DiffLine } from '@/lib/diff-parse';
import { readStorage, writeStorage } from '@/lib/storage';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Mode = 'split' | 'unified';
const STATUS_CLASS = { added: 'text-ok bg-ok-soft', deleted: 'text-danger bg-danger-soft', renamed: 'text-info bg-info-soft', modified: 'text-warn bg-warn-soft' } as const;
const DOT_CLASS = { added: 'bg-ok', deleted: 'bg-danger', renamed: 'bg-info', modified: 'bg-warn' } as const;
const ROW: Record<DiffLine['type'], string> = { add: 'bg-ok-soft', del: 'bg-danger-soft', ctx: '', note: 'text-muted-foreground italic' };

function Stat({ adds, dels }: { adds: number; dels: number }) {
  return <span className="mono shrink-0 text-[11px]"><span className="text-ok">+{adds}</span> <span className="text-danger">−{dels}</span></span>;
}

const ln = 'mono w-10 select-none px-1 text-right align-top text-[11px] text-muted-foreground';
const code = 'mono whitespace-pre px-2 align-top text-[12px]';

function FileBlock({ file, mode, open, onToggle }: { file: DiffFile & { index: number }; mode: Mode; open: boolean; onToggle: (open: boolean) => void }) {
  return (
    <details id={`diff-file-${file.index}`} open={open} onToggle={(e) => { const next = (e.currentTarget as HTMLDetailsElement).open; if (next !== open) onToggle(next); }} className="mb-2 rounded-md border bg-card">
      <summary className="flex cursor-pointer items-center gap-2 px-2 py-1 text-xs select-none">
        <span className={cn('rounded-full px-1.5 text-[10.5px] font-semibold', STATUS_CLASS[file.status])}>{DIFF_STATUS_TEXT[file.status]}</span>
        <span className="mono min-w-0 truncate font-medium">{file.status === 'renamed' && file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}</span>
        <span className="ml-auto"><Stat adds={file.adds} dels={file.dels} /></span>
      </summary>
      {file.binary ? <p className="px-2 py-1 text-xs text-muted-foreground">二進位檔案，無法顯示文字差異</p>
        : !file.hunks.length ? <p className="px-2 py-1 text-xs text-muted-foreground">{file.status === 'renamed' ? '只有改名，內容沒有變更' : '沒有文字變更（空檔案或只改了權限）'}</p>
        : (
          <div className="overflow-auto border-t">
            <table className="w-full border-collapse">
              <tbody>
                {file.hunks.map((hunk, h) => (
                  <HunkRows key={h} hunk={hunk} mode={mode} />
                ))}
              </tbody>
            </table>
          </div>
        )}
    </details>
  );
}

function HunkRows({ hunk, mode }: { hunk: DiffFile['hunks'][number]; mode: Mode }) {
  const cols = mode === 'split' ? 4 : 3;
  const side = (line: DiffLine | null, which: 'left' | 'right') => line
    ? [<td key="n" className={cn(ln, ROW[line.type])}>{which === 'left' ? line.old : line.new}</td>, <td key="c" className={cn(code, ROW[line.type])}>{line.text}</td>]
    : [<td key="n" className={cn(ln, 'bg-surface-2')} />, <td key="c" className={cn(code, 'bg-surface-2')} />];
  return (
    <>
      <tr><td colSpan={cols} className="mono bg-info-soft px-2 py-0.5 text-[11px] text-info">{hunk.header}</td></tr>
      {mode === 'split'
        ? splitRows(hunk.lines).map((row, i) => row.note !== undefined
          ? <tr key={i}><td colSpan={cols} className={cn(code, ROW.note)}>{row.note}</td></tr>
          : <tr key={i}>{side(row.left, 'left')}{side(row.right, 'right')}</tr>)
        : hunk.lines.map((line, i) => line.type === 'note'
          ? <tr key={i}><td colSpan={cols} className={cn(code, ROW.note)}>{line.text}</td></tr>
          : <tr key={i} className={ROW[line.type]}><td className={ln}>{line.old}</td><td className={ln}>{line.new}</td><td className={code}>{line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}{line.text}</td></tr>)}
    </>
  );
}

export function DiffView({ text, className }: { text: string | null | undefined; className?: string }) {
  const files = useMemo(() => parseUnifiedDiff(text).map((f, index) => ({ ...f, index })), [text]);
  const [mode, setMode] = useState<Mode>(() => (readStorage('ai-workflow.diff-mode') === 'unified' ? 'unified' : 'split'));
  // 很長的檔案（例如自動產生的 lock 檔）預設收合，避免一次畫太多列。
  const [openMap, setOpenMap] = useState<Record<number, boolean>>({});
  if (!files.length) return <pre className={cn('mono selectable whitespace-pre-wrap text-xs', className)}>{text || '（尚無 diff）'}</pre>;
  const isOpen = (f: { index: number; adds: number; dels: number }) => openMap[f.index] ?? f.adds + f.dels <= 800;
  const allOpen = files.every(isOpen);
  const adds = files.reduce((n, f) => n + f.adds, 0), dels = files.reduce((n, f) => n + f.dels, 0);
  const choose = (m: Mode) => { setMode(m); writeStorage('ai-workflow.diff-mode', m); };
  return (
    <div className={cn('selectable flex min-h-0 flex-col text-xs', className)}>
      <div className="flex flex-wrap items-center gap-3 pb-2">
        <span>{files.length} 個檔案 <Stat adds={adds} dels={dels} /></span>
        <ToggleGroup type="single" value={mode} onValueChange={(v) => v && choose(v as Mode)} variant="outline" size="sm" aria-label="diff 顯示方式">
          <ToggleGroupItem value="split" aria-label="並排">並排</ToggleGroupItem>
          <ToggleGroupItem value="unified" aria-label="單欄">單欄</ToggleGroupItem>
        </ToggleGroup>
        <Button type="button" size="sm" variant="outline" onClick={() => setOpenMap(Object.fromEntries(files.map((f) => [f.index, !allOpen])))}>{allOpen ? '全部收合' : '全部展開'}</Button>
      </div>
      <div className="flex min-h-0 flex-1 gap-3">
        <nav aria-label="變更的檔案" className="hidden w-52 shrink-0 overflow-auto md:block">
          <ul>
            {files.map((f) => {
              const parts = f.path.split('/'); const base = parts.pop();
              return (
                <li key={f.index}>
                  <button type="button" title={f.path} className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left hover:bg-accent" onClick={() => { setOpenMap((m) => ({ ...m, [f.index]: true })); document.getElementById(`diff-file-${f.index}`)?.scrollIntoView({ block: 'start' }); }}>
                    <span className={cn('size-1.5 shrink-0 rounded-full', DOT_CLASS[f.status])} aria-hidden="true" />
                    <span className="mono min-w-0 truncate">{base}</span>
                    {parts.length > 0 && <span className="mono min-w-0 truncate text-muted-foreground">{parts.join('/')}</span>}
                    <span className="ml-auto"><Stat adds={f.adds} dels={f.dels} /></span>
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>
        <div className="min-w-0 flex-1 overflow-auto">
          {files.map((f) => <FileBlock key={f.index} file={f} mode={mode} open={isOpen(f)} onToggle={(o) => setOpenMap((m) => ({ ...m, [f.index]: o }))} />)}
        </div>
      </div>
    </div>
  );
}
