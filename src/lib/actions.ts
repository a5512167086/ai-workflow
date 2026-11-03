// 流程動作：開始／暫停／繼續等。額度用完時先確認，改用另一個 AI（和舊版 app.js 的 runAction 相同）。
import { act, type Api } from '@/lib/api';
import { PROVIDER_LABEL } from '@/lib/constants';
import { confirmDialog } from '@/components/app/confirm';
import type { Snapshot } from '@/types/api';
import { toast } from 'sonner';

export async function runAction(api: Api, snap: Snapshot | null, path: string, body: Record<string, unknown> = {}, message?: string) {
  const blocked = snap?.state.usage_blocked;
  const exhausted = snap?.usage?.providers?.filter((p) => p.limits?.windows?.some((w) => !w.expired && w.remainingPercent === 0)) || [];
  const provider = blocked?.provider || exhausted[0]?.provider;
  if (provider) {
    const other = provider === 'claude' ? 'codex' : 'claude';
    if (exhausted.some((p) => p.provider === other)) {
      toast.error('兩個 AI 的額度都已用完，請等待重設後更新額度。');
      return null;
    }
    const ok = await confirmDialog({
      title: `${PROVIDER_LABEL[provider]} 曾回報額度不足`,
      description: `要只用 ${PROVIDER_LABEL[other]} 繼續這次執行嗎？\n\n實作與審查會使用不同 session；雙人審查暫時改為單人。會保留現有檔案並重新驗證，不會還原變更。原本角色設定不變，下次執行會再詢問。若另一個 AI 也沒有額度，流程會停止。\n\n若額度已重設，可先到用量頁更新。`,
      confirmText: `用 ${PROVIDER_LABEL[other]} 繼續`,
    });
    if (!ok) return null;
    body = { ...body, useProvider: other };
    if (path === '/api/run/start' && snap && ['stuck', 'error'].includes(snap.state.pipeline.status)) path = '/api/run/continue';
  }
  return act(api, path, body, message);
}
