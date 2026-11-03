import { describe, expect, it } from 'vitest';
import { partialJsonString } from '@/lib/format';

const BS = '\\';

describe('partialJsonString：從寫到一半的 JSON 取出字串欄位', () => {
  it('欄位還沒出現回傳 null', () => {
    expect(partialJsonString('```json\n{"rea', 'message')).toBeNull();
  });

  it('字串寫到一半就回傳目前的內容，處理跳脫', () => {
    const raw = `{"message": "## 問題${BS}n1. 誰會用？${BS}n2. ${BS}"匯出`;
    expect(partialJsonString(raw, 'message')).toBe('## 問題\n1. 誰會用？\n2. "匯出');
    expect(partialJsonString(`{"message":"中文${BS}u6E2C`, 'message')).toBe('中文測');
    expect(partialJsonString(`{"message":"半個跳脫${BS}`, 'message')).toBe('半個跳脫');
  });

  it('字串結束後不包含後面的欄位', () => {
    expect(partialJsonString('{"message":"完成","ready":true,"summary":"x"}', 'message')).toBe('完成');
  });
});
