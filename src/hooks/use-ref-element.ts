// 讀 ref 指到的元素，元素出現或換掉時觸發重新 render。
// 給要在 DOM 元素上掛事件的 hook 用：對話框（Radix Portal）裡的輸入框要晚一輪才掛上，
// 只在第一次 effect 讀 ref.current 會拿到 null，之後就再也不會綁定。
import { useLayoutEffect, useRef, useState, type RefObject } from 'react';

export function useRefElement<T extends HTMLElement>(ref: RefObject<T | null>): T | null {
  const [element, setElement] = useState<T | null>(null);
  // 每次 render 後檢查一次；只有元素真的變了才 setState，不會無限重畫。
  useLayoutEffect(() => {
    if (ref.current !== element) setElement(ref.current);
  });
  return element;
}

/** 永遠拿到最新的值，但不讓它變成 effect 的依賴（例如每次 render 都是新的 callback）。 */
export function useLatest<T>(value: T) {
  const ref = useRef(value);
  useLayoutEffect(() => { ref.current = value; });
  return ref;
}
