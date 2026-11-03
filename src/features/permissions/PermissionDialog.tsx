// AI 要求的工具權限：流程執行中 CLI 想跑沒有預先允許的指令時，跳出允許／拒絕的對話框。
// Esc 與「稍後決定」只是暫時關掉，不算拒絕；暫時關掉後右下角留一條提示可再打開。
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Hint, Notice } from '@/components/app/Page';
import { PROVIDER_LABEL } from '@/lib/constants';
import { errorMessage } from '@/lib/api';
import { useProject } from '@/stores/project';
import type { PermissionEntry } from '@/types/api';

/** 按過「稍後決定」的請求 id（整個 App 期間記住，重畫不會再跳出來）。 */
const later = new Set<string>();

export function permissionInput(entry: PermissionEntry): [string, string] {
  const input = (entry.input || {}) as Record<string, unknown>;
  if (typeof input.command === 'string') return ['指令', input.command];
  if (typeof input.file_path === 'string') return ['檔案', input.file_path];
  if (typeof input.url === 'string') return ['網址', input.url];
  return ['內容', JSON.stringify(input, null, 2)];
}

export function permissionRuleText(entry: PermissionEntry): string {
  const rules = (entry.suggestions || []).flatMap((s) => s.rules || []);
  return rules.map((rule) => (rule.ruleContent ? `${rule.toolName}(${rule.ruleContent})` : rule.toolName)).filter(Boolean).join('、');
}

export function PermissionDialog() {
  const waiting = useProject((s) => s.snap?.permissions) || [];
  const api = useProject((s) => s.api);
  const [, bump] = useState(0);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const next = waiting.find((entry) => !later.has(entry.id)) || null;
  useEffect(() => { setReason(''); setError(''); setBusy(false); }, [next?.id]);
  const dismiss = () => { if (next) later.add(next.id); bump((n) => n + 1); };
  const answer = async (decision: 'allow' | 'allow_session' | 'deny') => {
    if (!next) return;
    setBusy(true); setError('');
    try {
      await api('/api/permissions/answer', { id: next.id, decision, message: decision === 'deny' ? reason : '' });
      const snap = useProject.getState().snap;
      if (snap) useProject.setState({ snap: { ...snap, permissions: (snap.permissions || []).filter((entry) => entry.id !== next.id) } });
      toast.success(decision === 'deny' ? '已拒絕，AI 會改用其他做法或停下' : '已允許，AI 繼續執行');
    } catch (err) { setError(errorMessage(err)); setBusy(false); }
  };
  if (!next) {
    if (!waiting.length) return null;
    return (
      <div role="status" className="fixed bottom-8 right-3 z-40 flex items-center gap-3 rounded-md border bg-popover px-3 py-2 text-xs shadow-md">
        <span>AI 等待你允許 {waiting.length} 個操作</span>
        <Button type="button" size="sm" onClick={() => { later.clear(); bump((n) => n + 1); }}>檢視</Button>
      </div>
    );
  }
  const others = waiting.length - 1;
  const [inputLabel, inputText] = permissionInput(next);
  const rule = permissionRuleText(next);
  return (
    <Dialog open onOpenChange={(open) => { if (!open && !busy) dismiss(); }}>
      <DialogContent className="sm:max-w-xl" showCloseButton={false} onPointerDownOutside={(e) => e.preventDefault()} onInteractOutside={(e) => e.preventDefault()} onEscapeKeyDown={(e) => { e.preventDefault(); if (!busy) dismiss(); }}>
        <DialogHeader>
          <DialogTitle className="flex items-baseline justify-between gap-2">AI 要求執行操作{others > 0 && <span className="text-xs font-normal text-muted-foreground">還有 {others} 個等待中</span>}</DialogTitle>
          <DialogDescription>{`${next.label || next.scope || ''}・${PROVIDER_LABEL[next.provider] || next.provider} 想使用 ${next.display_name || next.tool}`}</DialogDescription>
        </DialogHeader>
        {next.description && <p className="text-[13px]">{next.description}</p>}
        <div>
          <Hint className="mb-1">{inputLabel}</Hint>
          <pre className="mono selectable max-h-48 overflow-auto whitespace-pre-wrap rounded-md border bg-surface-2 p-2 text-xs">{inputText}</pre>
        </div>
        {next.reason && <Hint>CLI：{next.reason}</Hint>}
        <div className="flex flex-col gap-1">
          <Label htmlFor="permission-deny-reason" className="text-xs">拒絕原因（選填，會告訴 AI）</Label>
          <Textarea id="permission-deny-reason" rows={2} maxLength={2000} value={reason} disabled={busy} placeholder="例如：請改用 pnpm，或先不要安裝這個套件" onChange={(e) => setReason(e.target.value)} />
        </div>
        {error && <Notice tone="bad" role="alert">{error}</Notice>}
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="outline" disabled={busy} onClick={dismiss}>稍後決定</Button>
          <span className="flex-1" />
          <Button type="button" variant="outline" disabled={busy} onClick={() => answer('deny')}>拒絕</Button>
          {rule && <Button type="button" variant="outline" disabled={busy} title="只在這次 AI 執行期間有效，不會寫進專案的設定檔" onClick={() => answer('allow_session')}>這次執行都允許 {rule}</Button>}
          <Button type="button" data-autofocus disabled={busy} onClick={() => answer('allow')}>允許這一次</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
