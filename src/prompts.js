import fs from 'node:fs';
import path from 'node:path';
import { listSkills } from './skills.js';

const MAX_FILE_CHARS = 40000;
const MAX_DIFF_CHARS = 120000;

function clip(text, max) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n…（已截斷，原長度 ${text.length} 字元）`;
}

function readIfExists(root, rel) {
  const file = path.join(root, rel);
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** handover 與 context 檔：存在就附上內容，不存在就註明，讓新對話不必重新摸索專案。 */
export function contextBlock(root, cfg, { includeHandover = true } = {}) {
  const parts = [];
  if (includeHandover) {
    const h = readIfExists(root, cfg.handover_path);
    parts.push(`### Handover（${cfg.handover_path}）\n${h ? clip(h, MAX_FILE_CHARS) : '（尚不存在，這是第一個任務）'}`);
  }
  for (const rel of cfg.context_files) {
    const t = readIfExists(root, rel);
    if (t != null) parts.push(`### ${rel}\n${clip(t, MAX_FILE_CHARS)}`);
  }
  return parts.length ? parts.join('\n\n') : '（沒有 context 檔）';
}

function commandsBlock(cfg) {
  const c = cfg.commands;
  const rows = ['build', 'lint', 'test'].filter((k) => c[k]).map((k) => `- ${k}: \`${c[k]}\``);
  return rows.length ? rows.join('\n') : '- （未設定 build/test/lint 指令）';
}

const PRD_SECTIONS = `1. 概述與目標
2. 非目標（明確不做的事）
3. 使用者與使用情境
4. 功能需求（逐條編號，可驗收）
5. 技術考量（架構、資料、相依、風險）
6. 驗收標準
7. 待確認問題`;

export function prdDraftPrompt(root, cfg, idea) {
  return `你是產品需求文件（PRD）的作者。請根據以下想法與專案背景，寫一份可以直接拆解為開發任務的 PRD。

## 想法
${idea}

## 專案背景
${contextBlock(root, cfg, { includeHandover: false })}

## 要求
- 使用與「想法」相同的語言撰寫。
- 章節：
${PRD_SECTIONS}
- 範圍要能在一個小功能分支內完成；不確定的地方寫進「待確認問題」，不要自行擴大範圍。
- 不要修改任何檔案。最後的回覆只輸出 PRD 的 Markdown 本文，不要前言或結語。`;
}

export function prdReviewPrompt(root, cfg, prd, round) {
  return `你是 PRD 審查者（第 ${round} 輪）。請嚴格但務實地審查下列 PRD，找出會導致實作錯誤、無法驗收、範圍過大或互相矛盾的問題。

## 專案背景
${contextBlock(root, cfg, { includeHandover: false })}

## PRD
${prd}

## 回覆格式
- 用條列寫出具體問題與建議修改（引用章節或需求編號）。沒有重大問題就簡短說明理由。
- 不要修改任何檔案。
- 最後一行必須是以下其中之一：
VERDICT: APPROVE
VERDICT: REVISE`;
}

export function prdRevisePrompt(root, cfg, prd, feedback, source) {
  return `你是 PRD 的作者。請根據${source}的意見修訂 PRD，輸出完整的新版本。

## 目前的 PRD
${prd}

## ${source}意見
${feedback}

## 專案背景
${contextBlock(root, cfg, { includeHandover: false })}

## 要求
- 保留原本的章節結構：
${PRD_SECTIONS}
- 只處理意見中合理的部分；不同意的意見，在「待確認問題」說明原因。
- 不要修改任何檔案。最後的回覆只輸出修訂後 PRD 的 Markdown 本文，不要前言或結語。`;
}

export function tasksFromPrdPrompt(root, cfg, prd) {
  const count = cfg.num_tasks > 0 ? `剛好 ${cfg.num_tasks} 個` : '適當數量（通常 3–10 個）';
  return `你負責把 PRD 拆成可以逐一交給 AI 實作的開發任務（內建任務格式）。

## PRD
${prd}

## 專案背景
${contextBlock(root, cfg, { includeHandover: false })}

## 要求
- 拆成${count}任務，依實作順序排列；每個任務可以在一個對話內完成並用測試驗證。
- dependencies 只能引用排在前面的任務編號（從 1 開始）。
- 每個任務列出對應 PRD 需求編號 requirement_ids 與可觀察的 acceptanceCriteria；確保所有需求都有任務涵蓋。
- skills 可以選擇以下適用技能，沒有適用的就留空：${listSkills(root).filter(s => s.compatible).map(s => `${s.name}（${s.description}）`).join('、')}。
- 使用與 PRD 相同的語言。
- 不要修改任何檔案。最後的回覆只輸出一個 JSON 物件，不要其他文字或圍欄：
{"tasks":[{"title":"","description":"","details":"實作細節","testStrategy":"怎麼驗證","priority":"high|medium|low","dependencies":[],"requirement_ids":[],"acceptanceCriteria":[],"skills":[]}]}`;
}

