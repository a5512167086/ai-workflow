// 用量：本專案的 token 統計、節省 Token 的估計、各 AI 的訂閱額度與最近執行。
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Page, PageHeader, Panel, Hint } from '@/components/app/Page';
import { SAVING_FEATURES, USAGE_STAGES, WINDOW_NAMES } from '@/lib/constants';
import { tokenNumber, usageTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useProject } from '@/stores/project';
import type { UsageProvider, UsageSession, UsageSnapshot } from '@/types/api';

/** 上次主動查詢額度的時間（整個 App 共用；開啟用量頁超過一分鐘沒查過就再查）。 */
let lastUsageRefresh = 0;
let usageRefreshBusy = false;

/** 單次執行的估計節省：有省就顯示數字，精簡回覆另外標註（效果無法直接估算）。 */
export function savedText(session: UsageSession) {
  const saved = session.savedEstimate ? tokenNumber(session.savedEstimate) : '—';
  return session.terse ? `${saved}（精簡回覆）` : saved;
}

function windowDuration(minutes?: number) {
  if (!minutes) return '';
  return `（${minutes % 1440 === 0 ? minutes / 1440 + ' 天' : minutes % 60 === 0 ? minutes / 60 + ' 小時' : minutes + ' 分鐘'}視窗）`;
}

function ProviderCard({ provider }: { provider: UsageProvider }) {
  const latest = provider.latest;
  const windows = provider.limits?.windows || [];
  const context = latest?.context;
  return (
    <Panel title={`${provider.provider === 'claude' ? 'Claude Code' : 'Codex'} · ${provider.runtime}${provider.distro ? ` / ${provider.distro}` : ''}`} bodyClassName="space-y-1.5 text-xs">
      <p>本專案處理量：{tokenNumber(provider.tokens)} tokens</p>
      <p>最近執行：{latest?.label || '尚無紀錄'}{latest?.status === 'running' ? '（執行中）' : ''}</p>
      <p>本次輸入 {tokenNumber(latest?.tokens?.inputTokens)} ／輸出 {tokenNumber(latest?.tokens?.outputTokens)} tokens</p>
      <Hint>輸入內含快取讀取 {tokenNumber(latest?.tokens?.cacheReadTokens)} ／快取寫入 {tokenNumber(latest?.tokens?.cacheWriteTokens)}</Hint>
      <h3 className="pt-2 text-[12px] font-semibold">訂閱額度剩餘</h3>
      {!windows.length && <Hint>{provider.limits?.error || '未知：按「更新訂閱額度」查詢'}</Hint>}
      {windows.map((w) => {
        const remaining = w.expired ? null : w.remainingPercent;
        const name = WINDOW_NAMES[w.name] || w.name;
        return (
          <div key={w.name} className="space-y-1">
            <p>{name}{windowDuration(w.windowMinutes)}：{typeof remaining === 'number' ? remaining.toFixed(1) + '%' : '未知'}{w.status === 'rejected' && !w.expired ? ' · 已觸及限額' : ''}</p>
            {typeof remaining === 'number' && <Progress value={remaining} aria-label={`${name} 訂閱額度剩餘百分比`} />}
            <Hint>重設：{w.resetsText || usageTime(w.resetsAt)}{w.expired ? '；視窗已過期，請更新' : ''}</Hint>
          </div>
        );
      })}
      {provider.limits?.checkedAt && <Hint>額度資料擷取：{usageTime(provider.limits.checkedAt)} · {provider.provider === 'codex' ? 'Codex 官方查詢' : 'Claude CLI'}・所有專案共用</Hint>}
      {context && Number.isFinite(context.remainingPercent) && (
        <>
          <h3 className="pt-2 text-[12px] font-semibold">最近一次請求的 context 剩餘</h3>
          <Hint>{context.remainingPercent!.toFixed(1)}% · {tokenNumber(context.remainingTokens)} / {tokenNumber(context.capacity)} tokens{context.estimated ? '（依最後一次模型請求估算）' : '（CLI 回報）'}</Hint>
        </>
      )}
    </Panel>
  );
}

