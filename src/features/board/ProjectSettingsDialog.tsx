// 這個專案自己的欄位：build/test/lint、功能名稱、context 檔（其他設定都是全域的，在設定頁）。關閉時放棄沒儲存的輸入。
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Save } from 'lucide-react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Hint } from '@/components/app/Page';
import { useProject } from '@/stores/project';
import type { ProjectConfig } from '@/types/api';

const COMMANDS: ['build' | 'test' | 'lint', string][] = [
  ['build', '留空：自動偵測（例如 npm run build）'],
  ['test', '留空：自動偵測（例如 npm test）'],
  ['lint', '留空：自動偵測（例如 npm run lint）'],
];

export function ProjectSettingsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const snap = useProject((s) => s.snap);
  const api = useProject((s) => s.api);
  const [commands, setCommands] = useState<Record<string, string>>({});
  const [feature, setFeature] = useState('');
  const [context, setContext] = useState('');
  const [saving, setSaving] = useState(false);
  // 每次打開都從目前設定重填；關閉就丟掉沒儲存的輸入。
  useEffect(() => {
    if (!open || !snap) return;
    setCommands({ build: snap.config.commands?.build || '', test: snap.config.commands?.test || '', lint: snap.config.commands?.lint || '' });
    setFeature(snap.config.feature || '');
    setContext((snap.config.context_files || []).join('\n'));
  }, [open, snap]);
  if (!snap) return null;
  const save = async () => {
    setSaving(true);
    try {
      const context_files = context.split('\n').map((line) => line.trim()).filter(Boolean);
      const { config } = await api<{ config: ProjectConfig }>('/api/config/project', { commands, feature, context_files });
      useProject.setState((s) => (s.snap ? { snap: { ...s.snap, config } } : {}));
      toast.success('已儲存專案設定');
      onOpenChange(false);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>這個專案的指令與 context</DialogTitle>
          <DialogDescription>全部可以留空。build／test／lint 是每個任務實作後 App 自己跑的驗證（留空會從 package.json、Cargo.toml 等自動偵測）；功能名稱只用在自動模式的分支名稱；context 檔是每次都附給 AI 的專案說明文件。其他設定都在「設定」。</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2">
          {COMMANDS.map(([key, placeholder]) => (
            <div key={key} className="contents">
              <Label htmlFor={`pc-${key}`} className="mono text-xs">{key}</Label>
              <Input id={`pc-${key}`} data-command={key} className="mono" spellCheck={false} placeholder={placeholder} value={commands[key] || ''} onChange={(e) => setCommands({ ...commands, [key]: e.target.value })} />
            </div>
          ))}
          <Label htmlFor="pc-feature" className="text-xs">功能名稱</Label>
          <Input id="pc-feature" placeholder="留空：自動模式用 PRD 想法產生分支名稱" value={feature} onChange={(e) => setFeature(e.target.value)} />
          <Label htmlFor="pc-context" className="self-start pt-2 text-xs">context 檔</Label>
          <Textarea id="pc-context" rows={2} spellCheck={false} placeholder="每行一個專案內既有檔案的路徑，例如 docs/architecture.md；每次 AI 對話都會附上" value={context} onChange={(e) => setContext(e.target.value)} />
        </div>
        {snap.dataDir && <Hint className="mono">流程資料：{snap.dataDir}</Hint>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
          <Button type="button" onClick={save} disabled={saving}><Save />儲存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