function taskBlock(task) {
  return '```json\n' + JSON.stringify(task, null, 2) + '\n```';
}

export function implementPrompt(root, cfg, task) {
  return `你正在一個全新的對話中實作 開發任務 ${task.id}。先閱讀 handover 與 context 了解目前進度，再動手。

## Handover 與專案 context
${contextBlock(root, cfg)}

## 任務
${taskBlock(task)}

完整 PRD 在 \`${cfg.prd_path}\`，需要時自行閱讀。

## 驗證指令（完成後 aipipe 會自動執行）
${commandsBlock(cfg)}

## 規則
- 只做這個任務範圍內的事，不要順手實作其他任務。
- 需要時新增或更新測試，讓上面的驗證指令能通過。
- 不要執行 git commit、git push、切換分支，也不要修改 .aipipe/、.taskmaster/ 與 ${cfg.handover_path}。
- 完成後簡短回報：改了哪些檔案、怎麼驗證、還有什麼風險。`;
}

export function fixChecksPrompt(root, cfg, task, failures, round) {
  return `你正在修正 開發任務 ${task.id} 的實作（第 ${round} 輪修正）。驗證指令失敗，請修好它們。

## 任務
${taskBlock(task)}

## 失敗的驗證輸出
${clip(failures, MAX_FILE_CHARS)}

## 驗證指令
${commandsBlock(cfg)}

## 規則
- 找出根本原因再修，不要為了讓測試通過而刪除或弱化測試。
- 不要執行 git commit、git push、切換分支，也不要修改 .aipipe/、.taskmaster/ 與 ${cfg.handover_path}。
- 完成後簡短說明修了什麼。`;
}

export function fixReviewPrompt(root, cfg, task, review, round) {
  return `你正在修正 開發任務 ${task.id} 的實作（第 ${round} 輪修正）。程式碼審查者提出以下意見，請處理。

## 任務
${taskBlock(task)}

## 審查意見
${clip(review, MAX_FILE_CHARS)}

## 驗證指令
${commandsBlock(cfg)}

## 規則
- 處理合理的意見；不同意的意見在回覆中說明理由。
- 不要執行 git commit、git push、切換分支，也不要修改 .aipipe/、.taskmaster/ 與 ${cfg.handover_path}。
- 完成後簡短說明改了什麼。`;
}

export function codeReviewPrompt(root, cfg, task, diff, checkSummary) {
  return `你是程式碼審查者。請審查 開發任務 ${task.id} 的變更是否正確完成任務、有沒有錯誤、安全問題、遺漏的測試或超出範圍的修改。

## 任務
${taskBlock(task)}

## 驗證結果
${checkSummary}

## 變更（git diff）
\`\`\`diff
${clip(diff, MAX_DIFF_CHARS)}
\`\`\`

## 回覆格式
- 只列出需要修改的具體問題（檔案、位置、原因、建議）。風格偏好不算問題。
- 不要修改任何檔案。
- 最後一行必須是以下其中之一：
VERDICT: PASS
VERDICT: FAIL`;
}

export function handoverPrompt(root, cfg, task, implementNotes, diffStat) {
  return `請更新 handover 文件 \`${cfg.handover_path}\`，讓下一個全新對話能直接接手。任務 ${task.id}「${task.title}」剛完成並通過驗證與審查。

## 目前的 handover
${readIfExists(root, cfg.handover_path) ?? '（尚不存在，請建立）'}

## 這個任務的實作說明
${clip(implementNotes || '（無）', 8000)}

## 變更摘要
${clip(diffStat, 8000)}

## 要求
- 只編輯 \`${cfg.handover_path}\` 這一個檔案（不存在就建立，包含上層資料夾）。
- 內容包含：目前進度（已完成的任務）、這次改了什麼與原因、重要決策與注意事項、下一步建議、已知問題。
- 保持精簡，刪掉過時內容，不要貼大段程式碼。
- 不要修改其他檔案，不要執行 git 指令。`;
}

/** AI 偶爾會用 \`\`\`markdown 包住整份輸出，存檔前去掉外層圍欄。 */
export function stripOuterFence(text) {
  const t = String(text || '').trim();
  const m = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i);
  if (m) return m[1].trim();
  // 「這是 PRD：」之類的短前言 + 結尾的 ```markdown 區塊：只留區塊內容。
  const tail = t.match(/^([\s\S]{0,300}?)\n```(?:markdown|md)\s*\n([\s\S]*?)\n```$/i);
  return tail && !tail[1].includes('```') && !/^\s*#/.test(tail[1]) ? tail[2].trim() : t;
}
