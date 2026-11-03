// PRD 的錯誤（AI 失敗、程序中途被結束…）以通知跳出來，不再一直掛在 PRD 頁上。
// 使用者按 × 或滑掉通知＝已讀：呼叫 /api/prd/dismiss_error 清掉後端的錯誤，之後不會再出現。
// 「查看 PRD」只跳到 PRD 頁，通知保留到使用者自己關閉。
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { errorMessage } from '@/lib/api';
import { useProject } from '@/stores/project';

/** 程式自己收起的通知（離開專案、錯誤已被清掉），onDismiss 不要當成使用者關閉。 */
const programmatic = new Set<string | number>();
let serial = 0;

export async function dismissPrdError() {
  const { api, snap } = useProject.getState();
  if (snap) useProject.setState({ snap: { ...snap, state: { ...snap.state, prd: { ...snap.state.prd, error: '' } } } });
  try {
    await api('/api/prd/dismiss_error', {});
  } catch (err) {
    toast.error(errorMessage(err));
  }
}

export function PrdErrorToast() {
  const navigate = useNavigate();
  const projectId = useProject((s) => s.id);
  const error = useProject((s) => (s.snap && !s.snap.prdBusy ? s.snap.state.prd.error || '' : ''));
  // 目前顯示中的通知：每次都用新的 id（sonner 收起後同一個 id 不能馬上再用）。
  const current = useRef<{ id: string; error: string } | null>(null);

  useEffect(() => {
    const hide = () => {
      if (!current.current) return;
      programmatic.add(current.current.id);
      toast.dismiss(current.current.id);
      current.current = null;
    };
    if (!projectId || !error) { hide(); return; }
    if (current.current?.error === error) return;
    hide();
    const id = `prd-error-${projectId}-${++serial}`;
    current.current = { id, error };
    toast.error('PRD 發生錯誤', {
      id,
      description: error,
      duration: Infinity,
      closeButton: true,
      action: {
        label: '查看 PRD',
        onClick: (event) => { event.preventDefault(); void navigate(`/p/${projectId}/prd`); },
      },
      onDismiss: () => {
        if (programmatic.delete(id)) return;
        if (current.current?.id === id) current.current = null;
        // 使用者關掉時錯誤還在才清（避免和剛發生的新錯誤搶）。
        if (useProject.getState().snap?.state.prd.error === error) void dismissPrdError();
      },
    });
  }, [error, projectId, navigate]);

  // 離開專案時收起通知，但不清掉錯誤：下次打開專案會再提醒。
  // 延到下一輪才收：React StrictMode 會卸載後立刻重新掛載，重新掛載時取消，通知不會閃一下。
  const pendingHide = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (pendingHide.current) { clearTimeout(pendingHide.current); pendingHide.current = null; }
    return () => {
      pendingHide.current = setTimeout(() => {
        pendingHide.current = null;
        if (!current.current) return;
        programmatic.add(current.current.id);
        toast.dismiss(current.current.id);
        current.current = null;
      }, 0);
    };
  }, []);

  return null;
}
