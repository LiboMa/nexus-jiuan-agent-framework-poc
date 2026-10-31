import { Component, Suspense, type ReactNode } from 'react';
import { Button } from '../ui/Button';
import { Empty } from '../ui/Empty';

/**
 * 按路由分开打包的页面（Ruling T6a）：下载时安静地等（只给读屏一句「正在打开」）；
 * 下载失败（多半是刚发布了新版本，旧的分包文件已经换掉）就说清楚，给「刷新页面」。
 */
export function LazyPage({ children }: { children: ReactNode }) {
  return (
    <PageBoundary>
      <Suspense fallback={<p role="status" className="sr-only">正在打开页面…</p>}>{children}</Suspense>
    </PageBoundary>
  );
}

class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Empty icon="warning" title="这一页没有打开" description="可能刚发布了新版本：刷新页面后再试；一直这样请联系管理员。"
        action={<Button variant="primary" icon="refresh" onClick={() => window.location.reload()}>刷新页面</Button>} />
    );
  }
}
