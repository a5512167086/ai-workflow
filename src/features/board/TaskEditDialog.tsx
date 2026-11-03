// 人工編輯任務：可修改需求、驗收條件、優先序與依賴。實質修改後，此任務、同組子任務及後續依賴會重新待辦，並撤回任務核准。
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Notice } from '@/components/app/Page';
import { useProject } from '@/stores/project';
import type { TaskDetail } from '@/types/api';
import { EDIT_FIELDS, editableTask, fieldToText, textToField } from './board-logic';

export function TaskEditDialog({ detail, open, onOpenChange, onSaved }: Readonly<{ detail: TaskDetail | null; open: boolean; onOpenChange: (open: boolean) => void; onSaved?: () => void }>) {
  const api = useProject((s) => s.api);
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  // 只在打開時從目前的任務填入；之後詳情重新讀取不覆蓋正在編輯的內容。
  const detailId = detail?.id;
  useEffect(() => {
    if (!open || !detail) return;
    const task = editableTask(detail);
    setValues(Object.fromEntries(EDIT_FIELDS.map(([key, , type]) => [key, fieldToText(task, key, type)])));
    setError('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, detailId]);
  if (!detail) return null;
  const save = async () => {
    if (saving) return;
    setSaving(true); setError('');
    try {
      const snap = useProject.getState().snap;
      const patch = Object.fromEntries(EDIT_FIELDS.map(([key, , type]) => [key, textToField(values[key] || '', type)]));
      await api('/api/task/save', { id: detail.id, tag: detail.tag ?? snap?.taskTag, revision: detail.revision ?? snap?.taskRevision, task: patch });
      await useProject.getState().refresh();
      onSaved?.();
      toast.success('任務已保存，請檢視後重新核准');
      onOpenChange(false);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving) onOpenChange(next); }}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-2xl" onEscapeKeyDown={(e) => { if (saving) e.preventDefault(); }} onInteractOutside={(e) => { if (saving) e.preventDefault(); }}>
        <DialogHeader>
          <DialogTitle>人工編輯任務 #{detail.id}</DialogTitle>
          <DialogDescription>可修改需求、驗收條件、優先序與依賴。實質修改後，此任務、同組子任務及後續依賴會重新待辦，並撤回任務核准；已寫入的程式碼保留。</DialogDescription>
        </DialogHeader>
        <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto pr-1">
          {EDIT_FIELDS.map(([key, label, type]) => {
            const id = `human-task-${key}`;
            const value = values[key] || '';
            const set = (next: string) => setValues((v) => ({ ...v, [key]: next }));
            return (
              <div key={key} className="grid gap-1">
                <Label htmlFor={id} className="text-xs">{label}</Label>
                {type === 'select' ? (
                  <Select value={value || 'medium'} onValueChange={set}>
                    <SelectTrigger id={id} aria-label={label} className="w-40"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="high">高</SelectItem>
                      <SelectItem value="medium">中</SelectItem>
                      <SelectItem value="low">低</SelectItem>
                    </SelectContent>
                  </Select>
                ) : null}
                {(type === 'input' || type === 'dependencies') && <Input id={id} value={value} onChange={(e) => set(e.target.value)} data-autofocus={key === 'title' || undefined} />}
                {type !== 'select' && type !== 'input' && type !== 'dependencies' && <Textarea id={id} rows={3} value={value} onChange={(e) => set(e.target.value)} />}
              </div>
            );
          })}
        </div>
        {error && <Notice tone="bad" role="alert">{error}</Notice>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="button" disabled={saving} onClick={save}>儲存修改</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
