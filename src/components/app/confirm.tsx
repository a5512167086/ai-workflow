// 取代 window.confirm／prompt：桌面 app 用自己的對話框（WebView2 的原生 confirm 樣式醜且會搶焦點）。
// 用法：const ok = await confirmDialog({ title, description, confirmText, destructive }); const name = await promptDialog({ title, defaultValue });
import { useEffect, useState, type ReactNode } from 'react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ConfirmOptions {
  title: string;
  description?: ReactNode;
  confirmText?: string;
  cancelText?: string;
  destructive?: boolean;
}
export interface PromptOptions {
  title: string;
  description?: ReactNode;
  defaultValue?: string;
  placeholder?: string;
  confirmText?: string;
}

type Pending =
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (ok: boolean) => void }
  | { kind: 'prompt'; options: PromptOptions; resolve: (value: string | null) => void };

const listeners = new Set<(p: Pending | null) => void>();
let current: Pending | null = null;
function show(p: Pending | null) {
  current = p;
  for (const fn of listeners) fn(p);
}

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (current) { resolve(false); return; }
    show({ kind: 'confirm', options, resolve });
  });
}
export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) => {
    if (current) { resolve(null); return; }
    show({ kind: 'prompt', options, resolve });
  });
}

/** 掛在 App 最外層一次。 */
export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(current);
  const [value, setValue] = useState('');
  useEffect(() => {
    listeners.add(setPending);
    return () => { listeners.delete(setPending); };
  }, []);
  useEffect(() => { if (pending?.kind === 'prompt') setValue(pending.options.defaultValue || ''); }, [pending]);
  if (!pending) return null;
  const finish = (result: boolean | string | null) => {
    if (pending.kind === 'confirm') pending.resolve(!!result);
    else pending.resolve(typeof result === 'string' ? result : null);
    show(null);
  };
  if (pending.kind === 'confirm') {
    const o = pending.options;
    return (
      <AlertDialog open onOpenChange={(open) => { if (!open) finish(false); }}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>{o.title}</AlertDialogTitle>
            {o.description && <AlertDialogDescription className="whitespace-pre-line text-left">{o.description}</AlertDialogDescription>}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => finish(false)}>{o.cancelText || '取消'}</AlertDialogCancel>
            <AlertDialogAction data-autofocus className={cn(o.destructive && buttonVariants({ variant: 'destructive' }))} onClick={() => finish(true)}>
              {o.confirmText || '確定'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }
  const o = pending.options;
  return (
    <Dialog open onOpenChange={(open) => { if (!open) finish(null); }}>
      <DialogContent className="max-w-md">
        <form onSubmit={(e) => { e.preventDefault(); finish(value); }} className="contents">
          <DialogHeader>
            <DialogTitle>{o.title}</DialogTitle>
            {o.description && <DialogDescription>{o.description}</DialogDescription>}
          </DialogHeader>
          <Input data-autofocus value={value} placeholder={o.placeholder} onChange={(e) => setValue(e.target.value)} aria-label={o.title} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>取消</Button>
            <Button type="submit">{o.confirmText || '確定'}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
