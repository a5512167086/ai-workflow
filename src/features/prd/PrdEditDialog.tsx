// 人工編輯 PRD：左邊 Markdown 原文、右邊即時預覽；存成新版本並保留紀錄，之後需重新審查或核准。
// 點到對話框外面不會關閉（避免誤點丟掉編輯），用 Esc 或「取消」關。
import { useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from '@/components/ui/resizable';
import { Markdown } from '@/components/app/Markdown';
import { Notice } from '@/components/app/Page';
import { errorMessage } from '@/lib/api';
import { useProject } from '@/stores/project';

export function PrdEditDialog({ onClose }: Readonly<{ onClose: () => void }>) {
  const snap = useProject((s) => s.snap)!;
  const api = useProject((s) => s.api);
  // 開啟當下的版本：儲存時帶上，避免覆蓋別的視窗改過的 PRD。
  const [source] = useState(() => ({ text: snap.prd || '', version: snap.state.prd.version, scope: snap.state.prd.reference_scope ?? null }));
  const [text, setText] = useState(source.text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const save = async () => {
    if (saving) return;
    setSaving(true); setError('');
    try {
      await api('/api/prd/save', { ...source, text });
      await useProject.getState().refresh();
      toast.success('已保存人工版本，請重新審查或核准');
      onClose();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !saving) onClose(); }}>
      <DialogContent className="flex h-[85vh] w-[90vw] max-w-[90vw] flex-col gap-3 p-4 sm:max-w-[90vw]" onEscapeKeyDown={(e) => { if (saving) e.preventDefault(); }} onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader>
          <DialogTitle>人工編輯 PRD</DialogTitle>
          <DialogDescription>儲存為新版本，保留舊版與人工修改紀錄。儲存後需重新核准 PRD；舊版任務不能直接執行。</DialogDescription>
        </DialogHeader>
        <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1 rounded-md border">
          <ResizablePanel id="prd-edit-source" defaultSize="50" minSize={240} className="flex min-h-0">
            <textarea
              className="mono selectable h-full w-full resize-none bg-transparent p-3 text-xs leading-[1.6] outline-none"
              aria-label="PRD Markdown"
              spellCheck={false}
              value={text}
              onChange={(e) => setText(e.target.value)}
              data-autofocus
            />
          </ResizablePanel>
          <ResizableHandle withHandle />
          <ResizablePanel id="prd-edit-preview" defaultSize="50" minSize={240} className="min-h-0 overflow-auto bg-surface-2/40 p-3">
            <div aria-label="PRD 即時預覽"><Markdown text={text} /></div>
          </ResizablePanel>
        </ResizablePanelGroup>
        {error && <Notice tone="bad" role="alert">{error}</Notice>}
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>取消</Button>
          <Button onClick={save} disabled={saving}>{saving ? '儲存中…' : '儲存修改'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
