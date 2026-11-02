import { useSyncExternalStore } from 'react';

/** 页面现在看得见吗（document.visibilityState 不是 hidden）：切到别的标签页、最小化时是 false。轮询的页面用它停下来。 */
export function usePageVisible(): boolean {
  return useSyncExternalStore(subscribe, () => document.visibilityState !== 'hidden', () => true);
}
function subscribe(listener: () => void) {
  document.addEventListener('visibilitychange', listener);
  return () => document.removeEventListener('visibilitychange', listener);
}
