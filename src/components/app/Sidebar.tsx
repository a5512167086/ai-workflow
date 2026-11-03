// 左側導覽（像 VS Code／Linear）：上方是專案切換器，中間是目前專案的畫面，下方是全域入口（所有專案、設定、主題）。
import { NavLink, useNavigate, useParams } from 'react-router-dom';
import {
  MessageSquareText, ListTodo, FileText, KanbanSquare, History, Waypoints, Gauge, Sparkles, Settings, LayoutGrid, ChevronsUpDown, PanelLeftClose, PanelLeftOpen, Sun, Moon, Monitor, Check, Plus, Command as CommandIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Kbd } from '@/components/ui/kbd';
import { PROJECT_STATUS, PROJECT_VIEWS, type ProjectView } from '@/lib/constants';
import { cn } from '@/lib/utils';
import { useProjects } from '@/stores/projects';
import { useProject } from '@/stores/project';
import { useUi, THEMES } from '@/stores/ui';
import { useBadges } from '@/stores/badges';
import { Logo } from '@/components/app/Logo';

const ICONS: Record<ProjectView, React.ComponentType<{ className?: string }>> = {
  chat: MessageSquareText, backlog: ListTodo, prd: FileText, board: KanbanSquare, records: History, graph: Waypoints, usage: Gauge, skills: Sparkles,
};
const DOT: Record<string, string> = {
  idle: 'bg-muted-foreground', running: 'bg-info', queued: 'bg-info', waiting: 'bg-warn', feature_test: 'bg-warn', paused: 'bg-warn', stuck: 'bg-danger', error: 'bg-danger', complete: 'bg-ok',
};

function NavItem({ to, icon: Icon, label, badge, attention, collapsed, shortcut, end }: { to: string; icon: React.ComponentType<{ className?: string }>; label: string; badge?: string; attention?: boolean; collapsed: boolean; shortcut?: string; end?: boolean }) {
  const link = (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) => cn(
        'group/nav flex h-8 items-center gap-2 rounded-md px-2 text-[13px] text-sidebar-foreground/85 outline-none transition-colors hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring',
        isActive && 'bg-sidebar-accent font-medium text-sidebar-foreground',
        collapsed && 'justify-center px-0',
      )}
      aria-label={collapsed ? label : undefined}
    >
      <Icon className="size-4 shrink-0 opacity-80 group-[.active]/nav:opacity-100" />
      {!collapsed && <span className="min-w-0 flex-1 truncate">{label}</span>}
      {badge && (
        <span className={cn('rounded-full px-1.5 text-[10.5px] font-semibold leading-4 tabular-nums', attention ? 'bg-warn text-background' : 'bg-sidebar-accent text-muted-foreground', collapsed && 'absolute left-7 top-1 px-1')}>{badge}</span>
      )}
      {!badge && attention && <span className={cn('size-1.5 rounded-full bg-warn', collapsed && 'absolute left-7 top-1.5')} aria-label="需要處理" />}
    </NavLink>
  );
  if (!collapsed) return link;
  return (
    <Tooltip>
      <TooltipTrigger asChild><div className="relative">{link}</div></TooltipTrigger>
      <TooltipContent side="right">{label}{shortcut && <Kbd className="ml-2">{shortcut}</Kbd>}</TooltipContent>
    </Tooltip>
  );
}

