// 指令面板（Ctrl+K）：切換專案、跳到畫面、常用流程動作、主題。
import { useNavigate, useParams } from 'react-router-dom';
import { LayoutGrid, Settings, Sun, Moon, Monitor, Play, Pause, StepForward, FolderOpen } from 'lucide-react';
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from '@/components/ui/command';
import { PROJECT_STATUS, PROJECT_VIEWS } from '@/lib/constants';
import { runAction } from '@/lib/actions';
import { act } from '@/lib/api';
import { useProjects } from '@/stores/projects';
import { useProject } from '@/stores/project';
import { useUi } from '@/stores/ui';

export function CommandPalette() {
  const open = useUi((s) => s.paletteOpen);
  const setOpen = useUi((s) => s.setPaletteOpen);
  const setTheme = useUi((s) => s.setTheme);
  const projects = useProjects((s) => s.projects);
  const { id } = useParams();
  const navigate = useNavigate();
  const snap = useProject((s) => s.snap);
  const api = useProject((s) => s.api);
  const go = (to: string) => { setOpen(false); navigate(to); };
  const run = (fn: () => unknown) => { setOpen(false); void fn(); };
  const guard = (name: string) => snap?.guards?.[name] || '';
  return (
    <CommandDialog open={open} onOpenChange={setOpen} title="指令面板" description="輸入以搜尋專案、畫面或動作" showCloseButton={false}>
      <CommandInput placeholder="搜尋專案、畫面或動作…" />
      <CommandList>
        <CommandEmpty>沒有符合的項目</CommandEmpty>
        {id && snap && (
          <>
            <CommandGroup heading="畫面">
              {PROJECT_VIEWS.map((v, i) => (
                <CommandItem key={v.key} value={`view ${v.label} ${v.key}`} onSelect={() => go(`/p/${id}/${v.key}`)}>
                  {v.label}<CommandShortcut>Ctrl+{i + 1}</CommandShortcut>
                </CommandItem>
              ))}
            </CommandGroup>
            <CommandGroup heading="流程">
              <CommandItem value="action start 開始執行任務" disabled={!!guard('run.start')} onSelect={() => run(() => runAction(api, snap, '/api/run/start', {}, '流程已開始'))}>
                <Play className="size-4" />開始執行任務{guard('run.start') && <span className="ml-auto text-xs text-muted-foreground">{guard('run.start')}</span>}
              </CommandItem>
              <CommandItem value="action pause 暫停" disabled={!snap.runnerAlive || !!snap.state.control.pause_requested} onSelect={() => run(() => act(api, '/api/run/pause', {}, '目前任務結束後會暫停'))}>
                <Pause className="size-4" />暫停（目前任務結束後）
              </CommandItem>
              <CommandItem value="action continue 我測完了 繼續" disabled={!['waiting', 'feature_test', 'stuck', 'error'].includes(snap.state.pipeline.status)} onSelect={() => run(() => runAction(api, snap, '/api/run/continue', {}, '繼續'))}>
                <StepForward className="size-4" />我測完了，繼續
              </CommandItem>
            </CommandGroup>
          </>
        )}
        <CommandGroup heading="專案">
          {projects.map((p) => (
            <CommandItem key={p.id} value={`project ${p.name} ${p.path}`} onSelect={() => go(`/p/${p.id}`)}>
              <FolderOpen className="size-4" />
              <span className="truncate">{p.name}</span>
              <span className="ml-auto truncate text-xs text-muted-foreground">{PROJECT_STATUS[p.status]?.[0] || p.status}{p.attention ? ' · 等你處理' : ''}</span>
            </CommandItem>
          ))}
          <CommandItem value="all projects 所有專案 總覽" onSelect={() => go('/')}><LayoutGrid className="size-4" />所有專案<CommandShortcut>Ctrl+Shift+O</CommandShortcut></CommandItem>
          <CommandItem value="settings 設定" onSelect={() => go('/settings')}><Settings className="size-4" />設定<CommandShortcut>Ctrl+,</CommandShortcut></CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="外觀">
          <CommandItem value="theme system 跟隨系統" onSelect={() => run(() => setTheme('system'))}><Monitor className="size-4" />主題：跟隨系統</CommandItem>
          <CommandItem value="theme light 淺色" onSelect={() => run(() => setTheme('light'))}><Sun className="size-4" />主題：淺色</CommandItem>
          <CommandItem value="theme dark 深色" onSelect={() => run(() => setTheme('dark'))}><Moon className="size-4" />主題：深色</CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
