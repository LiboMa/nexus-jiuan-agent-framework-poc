import { QueryClient } from '@tanstack/react-query';
import { ApiError } from './client';

/** 整个前端共用一个查询缓存（会话、单据、看板……）。退出或会话过期时由 session.ts 清掉。 */
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // 4xx 是服务端的明确答复，重试也一样；网络或 5xx 只重试一次。
      retry: (failures, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && failures < 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
    mutations: { retry: false },
  },
});
