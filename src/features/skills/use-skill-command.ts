// 訊息開頭輸入 / 列出技能（像 Claude Code 的 /skill）：方向鍵選擇、Enter／Tab 補上 `/名稱 `、Escape 關閉；中文組字時不處理。
// 清單用純 DOM 畫在 body 上，所以呼叫端只要 useSkillCommandInput(ref) 就好（回傳 void）。
import { useEffect, type RefObject } from 'react';
import { useRefElement } from '@/hooks/use-ref-element';
import { toast } from 'sonner';
import { errorMessage } from '@/lib/api';
import { skillCommandToken } from '@/lib/format';
import { useProject } from '@/stores/project';
import { openPopup, popupKeydown, type Popup } from '@/features/references/popup';
import type { Skill } from '@/types/api';

export function useSkillCommandInput(ref: RefObject<HTMLTextAreaElement | null>) {
  // 輸入框出現（例如對話框打開）或換掉時重新綁定。
  const input = useRefElement(ref);
  useEffect(() => {
    if (!input) return;
    let popup: Popup | null = null, timer: ReturnType<typeof setTimeout> | undefined, generation = 0, rows: Skill[] = [];
    let token: ReturnType<typeof skillCommandToken> = null;
    const hide = () => { popup?.remove(); popup = null; rows = []; generation++; };
    const choose = (index: number) => {
      const row = rows[index]; if (!row || !token) return;
      const selected = token; hide();
      input.setRangeText(`/${row.name} `, selected.start, selected.end, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true })); input.focus();
    };
    const onInput = () => {
      clearTimeout(timer); hide();
      token = skillCommandToken(input.value, input.selectionStart ?? input.value.length);
      if (!token) return;
      const current = generation, query = token.query;
      timer = setTimeout(async () => {
        try {
          const { skills } = await useProject.getState().api<{ skills?: Skill[] }>('/api/skills');
          if (current !== generation || !input.isConnected || document.activeElement !== input) return;
          rows = (skills || []).filter((skill) => skill.compatible && skill.name.includes(query))
            .sort((a, b) => Number(!a.name.startsWith(query)) - Number(!b.name.startsWith(query)) || a.name.localeCompare(b.name)).slice(0, 12);
          if (!rows.length) return;
          popup = openPopup(input, rows.map((skill) => ({ label: `/${skill.name}`, description: skill.description || '' })), choose, 'skill-suggestions', '技能');
        } catch (err) { toast.error(errorMessage(err)); }
      }, 120);
    };
    const onKeydown = (event: KeyboardEvent) => {
      if (popupKeydown(popup, event, choose, hide)) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    let blurTimer: ReturnType<typeof setTimeout> | undefined;
    const onBlur = () => { blurTimer = setTimeout(hide, 150); };
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onKeydown, true);
    input.addEventListener('blur', onBlur);
    return () => {
      clearTimeout(timer); clearTimeout(blurTimer); hide();
      input.removeEventListener('input', onInput);
      input.removeEventListener('keydown', onKeydown, true);
      input.removeEventListener('blur', onBlur);
    };
  }, [input]);
}
