// 參考資料選擇視窗：原生檔案／資料夾選擇器、路徑輸入、拖放、可重用的快照清單；「套用」才建立綁定，「取消」保留原選取。
import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Hint } from '@/components/app/Page';
import { dialogs, inTauri } from '@/lib/tauri';
import { errorMessage } from '@/lib/api';
import { useProject } from '@/stores/project';
import { useReferences } from '@/stores/references';
import { importReference, uploadReference, saveReferenceSelection, MAX_IMPORT_BATCH, MAX_REFERENCES, type ReferenceOptions } from '@/features/references/options';
import type { ReferenceItem } from '@/types/api';

interface DialogRequest { options: ReferenceOptions; onSaved?: () => void }

type Listener = (req: DialogRequest | null) => void;
const listeners = new Set<Listener>();
let current: DialogRequest | null = null;
/** 視窗開著時，視窗層級的拖放會把路徑丟進來（由 ReferenceDropHost 呼叫）。 */
let importPaths: ((paths: string[]) => void) | null = null;

export function isReferenceDialogOpen() { return !!current; }
export function importPathsIntoDialog(paths: string[]) { importPaths?.(paths); }

/** 開啟選擇視窗；已經開著就不重複開。 */
export function openReferenceDialog(options: ReferenceOptions, onSaved?: () => void) {
  if (current) return;
  current = { options, onSaved };
  for (const fn of listeners) fn(current);
}

type Job = () => Promise<ReferenceItem>;

export function ReferenceDialogHost() {
  const [req, setReq] = useState<DialogRequest | null>(current);
  useEffect(() => { listeners.add(setReq); return () => { listeners.delete(setReq); }; }, []);
  if (!req) return null;
  return <ReferenceDialog key={req.options.title + req.options.key} req={req} close={() => { current = null; importPaths = null; setReq(null); }} />;
}

function ReferenceDialog({ req, close }: { req: DialogRequest; close: () => void }) {
  const { options } = req;
  const catalog = useReferences((s) => s.catalog);
  const api = useProject((s) => s.api);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(options.ids || []));
  const [status, setStatus] = useState('');
  const [importing, setImporting] = useState(false);
  const [path, setPath] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);
  const importingRef = useRef(false);

  useEffect(() => {
    useReferences.getState().refresh(api).catch((err) => setStatus(errorMessage(err)));
  }, [api]);

  const runJobs = async (jobs: Job[]) => {
    if (importingRef.current || !jobs.length) return;
    importingRef.current = true; setImporting(true); setStatus('正在建立參考快照…');
    const errors: string[] = []; let count = 0;
    const added = new Set<string>();
    for (const job of jobs.slice(0, MAX_IMPORT_BATCH)) {
      try { const item = await job(); added.add(item.id); count++; } catch (err) { errors.push(errorMessage(err)); }
    }
    if (jobs.length > MAX_IMPORT_BATCH) errors.push(`一次最多匯入 ${MAX_IMPORT_BATCH} 項，其餘請再次加入`);
    setChosen((prev) => new Set([...prev, ...added]));
    setStatus([count ? `已加入 ${count} 份資料，按「套用」使用。` : '', ...errors].filter(Boolean).join('\n'));
    importingRef.current = false; setImporting(false);
  };
  useEffect(() => {
    importPaths = (paths) => { void runJobs(paths.map((p) => () => importReference({ path: p }))); };
    return () => { importPaths = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickFiles = async () => {
    try {
      if (!inTauri) { fileInput.current?.click(); return; }
      const paths = await dialogs.pickReferenceFiles();
      await runJobs((paths || []).map((p) => () => importReference({ path: p })));
    } catch (err) { setStatus(errorMessage(err)); }
  };
  const pickFolder = async () => {
    try {
      const dir = await dialogs.pickReferenceFolder();
      if (dir) await runJobs([() => importReference({ path: dir })]);
    } catch (err) { setStatus(`${errorMessage(err)}；也可以貼上完整路徑。`); }
  };
  const addPath = () => { const p = path.trim(); if (p) void runJobs([() => importReference({ path: p })]); };
  const apply = async () => {
    try {
      if (chosen.size > MAX_REFERENCES) throw new Error(`最多選取 ${MAX_REFERENCES} 份參考資料`);
      await saveReferenceSelection(options, [...chosen]);
      await req.onSaved?.();
      close();
    } catch (err) { setStatus(errorMessage(err)); }
  };
  const items = [...catalog.values()];
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !importingRef.current) close(); }}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-3 sm:max-w-xl" onDragOver={(e) => e.preventDefault()} onDrop={(e) => { e.preventDefault(); void runJobs([...e.dataTransfer.files].map((f) => () => uploadReference(f))); }} onEscapeKeyDown={(e) => { if (importingRef.current) e.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>{options.title}</DialogTitle>
          <DialogDescription>加入檔案、圖片、PDF 或資料夾。資料會保存為專案內的快照，來源更新後請重新加入。可拖放到這個視窗。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" disabled={importing} onClick={pickFiles}>選擇檔案</Button>
          <Button type="button" variant="outline" disabled={importing} onClick={pickFolder}>選擇資料夾</Button>
          <input ref={fileInput} type="file" multiple hidden onChange={(e) => { const files = [...(e.target.files || [])]; e.target.value = ''; void runJobs(files.map((f) => () => uploadReference(f))); }} />
        </div>
        <div className="flex gap-2">
          <Input value={path} disabled={importing} aria-label="參考檔案或資料夾路徑" placeholder="貼上檔案或資料夾完整路徑" className="mono" onChange={(e) => setPath(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); addPath(); } }} />
          <Button type="button" variant="outline" disabled={importing} onClick={addPath}>加入路徑</Button>
        </div>
        <Hint>單檔 20 MB；每份資料夾 64 MB／2000 檔。資料夾會排除 .git、node_modules、建置產物、.env、金鑰與連結。其他格式提供原始快照，能否解析取決於 CLI 工具。</Hint>
        {status && <p role="status" className="whitespace-pre-line text-xs text-foreground">{status}</p>}
        <div className="min-h-0 flex-1 overflow-auto rounded-md border" aria-label="已加入的參考資料">
          {!items.length && <p className="p-3 text-xs text-muted-foreground">尚未加入參考資料</p>}
          {items.map((item) => (
            <label key={item.id} className="flex cursor-pointer items-start gap-2 border-b px-3 py-2 text-xs last:border-b-0 hover:bg-accent/50">
              <Checkbox className="mt-0.5" checked={chosen.has(item.id)} disabled={importing} aria-label={item.name} onCheckedChange={(on) => setChosen((prev) => { const next = new Set(prev); if (on) next.add(item.id); else next.delete(item.id); return next; })} />
              <span className="min-w-0 flex-1">
                <b className="block truncate">{item.name}</b>
                <small className="block whitespace-pre-line text-muted-foreground">
                  {`${item.kind === 'folder' ? '資料夾' : '檔案'} · ${item.fileCount} 檔 · ${Math.ceil(item.totalBytes / 1024)} KB${item.excludedCount ? ` · 排除 ${item.excludedCount} 項` : ''}\n${item.sourcePath}${item.warnings?.length ? `\n${item.warnings.join('；')}` : ''}`}
                </small>
              </span>
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={importing} onClick={close}>取消</Button>
          <Button type="button" disabled={importing} onClick={apply}>套用參考資料</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
