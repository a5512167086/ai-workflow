// 技能會議：選擇會議、對話紀錄、執行紀錄與輸入區。狀態由 SkillsPage 持有，這裡只負責畫面。
import type { RefObject } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { Eyebrow, Notice } from '@/components/app/Page';
import { Markdown } from '@/components/app/Markdown';
import { StreamingText } from '@/components/app/StreamingReply';
import { LogTree } from '@/components/app/LogTree';
import { LiveSince } from '@/components/app/LiveSince';
import { PROVIDER_LABEL, PROVIDER_LONG, SKILL_RUN_STATUS } from '@/lib/constants';
import { shortTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useProject } from '@/stores/project';
import { runActive, runOptionLabel } from '@/features/skills/skill-utils';
import type { ChatMessage, Provider, Skill, SkillRun } from '@/types/api';

/** 技能會議 AI 正在打的回覆（逐字）。 */
function SkillTyping({ runId }: Readonly<{ runId: string }>) {
  const typing = useProject((s) => s.streams[`skill-${runId}`] || '');
  if (!typing) return null;
  return (
    <article className="mr-8 rounded-lg border bg-card p-3" data-testid="skill-typing">
      <div className="mb-1 text-xs text-muted-foreground">正在回覆…</div>
      <StreamingText text={typing} />
    </article>
  );
}

async function copyMessage(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success('已複製訊息');
  } catch {
    toast.error('無法存取剪貼簿，請選取文字複製');
  }
}

function MeetingMessage({ message, run, skill }: Readonly<{ message: ChatMessage; run: SkillRun; skill: Skill }>) {
  const user = message.role === 'user';
  return (
    <article className={cn('rounded-lg border p-3', user ? 'ml-8 bg-surface-2' : 'mr-8 bg-card')}>
      <div className="mb-1 flex items-center gap-2 text-xs text-muted-foreground">
        <b className="text-foreground">{user ? '你' : PROVIDER_LABEL[message.provider || run.provider || ''] || skill.name}</b>
        <span>{shortTime(message.at)}</span>
        <button type="button" className="ml-auto hover:text-foreground" onClick={() => copyMessage(message.text)}>複製</button>
      </div>
      {user ? <div className="selectable whitespace-pre-wrap text-[13px]">{message.text}</div> : <Markdown text={message.text} />}
    </article>
  );
}

/** 選中的會議：訊息、錯誤、正在打的回覆與執行紀錄。 */
function MeetingRun({ run, skill }: Readonly<{ run: SkillRun; skill: Skill }>) {
  const log = useProject((s) => s.logs[`skill-${run.id}`]);
  const running = runActive(run);
  return (
    <div className="flex flex-col gap-3">
      {(run.messages || []).map((m, i) => <MeetingMessage key={m.id || i} message={m} run={run} skill={skill} />)}
      {run.status === 'error' && <Notice tone="bad">這次回覆失敗：{run.error || '未知錯誤'}。請開新會議，或選擇已完成的會議接續。</Notice>}
      {running && <SkillTyping runId={run.id} />}
      {running && (
        <details open className="rounded-lg border bg-surface-2 p-2 text-xs">
          <summary className="cursor-pointer"><LiveSince label="正在回覆 · 查看執行紀錄" since={run.created_at || run.updated_at} /></summary>
          <div className="mt-2 max-h-80 overflow-auto rounded bg-card p-2"><LogTree text={log || '正在準備 CLI 與技能快照…'} /></div>
        </details>
      )}
    </div>
  );
}

export interface MeetingState {
  /** 目前顯示的會議；沒有選或是新會議時為 null。 */
  run: SkillRun | null;
  runs: SkillRun[];
  runId: string;
  statusText: string;
  active: boolean;
  blocked: boolean;
  input: string;
  provider: Provider;
}

export interface MeetingActions {
  onRunId: (id: string) => void;
  onNewRun: () => void;
  onToBacklog: () => void;
  onInput: (text: string) => void;
  onProvider: (provider: Provider) => void;
  onSend: () => void;
}

/** 會議分頁：上方選會議，中間是紀錄，下方是狀態與輸入區。 */
export function SkillMeeting({ skill, meeting, actions, inputRef, messagesRef }: Readonly<{
  skill: Skill;
  meeting: MeetingState;
  actions: MeetingActions;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  messagesRef: RefObject<HTMLDivElement | null>;
}>) {
  const { run, runs, runId, statusText, active, blocked, input, provider } = meeting;
  const shown = runId ? run : null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-4 py-2">
        <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
          會議<select aria-label="會議" value={runId} onChange={(e) => actions.onRunId(e.target.value)} className="h-7 max-w-72 rounded-md border border-input bg-transparent px-2 text-[12.5px] text-foreground">
            <option value="">新會議</option>
            {runs.map((r) => <option key={r.id} value={r.id}>{runOptionLabel(r, SKILL_RUN_STATUS)}</option>)}
          </select>
        </label>
        <Button type="button" variant="outline" size="sm" disabled={!runId} onClick={actions.onNewRun}>新會議</Button>
        <Button type="button" variant="outline" size="sm" disabled={shown?.status !== 'done'} onClick={actions.onToBacklog}>帶入需求待辦</Button>
      </div>
      <div ref={messagesRef} className="min-h-0 flex-1 overflow-auto p-4" role="log" aria-live="polite">
        {shown ? <MeetingRun run={shown} skill={skill} /> : (
          <div className="mx-auto max-w-lg py-10 text-center">
            <Eyebrow>技能會議</Eyebrow>
            <h3 className="mt-1 text-base font-semibold">與 {skill.name} 開一場會議</h3>
            <p className="mt-2 text-xs text-muted-foreground">{skill.description || ''} 會議是唯讀的釐清對話，AI 不會修改專案；確認的需求可帶入需求待辦。</p>
          </div>
        )}
      </div>
      <div className="shrink-0 border-t px-4 py-2">
        <LiveSince label={statusText} since={active ? run?.created_at || run?.updated_at : null} className="block text-xs" />
      </div>
      <form className="flex shrink-0 flex-col gap-2 px-4 pb-3" onSubmit={(e) => { e.preventDefault(); actions.onSend(); }}>
        <label className="sr-only" htmlFor="skill-input">需求或回答</label>
        <Textarea id="skill-input" ref={inputRef} rows={3} maxLength={20000} value={input} onChange={(e) => actions.onInput(e.target.value)} placeholder="描述需求或回答 AI 的問題…" className="min-h-16 selectable" onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); actions.onSend(); } }} />
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            AI<select aria-label="會議使用的 AI" value={provider} onChange={(e) => actions.onProvider(e.target.value as Provider)} className="h-7 rounded-md border border-input bg-transparent px-2 text-[12.5px] text-foreground">
              <option value="claude">{PROVIDER_LONG.claude}</option><option value="codex">{PROVIDER_LONG.codex}</option>
            </select>
          </label>
          <span className="text-[11px] text-muted-foreground">Enter 傳送 · Shift+Enter 換行 · 每次回覆是新的 CLI session，以會議紀錄交接</span>
          <Button type="submit" className="ml-auto" disabled={blocked}>送出</Button>
        </div>
      </form>
    </div>
  );
}
