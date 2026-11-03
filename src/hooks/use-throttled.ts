// 節流：值一直在變（AI 逐字輸出）時，最多每 ms 毫秒更新一次畫面，最後一個值一定會顯示。
// Markdown 重畫比較貴，打字很快時不要每個字都重畫。
import { useEffect, useRef, useState } from 'react';

export function useThrottled<T>(value: T, ms = 120): T {
  const [shown, setShown] = useState(value);
  const last = useRef(0);
  useEffect(() => {
    const wait = last.current + ms - Date.now();
    if (wait <= 0) { last.current = Date.now(); setShown(value); return; }
    const t = setTimeout(() => { last.current = Date.now(); setShown(value); }, wait);
    return () => clearTimeout(t);
  }, [value, ms]);
  return shown;
}
