import { createHashRouter, Navigate, RouterProvider } from 'react-router-dom';
import { AppShell, ProjectLayout } from '@/components/app/AppShell';
import { HomePage } from '@/features/home/HomePage';
import { SettingsPage } from '@/features/settings/SettingsPage';
import { ChatPage } from '@/features/chat/ChatPage';
import { BacklogPage } from '@/features/backlog/BacklogPage';
import { PrdPage } from '@/features/prd/PrdPage';
import { BoardPage } from '@/features/board/BoardPage';
import { RecordsPage } from '@/features/records/RecordsPage';
import { GraphPage } from '@/features/graph/GraphPage';
import { UsagePage } from '@/features/usage/UsagePage';
import { SkillsPage } from '@/features/skills/SkillsPage';

// Hash 路由：Tauri 以 tauri://localhost 提供靜態檔，沒有伺服器端的路由回退。
const router = createHashRouter([
  {
    path: '/',
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'settings', element: <SettingsPage /> },
      {
        path: 'p/:id',
        element: <ProjectLayout />,
        children: [
          { index: true, element: <Navigate to="chat" replace /> },
          { path: 'chat', element: <ChatPage /> },
          { path: 'backlog', element: <BacklogPage /> },
          { path: 'prd', element: <PrdPage /> },
          { path: 'board', element: <BoardPage /> },
          { path: 'records', element: <RecordsPage /> },
          { path: 'graph', element: <GraphPage /> },
          { path: 'usage', element: <UsagePage /> },
          { path: 'skills', element: <SkillsPage /> },
          { path: '*', element: <Navigate to="chat" replace /> },
        ],
      },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
]);

export default function App() {
  return <RouterProvider router={router} />;
}
