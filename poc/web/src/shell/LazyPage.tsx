import { Component, Suspense, type ReactNode } from 'react';
import { Button } from '../ui/Button';
import { Empty } from '../ui/Empty';

/**
 * 按路由分开打包的页面（Ruling T6a）：下载时安静地等（只给读屏一句「正在打开」）；
 * 分包下载失败（多半是刚发布了新版本，旧的分包文件已经换掉）就这么说，给「刷新页面」；
 * 别的错（页面自己画的时候出错）只说页面出了错，同样给「刷新页面」，不往发布上推。
 */
export function LazyPage({ children }: { children: ReactNode }) {
  return (
    <PageBoundary>
      <Suspense fallback={<p role="status" className="sr-only">正在打开页面…</p>}>{children}</Suspense>
    </PageBoundary>
  );
}

// 浏览器下载不到分包时 import() 抛的错：Chrome「Failed to fetch dynamically imported module」、Firefox「error loading dynamically imported module」、
// Safari「Importing a module script failed.」；有的打包器叫 ChunkLoadError
const CHUNK_ERROR = /dynamically imported module|Importing a module script failed|Loading (?:CSS )?chunk [\w-]+ failed/i;
export const isChunkError = (error: unknown) => error instanceof Error && (error.name === 'ChunkLoadError' || CHUNK_ERROR.test(error.message));

class PageBoundary extends Component<{ children: ReactNode }, { failed: boolean; chunk: boolean }> {
  state = { failed: false, chunk: false };
  static getDerivedStateFromError(error: unknown) { return { failed: true, chunk: isChunkError(error) }; }
  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <Empty icon="warning" title="这一页没有打开"
        description={this.state.chunk ? '可能刚发布了新版本：刷新页面后再试；一直这样请联系管理员。' : '页面出了错，没能显示出来：刷新页面后再试；一直这样请联系管理员。'}
        action={<Button variant="primary" icon="refresh" onClick={() => window.location.reload()}>刷新页面</Button>} />
    );
  }
}
