import { useCallback, useMemo, useRef, useState } from 'react';

export interface OneAtATime {
  /** 正在做什么（页面上的状态行）；没在做是 null。 */
  busy: string | null;
  isBusy: () => boolean;
  run: <T>(status: string, work: () => Promise<T>) => Promise<T>;
}

/**
 * 这一页一次只做一件写操作（连接、启用、换钥匙、停用、复核、设为 / 取消审批 Agent）：每次都是真实调用 Nexus，九安还按人限每分钟 5 次。
 * 按钮要等下一次渲染才变灰，同一拍里的第二下由在途标记挡住：调用方先问 isBusy()，再 run()（run 同步地立起标记）。
 */
export function useOneAtATime(): OneAtATime {
  const inFlight = useRef(false);
  const [busy, setBusy] = useState<string | null>(null);
  const isBusy = useCallback(() => inFlight.current, []);
  const run = useCallback(async <T,>(status: string, work: () => Promise<T>): Promise<T> => {
    inFlight.current = true;
    setBusy(status);
    try { return await work(); } finally { inFlight.current = false; setBusy(null); }
  }, []);
  return useMemo(() => ({ busy, isBusy, run }), [busy, isBusy, run]);
}
