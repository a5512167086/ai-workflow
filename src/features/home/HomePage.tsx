// 所有專案：加入專案、等你處理的專案、專案卡片。佇列資訊在底部狀態列，這裡不重複。
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { AlertTriangle, FolderOpen, MoreHorizontal, Plus, ArrowRight, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from '@/components/ui/context-menu';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Page, PageHeader, PageBody, EmptyState, Hint, Eyebrow, Loading } from '@/components/app/Page';
import { StatusPill } from '@/components/app/StatusPill';
import { confirmDialog } from '@/components/app/confirm';
import { api, errorMessage } from '@/lib/api';
import { PROJECT_STATUS } from '@/lib/constants';
import { dialogs, inTauri } from '@/lib/tauri';
import { cn } from '@/lib/utils';
import { useProjects } from '@/stores/projects';
import type { ProjectSummary } from '@/types/api';

interface AddResult { needs_init?: boolean; path?: string; project?: { id: string; name: string } }

function ProjectCard({ project, onRemove }: { project: ProjectSummary; onRemove: (p: ProjectSummary) => void }) {
  const navigate = useNavigate();
  const [label, tone] = PROJECT_STATUS[project.status] || [project.status, 'idle'];
  const pct = project.progress?.total ? Math.round((project.progress.done / project.progress.total) * 100) : 0;
  const feature = (project.feature || '').split('\n')[0];
  const href = `/p/${project.id}`;
  const open = () => navigate(href);
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <article
          onDoubleClick={() => { void open(); }}
          aria-labelledby={`pc-${project.id}`}
          data-testid="project-card"
          className={cn('flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-3 transition-colors focus-within:border-ring', project.attention && 'border-warn/60')}
        >
          <div className="flex items-start justify-between gap-2">
            <h3 className="min-w-0 truncate text-[14px] font-semibold leading-5">
              <Link id={`pc-${project.id}`} to={href} className="hover:underline">{project.name}</Link>
            </h3>
            <StatusPill tone={tone}>{label}</StatusPill>
          </div>
          <p className="mono truncate text-[11.5px] text-muted-foreground selectable" title={project.path}>{project.path}</p>
          <p className={cn('truncate text-xs', !feature && 'text-muted-foreground')}>{feature ? `功能：${feature}` : '尚未開始功能'}</p>
          <div className="flex items-center gap-2">
            <Progress value={pct} className="h-1.5" aria-label={project.progress?.total ? `任務進度 ${project.progress.done}/${project.progress.total}` : '還沒有任務'} />
            <span className="mono shrink-0 text-[11.5px] text-muted-foreground">{project.progress?.total ? `${project.progress.done}/${project.progress.total}` : '—'}</span>
          </div>
          {project.reason && (
            <p className={cn('flex items-start gap-1.5 text-xs', project.attention ? 'text-warn' : 'text-muted-foreground')}>
              {project.attention && <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />}
              <span>{project.reason}</span>
            </p>
          )}
          <div className="mt-auto flex items-center justify-end gap-1.5 pt-1">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" aria-label={`${project.name} 的更多動作`}><MoreHorizontal className="size-4" /></Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={open}><ArrowRight className="size-4" />開啟</DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={() => onRemove(project)}><Trash2 className="size-4" />從總覽移除</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button asChild size="sm"><Link to={href}><ArrowRight className="size-3.5" />開啟</Link></Button>
          </div>
        </article>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={open}><ArrowRight className="size-4" />開啟</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" onSelect={() => onRemove(project)}><Trash2 className="size-4" />從總覽移除</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function AddProjectDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();
  const refresh = useProjects((s) => s.refresh);

  const add = async (init = false) => {
    const value = path.trim();
    if (!value) { toast.error('請輸入或選擇專案資料夾'); inputRef.current?.focus(); return; }
    setBusy(true);
    try {
      const res = await api<AddResult>('/api/projects/add', { path: value, init });
      if (res.needs_init) {
        const ok = await confirmDialog({
          title: '還不是 git repo',
          description: `${res.path}\n還不是 git repo。ai-workflow 用 git 追蹤、審查與還原 AI 的變更，要在這個資料夾執行 git init 並加入嗎？\n（除了 .git 以外，不會在專案裡新增任何檔案；流程資料放在 ~/.ai-workflow/projects/）`,
          confirmText: 'git init 並加入',
        });
        if (ok) await add(true);
        return;
      }
      toast.success(`已加入 ${res.project?.name ?? value}`);
      setPath('');
      onOpenChange(false);
      await refresh();
      if (res.project?.id) void navigate(`/p/${res.project.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const pick = async () => {
    try {
      const dir = await dialogs.pickFolder();
      if (dir) setPath(dir);
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form className="contents" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <DialogHeader>
            <DialogTitle>加入專案</DialogTitle>
            <DialogDescription>專案資料夾裡不會新增任何檔案；流程資料放在 ~/.ai-workflow/projects/</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="add-path">專案資料夾</Label>
            <div className="flex gap-2">
              <Input id="add-path" ref={inputRef} data-autofocus className="mono flex-1" placeholder="例如：C:\code\my-app" spellCheck={false} value={path} onChange={(e) => setPath(e.target.value)} />
              {inTauri && <Button type="button" variant="outline" onClick={pick}><FolderOpen className="size-4" />選擇資料夾</Button>}
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
            <Button type="submit" disabled={busy}><Plus className="size-4" />加入</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function HomePage() {
  const { projects, loaded, error, refresh } = useProjects();
  const [params, setParams] = useSearchParams();
  const [addOpen, setAddOpen] = useState(false);
  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => {
    if (params.get('add') === '1') {
      setAddOpen(true);
      params.delete('add');
      setParams(params, { replace: true });
    }
  }, [params, setParams]);

  const remove = async (project: ProjectSummary) => {
    const ok = await confirmDialog({ title: `從總覽移除「${project.name}」？`, description: '只會移出清單，不會刪除任何檔案。', confirmText: '移除', destructive: true });
    if (!ok) return;
    try {
      await api('/api/projects/remove', { id: project.id });
      toast.success('已從總覽移除');
      await refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };

  const attention = projects.filter((p) => p.attention);
  return (
    <Page>
      <PageHeader title="所有專案" description={projects.length ? `${projects.length} 個專案${attention.length ? `・${attention.length} 個等你處理` : ''}` : undefined} actions={<Button onClick={() => setAddOpen(true)}><Plus className="size-4" />加入專案</Button>} />
      <PageBody className="flex flex-col gap-5">
        {error && <Hint role="alert" className="text-danger">{error}</Hint>}
        {!loaded && !error && <Loading label="讀取專案…" />}
        {loaded && !projects.length && (
          <EmptyState
            title="還沒有專案"
            description={<>按「加入專案」選擇專案資料夾，或在專案目錄執行 <code className="mono">ai-workflow projects add</code>。</>}
            action={<Button onClick={() => setAddOpen(true)}><Plus className="size-4" />加入專案</Button>}
          />
        )}
        {attention.length > 0 && (
          <section aria-labelledby="attention-h" className="flex flex-col gap-2">
            <Eyebrow><span id="attention-h">等你處理 {attention.length}</span></Eyebrow>
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
              {attention.map((p) => <ProjectCard key={p.id} project={p} onRemove={remove} />)}
            </div>
          </section>
        )}
        {projects.length > 0 && (
          <section aria-labelledby="projects-h" className="flex flex-col gap-2">
            <Eyebrow><span id="projects-h">專案 {projects.length}</span></Eyebrow>
            <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
              {projects.map((p) => <ProjectCard key={p.id} project={p} onRemove={remove} />)}
            </div>
          </section>
        )}
      </PageBody>
      <AddProjectDialog open={addOpen} onOpenChange={setAddOpen} />
    </Page>
  );
}
