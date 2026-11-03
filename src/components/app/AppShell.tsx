// App 外框：側欄 | 主區域 | 狀態列。整個視窗固定大小，各畫面自己捲動。
import { useEffect } from 'react';
import { Navigate, Outlet, useParams } from 'react-router-dom';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { Sidebar } from '@/components/app/Sidebar';
import { StatusBar } from '@/components/app/StatusBar';
import { CommandPalette } from '@/components/app/CommandPalette';
import { ConfirmHost } from '@/components/app/confirm';
import { useShortcuts } from '@/hooks/use-shortcuts';
import { useProjects } from '@/stores/projects';
import { useProject } from '@/stores/project';
import { useBadges } from '@/stores/badges';
import { useReferences } from '@/stores/references';
import { PermissionDialog } from '@/features/permissions/PermissionDialog';
import { ReferenceDialogHost, ReferenceDropHost } from '@/features/references/ReferenceWidget';
import { EmptyState } from '@/components/app/Page';
import { PrdErrorToast } from '@/features/prd/PrdErrorToast';

export function AppShell() {
  useShortcuts();
  const connect = useProjects((s) => s.connect);
  const refresh = useProjects((s) => s.refresh);
  useEffect(() => { refresh(); connect(); }, [refresh, connect]);
  return (
    <TooltipProvider delayDuration={400}>
      {/* Toaster 放在最前面：畫面在第一次 render 就發的通知（例如 PRD 錯誤）才不會在 Toaster 訂閱前遺失。 */}
      <Toaster />
      <div className="flex h-full w-full overflow-hidden">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">
          <main id="main" className="min-h-0 flex-1 overflow-hidden" tabIndex={-1}>
            <Outlet />
          </main>
          <StatusBar />
        </div>
      </div>
      <CommandPalette />
      <ConfirmHost />
    </TooltipProvider>
  );
}

const ID = /^[0-9a-f]{10}$/;

/** 專案畫面的外層：開啟專案（訂閱狀態與 log）、掛上權限對話框與參考資料拖放。 */
export function ProjectLayout() {
  const { id } = useParams();
  const open = useProject((s) => s.open);
  const close = useProject((s) => s.close);
  const snap = useProject((s) => s.snap);
  const error = useProject((s) => s.error);
  const valid = !!id && ID.test(id);
  useEffect(() => {
    if (!valid) return;
    useBadges.getState().reset();
    useReferences.getState().reset();
    open(id);
    return () => { close(); useBadges.getState().reset(); };
  }, [id, valid, open, close]);
  useEffect(() => {
    document.title = snap ? `${snap.project.name} — ai-workflow` : 'ai-workflow';
    return () => { document.title = 'ai-workflow'; };
  }, [snap]);
  if (!valid) return <Navigate to="/" replace />;
  if (!snap && error) return <EmptyState title="無法開啟專案" description={error} />;
  if (!snap) return <EmptyState title="載入專案…" />;
  return (
    <>
      <Outlet />
      <PermissionDialog />
      <PrdErrorToast />
      <ReferenceDialogHost />
      <ReferenceDropHost />
    </>
  );
}