function ProjectSwitcher({ collapsed }: { collapsed: boolean }) {
  const { id } = useParams();
  const navigate = useNavigate();
  const projects = useProjects((s) => s.projects);
  const snapName = useProject((s) => s.snap?.project.name);
  const current = projects.find((p) => p.id === id);
  const name = current?.name || snapName || (id ? '載入中…' : '所有專案');
  const [, tone] = current ? PROJECT_STATUS[current.status] || PROJECT_STATUS.idle : ['', 'idle'];
  const attention = projects.filter((p) => p.attention).length;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={cn('flex h-9 w-full items-center gap-2 rounded-md px-2 text-left outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring', collapsed && 'justify-center px-0')}
          aria-label={`切換專案，目前：${name}`}
        >
          <span className="relative grid size-6 shrink-0 place-items-center rounded-md bg-primary/15 text-primary"><Logo className="size-4" />
            {attention > 0 && <span className="absolute -right-1 -top-1 size-2 rounded-full bg-warn ring-2 ring-sidebar" aria-hidden="true" />}
          </span>
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold leading-4">{name}</span>
                <span className="block truncate text-[11px] leading-4 text-muted-foreground">{current ? (PROJECT_STATUS[current.status]?.[0] || current.status) : attention ? `${attention} 個專案等你處理` : `${projects.length} 個專案`}</span>
              </span>
              <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side={collapsed ? 'right' : 'bottom'} className="w-72">
        <DropdownMenuLabel className="text-xs text-muted-foreground">專案</DropdownMenuLabel>
        {projects.length === 0 && <DropdownMenuItem disabled>還沒有專案</DropdownMenuItem>}
        {projects.map((p) => {
          const [label, t] = PROJECT_STATUS[p.status] || PROJECT_STATUS.idle;
          return (
            <DropdownMenuItem key={p.id} onSelect={() => navigate(`/p/${p.id}`)} className="gap-2">
              <span className={cn('size-2 shrink-0 rounded-full', DOT[t])} aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">{p.name}</span>
                <span className="block truncate text-[11px] text-muted-foreground">{label}{p.attention ? ' · 等你處理' : ''}</span>
              </span>
              {p.id === id && <Check className="size-4 text-primary" />}
            </DropdownMenuItem>
          );
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => navigate('/')}><LayoutGrid className="size-4" />所有專案<Kbd className="ml-auto">Ctrl+Shift+O</Kbd></DropdownMenuItem>
        <DropdownMenuItem onSelect={() => navigate('/?add=1')}><Plus className="size-4" />加入專案</DropdownMenuItem>
      </DropdownMenuContent>
      <span className="sr-only">{tone}</span>
    </DropdownMenu>
  );
}

function ThemeMenu({ collapsed }: { collapsed: boolean }) {
  const theme = useUi((s) => s.theme);
  const setTheme = useUi((s) => s.setTheme);
  const Icon = theme === 'light' ? Sun : theme === 'dark' ? Moon : Monitor;
  const label = THEMES.find((t) => t.key === theme)?.label || '';
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size={collapsed ? 'icon' : 'default'} className={cn('justify-start gap-2 px-2 text-sidebar-foreground/85', collapsed && 'justify-center')} aria-label={`主題：${label}`} title={`主題：${label}`}>
          <Icon className="size-4" />{!collapsed && <span className="truncate">主題：{label}</span>}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top">
        {THEMES.map((t) => (
          <DropdownMenuItem key={t.key} onSelect={() => setTheme(t.key)}>
            {t.key === 'light' ? <Sun className="size-4" /> : t.key === 'dark' ? <Moon className="size-4" /> : <Monitor className="size-4" />}
            {t.label}{t.key === theme && <Check className="ml-auto size-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function Sidebar() {
  const { id } = useParams();
  const collapsed = useUi((s) => s.sidebarCollapsed);
  const setCollapsed = useUi((s) => s.setSidebarCollapsed);
  const setPalette = useUi((s) => s.setPaletteOpen);
  const badges = useBadges((s) => s.badges);
  return (
    <aside className={cn('flex h-full shrink-0 flex-col border-r bg-sidebar text-sidebar-foreground transition-[width] duration-150', collapsed ? 'w-12' : 'w-56')} aria-label="主要導覽">
      <div className="p-1.5">
        <ProjectSwitcher collapsed={collapsed} />
      </div>
      <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto px-1.5" aria-label={id ? '專案畫面' : '全域'}>
        {id ? (
          <>
            {!collapsed && <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">專案</div>}
            {PROJECT_VIEWS.map((v, i) => (
              <NavItem key={v.key} to={`/p/${id}/${v.key}`} icon={ICONS[v.key]} label={v.label} badge={badges[v.key]?.text} attention={badges[v.key]?.attention} collapsed={collapsed} shortcut={`Ctrl+${i + 1}`} />
            ))}
          </>
        ) : (
          <>
            {!collapsed && <div className="px-2 pb-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">總覽</div>}
            <NavItem to="/" end icon={LayoutGrid} label="所有專案" collapsed={collapsed} />
          </>
        )}
      </nav>
      <div className="flex flex-col gap-0.5 border-t p-1.5">
        <Button variant="ghost" className={cn('justify-start gap-2 px-2 text-sidebar-foreground/85', collapsed && 'justify-center px-0')} onClick={() => setPalette(true)} aria-label="指令面板（Ctrl+K）" title="指令面板（Ctrl+K）">
          <CommandIcon className="size-4" />{!collapsed && <><span className="flex-1 text-left">指令面板</span><Kbd>Ctrl+K</Kbd></>}
        </Button>
        <NavItem to="/settings" icon={Settings} label="設定" collapsed={collapsed} shortcut="Ctrl+," />
        <ThemeMenu collapsed={collapsed} />
        <Button variant="ghost" size="icon" className="self-end text-muted-foreground" onClick={() => setCollapsed(!collapsed)} aria-label={collapsed ? '展開側欄' : '收合側欄'} title={`${collapsed ? '展開' : '收合'}側欄（Ctrl+B）`}>
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </Button>
      </div>
    </aside>
  );
}
