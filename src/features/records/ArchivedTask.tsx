// 封存裡的一個任務：任務內容與當時的實作紀錄（log、審查意見、test 輸出、diff），唯讀。
import { useEffect, useMemo, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Hint, Loading, Notice } from '@/components/app/Page';
import { LogTree } from '@/components/app/LogTree';
import { DiffView } from '@/components/app/DiffView';
import { ReviewsView, TaskContent } from '@/features/board/TaskInspector';
import { errorMessage } from '@/lib/api';
import { useProject } from '@/stores/project';
import type { ArchivedTask as ArchivedTaskData, Task } from '@/types/api';

type Tab = 'task' | 'log' | 'reviews' | 'checks' | 'diff';

export function ArchivedTask({ archive, id, tasks }: Readonly<{ archive: string; id: string; tasks: Task[] }>) {
  const api = useProject((s) => s.api);
  const [data, setData] = useState<ArchivedTaskData | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('task');

  useEffect(() => {
    let alive = true;
    setData(null); setError('');
    api<ArchivedTaskData>(`/api/archive/${encodeURIComponent(archive)}/task/${id}`)
      .then((d) => { if (alive) setData(d); }, (err) => { if (alive) setError(errorMessage(err)); });
    return () => { alive = false; };
  }, [api, archive, id]);

  const done = useMemo(() => new Set(tasks.filter((t) => t.status === 'done').map((t) => String(t.id))), [tasks]);

  if (error) return <Notice tone="bad" role="alert">{error}</Notice>;
  if (!data) return <Loading inline label={`讀取任務 #${id}…`} className="px-1 py-3" />;
  const count = (n: number) => (n ? `（${n}）` : '');
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid={`archived-task-${id}`}>
      {!data.hasRecords && <Hint>這個任務沒有保存實作紀錄：可能還沒執行過，或是功能在 App 開始保存紀錄之前就封存了。</Hint>}
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="gap-2">
        <TabsList variant="line" aria-label={`任務 #${id} 的紀錄`}>
          <TabsTrigger value="task">任務內容</TabsTrigger>
          <TabsTrigger value="log" disabled={!data.log}>Log</TabsTrigger>
          <TabsTrigger value="reviews" disabled={!data.reviews.length}>審查意見{count(data.reviews.length)}</TabsTrigger>
          <TabsTrigger value="checks" disabled={!data.checks}>test 輸出</TabsTrigger>
          <TabsTrigger value="diff" disabled={!data.diff}>diff</TabsTrigger>
        </TabsList>
        <TabsContent value="task"><TaskContent task={data.task} implement={data.implement} done={done} /></TabsContent>
        <TabsContent value="log" className="h-[420px] overflow-hidden"><LogTree text={data.log} className="h-full" /></TabsContent>
        <TabsContent value="reviews"><ReviewsView reviews={data.reviews} /></TabsContent>
        <TabsContent value="checks"><pre className="mono selectable max-h-[420px] overflow-auto whitespace-pre-wrap rounded-md border bg-surface-2 p-2 text-xs">{data.checks}</pre></TabsContent>
        <TabsContent value="diff" className="h-[480px] overflow-hidden"><DiffView text={data.diff} className="h-full" /></TabsContent>
      </Tabs>
    </div>
  );
}
