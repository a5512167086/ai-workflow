// 參考資料：各輸入區共用的小型工具列（標題＋「＋ 加入參考」）與附件 chips。其他模組從這裡匯入所有介面：
//   referenceOptions(type, ctx) → ReferenceOptions
//   <ReferenceWidget options />             鎖住時只能看、不能改
//   openReferenceDialog(options) 與 <ReferenceDialogHost />
//   useReferenceInput(ref, getOptions)      textarea 的貼上圖片與 @ 補全
//   <ReferenceDropHost />                   視窗層級的拖放，依 data-reference-drop 決定加到哪個區域
//   <ReferenceChips ids remove? />          訊息裡的附件 chips
import { toast } from 'sonner';
import { Plus, X } from 'lucide-react';
import { Hint } from '@/components/app/Page';
import { GuardButton } from '@/components/app/GuardButton';
import { errorMessage } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useReferences, referenceName } from '@/stores/references';
import { kindGlyph, saveReferenceSelection, type ReferenceOptions } from '@/features/references/options';
import { openReferenceDialog } from '@/features/references/ReferenceDialog';

export { referenceOptions, saveReferenceSelection, importReference, uploadReference, type ReferenceOptions, type ReferenceContext, type ReferenceType } from '@/features/references/options';
export { openReferenceDialog, ReferenceDialogHost } from '@/features/references/ReferenceDialog';
export { useReferenceInput } from '@/features/references/use-reference-input';
export { ReferenceDropHost } from '@/features/references/ReferenceDropHost';

export function ReferenceChips({ ids, remove, className }: Readonly<{ ids: string[]; remove?: (id: string) => void; className?: string }>) {
  const catalog = useReferences((s) => s.catalog);
  if (!ids?.length) return null;
  return (
    <div className={cn('flex flex-wrap gap-1', className)}>
      {ids.map((id) => {
        const item = catalog.get(id);
        const name = referenceName(catalog, id);
        return (
          <span key={id} title={item ? `${item.sourcePath}\n${item.fileCount} 個檔案 · ${item.excludedCount || 0} 個排除項目\n${(item.warnings || []).join('\n')}`.trim() : id} className="inline-flex max-w-full items-center gap-1 rounded-full border bg-surface-2 px-2 py-px text-[11px]">
            <span className="truncate">{kindGlyph(item?.kind)} {name}</span>
            {remove && (
              <button type="button" aria-label={`移除參考：${name}`} className="rounded-full text-muted-foreground hover:text-foreground" onClick={() => remove(id)}>
                <X className="size-3" />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

export function ReferenceWidget({ options, className }: Readonly<{ options: ReferenceOptions; className?: string }>) {
  const lock = options.lock;
  return (
    <div className={cn('flex flex-col gap-1.5', lock && 'opacity-90', className)} data-reference-widget={options.key || options.target}>
      <div className="flex flex-wrap items-center gap-2">
        <Hint>{options.title}</Hint>
        <GuardButton type="button" variant="outline" size="sm" guard={lock} aria-label={`加入參考：${options.title}`} onClick={() => openReferenceDialog(options)}>
          <Plus className="size-3" />加入參考
        </GuardButton>
      </div>
      <ReferenceChips ids={options.ids} remove={lock ? undefined : (id) => saveReferenceSelection(options, options.ids.filter((value) => value !== id)).catch((err) => toast.error(errorMessage(err)))} />
      {lock && <Hint>{lock}</Hint>}
    </div>
  );
}
