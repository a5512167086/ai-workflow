import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, expect, vi } from 'vitest';

afterEach(() => cleanup());

// jsdom 沒有這些瀏覽器 API；元件只在有的時候才用。
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    }),
  });
}
if (!window.ResizeObserver) {
  window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};

// 按得下去：沒有 disabled，也沒有 aria-disabled（GuardButton 停用但有說明時用 aria-disabled，toBeEnabled 分不出來）。
expect.extend({
  toBeUsable(received: HTMLElement) {
    const disabled = received.matches(':disabled') || received.getAttribute('aria-disabled') === 'true';
    return { pass: !disabled, message: () => `expected element ${this.isNot ? 'not ' : ''}to be usable (no disabled / aria-disabled)` };
  },
});
declare module 'vitest' {
  interface Assertion { toBeUsable(): void }
  interface AsymmetricMatchersContaining { toBeUsable(): void }
}