function SavingPanel({ usage }: { usage: UsageSnapshot }) {
  const saving = usage.tokenSaving || {};
  const terse = Object.entries(saving.terse || {}).filter(([, on]) => on).length;
  const items: [string, string, boolean][] = [
    ...Object.entries(SAVING_FEATURES).map(([key, label]): [string, string, boolean] => [key, label, saving[key] === true]),
    ['terse', `精簡回覆（${terse} 個角色）`, terse > 0],
  ];
  const stages = usage.byStage || [];
  const total = stages.reduce((sum, s) => sum + (s.tokens || 0), 0);
  return (
    <Panel title="節省 Token" actions={<Button asChild variant="outline" size="sm"><Link to="/settings">調整設定</Link></Button>} bodyClassName="space-y-2 text-xs">
      <p>估計省下 <strong>{tokenNumber(usage.savedEstimate ?? 0)}</strong> tokens</p>
      <Hint>估計值＝每次請求少送的 tokens × 請求次數。Claude 會回報請求次數；Codex 不回報，以 1 次計，所以是下限。精簡回覆與專案地圖的效果無法直接估算，請比較各階段的平均用量。</Hint>
      <ul className="flex flex-wrap gap-1.5" aria-label="目前的節省 Token 設定">
        {items.map(([key, label, on]) => (
          <li key={key} className={cn('rounded-full border px-2 py-px text-[11px]', on ? 'border-ok/40 bg-ok-soft text-ok' : 'text-muted-foreground')}>{on ? '開' : '關'}・{label}</li>
        ))}
      </ul>
      <h3 className="pt-1 text-[12px] font-semibold">依階段</h3>
      <Table>
        <TableHeader>
          <TableRow><TableHead>階段</TableHead><TableHead>次數</TableHead><TableHead>tokens</TableHead><TableHead>占比</TableHead><TableHead>平均每次</TableHead><TableHead>估計省下</TableHead></TableRow>
        </TableHeader>
        <TableBody>
          {stages.map((stage) => (
            <TableRow key={stage.stage}>
              <TableCell>{USAGE_STAGES[stage.stage] || stage.stage}</TableCell>
              <TableCell>{String(stage.sessions)}</TableCell>
              <TableCell>{tokenNumber(stage.tokens)}</TableCell>
              <TableCell>{total ? `${Math.round((stage.tokens / total) * 100)}%` : '—'}</TableCell>
              <TableCell>{tokenNumber(stage.sessions ? Math.round(stage.tokens / stage.sessions) : 0)}</TableCell>
              <TableCell>{stage.savedEstimate ? tokenNumber(stage.savedEstimate) : '—'}</TableCell>
            </TableRow>
          ))}
          {!stages.length && <TableRow><TableCell colSpan={6} className="text-muted-foreground">還沒有紀錄</TableCell></TableRow>}
        </TableBody>
      </Table>
    </Panel>
  );
}

export function UsagePage() {
  const api = useProject((s) => s.api);
  const usage = useProject((s) => s.snap?.usage);
  const [busy, setBusy] = useState(usageRefreshBusy);
  const [status, setStatus] = useState('');
  const [recentOpen, setRecentOpen] = useState(false);

  const refresh = useCallback(async () => {
    if (usageRefreshBusy) return;
    usageRefreshBusy = true; setBusy(true);
    setStatus('正在查詢 Claude 與 Codex 的訂閱額度（不會啟動模型對話、不耗額度）…');
    try {
      const next = await api<UsageSnapshot>('/api/usage/refresh', {});
      lastUsageRefresh = Date.now();
      const snap = useProject.getState().snap;
      if (snap) useProject.setState({ snap: { ...snap, usage: next } });
      setStatus('查詢結果如下；百分比是擷取當時的快照，其他工具的使用也會影響訂閱額度。');
    } catch (err) {
      setStatus((err as Error).message);
    } finally {
      usageRefreshBusy = false; setBusy(false);
    }
  }, [api]);

  useEffect(() => { if (Date.now() - lastUsageRefresh > 60000) refresh(); }, [refresh]);

  if (!usage) return <Page><PageHeader title="Token 用量與訂閱額度" /></Page>;
  return (
    <Page>
      <PageHeader
        title="Token 用量與訂閱額度"
        description={<>本專案已記錄 <strong className="text-foreground">{tokenNumber(usage.totalTokens)}</strong> tokens ／{usage.measuredSessions} 次有統計，{usage.unknownSessions} 次未回報</>}
        actions={<Button variant="outline" onClick={refresh} disabled={busy}><RefreshCw className={busy ? 'animate-spin' : ''} />更新訂閱額度</Button>}
      />
      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
        <div className="space-y-1">
          <Hint>Token 統計包含快取讀取，代表處理量。訂閱額度 % 由 CLI 回報，不能換算成固定剩餘 tokens；未回報時顯示未知。紀錄自此功能啟用後開始。</Hint>
          {status && <Hint role="status">{status}</Hint>}
        </div>
        <SavingPanel usage={usage} />
        <div className="grid gap-3 lg:grid-cols-2">
          {usage.providers.map((p) => <ProviderCard key={`${p.provider}-${p.runtime}-${p.distro || ''}`} provider={p} />)}
        </div>
        <Collapsible open={recentOpen} onOpenChange={setRecentOpen} className="rounded-lg border bg-card">
          <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-2 text-left">
            <ChevronDown className={`size-4 transition-transform ${recentOpen ? '' : '-rotate-90'}`} />
            <h2 className="text-[13px] font-semibold">最近 20 次執行</h2>
          </CollapsibleTrigger>
          <CollapsibleContent className="border-t px-3 py-2">
            <Table>
              <TableHeader>
                <TableRow><TableHead>工作</TableHead><TableHead>AI／環境</TableHead><TableHead>狀態</TableHead><TableHead>輸入 tokens</TableHead><TableHead>輸出 tokens</TableHead><TableHead>合計</TableHead><TableHead>估計省下</TableHead></TableRow>
              </TableHeader>
              <TableBody>
                {usage.recent.map((s, i) => (
                  <TableRow key={s.id || i}>
                    <TableCell>{s.label}</TableCell>
                    <TableCell>{s.provider} / {s.runtime}</TableCell>
                    <TableCell>{s.status === 'running' ? '執行中' : s.status === 'done' ? '完成' : '失敗'}</TableCell>
                    <TableCell>{tokenNumber(s.tokens?.inputTokens)}</TableCell>
                    <TableCell>{tokenNumber(s.tokens?.outputTokens)}</TableCell>
                    <TableCell>{tokenNumber(s.tokens?.totalTokens)}</TableCell>
                    <TableCell>{savedText(s)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CollapsibleContent>
        </Collapsible>
      </div>
    </Page>
  );
}
