// 底部狀態列（像 VS Code）：流程狀態、原因、執行資訊、佇列、模式與 token 用量集中在一處。
import { useNavigate, useParams } from 'react-router-dom';
import { Activity, ListOrdered, Coins, Settings2 } from 'lucide-react';
import { StatusPill } from '@/components/app/StatusPill';
import { LiveSince } from '@/components/app/LiveSince';
import { STATUS_TEXT, STATUS_TONE } from '@/lib/constants';
import { tokenNumber } from '@/lib/format';
import { useProject } from '@/stores/project';
import { useProjects, projectName } from '@/stores/projects';
import { cn } from '@/lib/utils';
import type { PipelineStatus, Snapshot } from '@/types/api';

declare const __APP_VERSION__: string;

function Item({ children, onClick, title, className }: Readonly<{ children: React.ReactNode; onClick?: () => void; title?: string; className?: string }>) {
  const cls = cn('flex h-full items-center gap-1.5 px-2 text-[11.5px] text-muted-foreground', onClick && 'hover:bg-accent hover:text-foreground', className);
  return onClick ? <button type="button" className={cls} onClick={onClick} title={title}>{children}</button> : <span className={cls} title={title}>{children}</span>;
}

/** 執行器的說明：排隊中、執行中（含 pid），或沒有執行器時是空字串。 */
function runnerText(snap: Snapshot, st: PipelineStatus | undefined): string {
  if (!snap.runnerAlive) return '';
  const pauseRequested = !!snap.state.control.pause_requested;
  if (st === 'queued') return `排隊等其他專案跑完${pauseRequested ? '・將取消排隊' : ''}`;
  const pause = pauseRequested ? '・目前任務結束後暫停' : '';
  return `執行中・pid ${snap.state.runner?.pid ?? '?'}${pause}`;
}

/** 目前專案的流程狀態、原因與執行資訊。 */
function ProjectStatus({ snap, st }: Readonly<{ snap: Snapshot; st: PipelineStatus }>) {
  const text = runnerText(snap, st);
  const reason = snap.state.pipeline.reason;
  const since = snap.runnerAlive && st !== 'queued' ? snap.state.runner?.started_at : null;
  return (
    <>
      <Item className="pl-2"><StatusPill tone={STATUS_TONE[st]} label={`流程狀態：${STATUS_TEXT[st]}`} className="h-[18px] py-0">{STATUS_TEXT[st]}</StatusPill></Item>
      {reason && <Item title={reason}><span className="truncate">{reason}</span></Item>}
      {text && <Item><Activity className="size-3" /><LiveSince label={text} since={since} /></Item>}
    </>
  );
}

/** 左半邊：專案頁顯示流程狀態或讀取錯誤，其他頁顯示所有專案的待處理數。 */
function LeftStatus({ id, snap, error, attention }: Readonly<{ id?: string; snap: Snapshot | null; error: string | null; attention: number }>) {
  const st = snap?.state.pipeline.status;
  if (id && snap && st) return <ProjectStatus snap={snap} st={st} />;
  if (id && error) return <Item className="text-danger"><span className="truncate">{error}</span></Item>;
  return <Item className="pl-2"><StatusPill tone={attention ? 'waiting' : 'idle'} className="h-[18px] py-0">{attention ? `${attention} 個專案等你處理` : '沒有待處理的專案'}</StatusPill></Item>;
}

/** 全域佇列的文字：「：A、B」與「・排隊：C」兩段，沒有就不顯示。 */
function queueText(running: string[], waiting: string[]) {
  const runningText = running.length ? `：${running.join('、')}` : '';
  const waitingText = waiting.length ? `・排隊：${waiting.join('、')}` : '';
  return runningText + waitingText;
}

export function StatusBar() {
  const { id } = useParams();
  const navigate = useNavigate();
  const snap = useProject((s) => s.snap);
  const error = useProject((s) => s.error);
  const { projects, queue } = useProjects();
  const running = queue.running.map((e) => projectName(projects, e.root));
  const waiting = queue.waiting.map((e) => projectName(projects, e.root));
  const attention = projects.filter((p) => p.attention).length;
  const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '';
  const modeText = snap?.config.mode === 'auto' ? '自動' : '手動';

  return (
    <footer className="flex h-6 shrink-0 items-stretch border-t bg-sidebar text-[11.5px]" role="contentinfo">
      <div className="flex min-w-0 flex-1 items-stretch overflow-hidden">
        <LeftStatus id={id} snap={snap} error={error} attention={attention} />
      </div>
      <div className="flex shrink-0 items-stretch">
        <Item title="全域執行佇列" onClick={() => navigate('/settings')}><ListOrdered className="size-3" />執行中 {running.length}/{queue.max}{queueText(running, waiting)}</Item>
        {snap && (
          <>
            <Item title={`${modeText}模式（全域設定）`} onClick={() => navigate('/settings')}><Settings2 className="size-3" />{modeText}</Item>
            <Item title="查看本專案 token 用量與訂閱額度" onClick={() => navigate(`/p/${id}/usage`)}><Coins className="size-3" />Tokens {tokenNumber(snap.usage?.totalTokens)}</Item>
          </>
        )}
        {version && <Item className="pr-2 opacity-70">v{version}</Item>}
      </div>
    </footer>
  );
}
