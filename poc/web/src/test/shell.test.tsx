import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Logo } from '../ui/Logo';
import { Modal } from '../ui/Modal';
import { Drawer } from '../ui/Drawer';
import { Tabs } from '../ui/Tabs';
import { Tooltip, TooltipProvider } from '../ui/Tooltip';
import { Button } from '../ui/Button';
import { LazyPage } from '../shell/LazyPage';
import { fakeApi, sessionBody } from './fakeApi';
import { startApp, unmountAll } from './startApp';

async function openShell(hash = '#/') {
  fakeApi({ 'GET /api/analysis/v1/session': { body: sessionBody('admin') } });
  const app = await startApp(hash);
  const sidebar = await screen.findByRole('complementary', { name: '侧栏' });
  return { ...app, sidebar };
}

describe('sidebar', () => {
  it('is 220 px wide, collapses to 72 px with icons only, expands again, and remembers the choice', async () => {
    const { user, sidebar } = await openShell('#/');
    expect(sidebar).toHaveStyle({ width: '220px' });
    expect(within(sidebar).getByText('九安审单')).toBeInTheDocument();
    expect(within(sidebar).getByText('单据池')).toBeInTheDocument();

    await user.click(within(sidebar).getByRole('button', { name: '收起侧栏' }));
    expect(sidebar).toHaveStyle({ width: '72px' });
    expect(sidebar).toHaveAttribute('data-collapsed', 'true');
    expect(within(sidebar).queryByText('九安审单')).not.toBeInTheDocument();
    expect(within(sidebar).queryByText('单据池')).not.toBeInTheDocument();
    // 收起后图标仍能用：链接有名字，键盘可达。
    expect(within(sidebar).getByRole('link', { name: '单据池' })).toHaveAttribute('href', '#/documents');
    // 收起时链接外面包着提示（Radix Slot），选中态的样式不能被合并坏。
    const current = within(sidebar).getByRole('link', { name: '工作台' });
    expect(current).toHaveAttribute('aria-current', 'page');
    expect(current.className).toMatch(/bg-blue-50/);
    expect(current.className).not.toMatch(/=>|isActive/);

    unmountAll();
    const again = await openShell('#/');
    expect(again.sidebar).toHaveStyle({ width: '72px' });
    await again.user.click(within(again.sidebar).getByRole('button', { name: '展开侧栏' }));
    expect(again.sidebar).toHaveStyle({ width: '220px' });
    expect(within(again.sidebar).getByText('单据池')).toBeInTheDocument();
  });

  it('marks the current page (light blue, 2 px blue left line) and moves the mark on navigation', async () => {
    const { user, sidebar } = await openShell('#/documents');
    const documents = within(sidebar).getByRole('link', { name: '单据池' });
    expect(documents).toHaveAttribute('aria-current', 'page');
    expect(documents.className).toMatch(/bg-blue-50/);
    expect(documents.className).toMatch(/border-blue\b/);
    expect(within(sidebar).getByRole('link', { name: '工作台' })).not.toHaveAttribute('aria-current');

    await user.click(within(sidebar).getByRole('link', { name: '知识库' }));
    expect(await screen.findByRole('heading', { level: 1, name: '知识库' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/knowledge');
    expect(within(sidebar).getByRole('link', { name: '知识库' })).toHaveAttribute('aria-current', 'page');
    expect(within(sidebar).getByRole('link', { name: '单据池' })).not.toHaveAttribute('aria-current');
  });

  it('shows who is signed in and the role at the bottom', async () => {
    const { sidebar } = await openShell('#/');
    expect(within(sidebar).getByText('审核员')).toBeInTheDocument();
    expect(within(sidebar).getByText('管理员')).toBeInTheDocument();
  });
});

describe('pages of phase 1', () => {
  it('every entry opens its page under the shell', async () => {
    const { user, sidebar } = await openShell('#/');
    for (const [name, hash] of [['单据池', '#/documents'], ['知识库', '#/knowledge'], ['我的规则', '#/my-rules'], ['Agent 接入', '#/agents'], ['设置', '#/settings'], ['工作台', '#/']]) {
      await user.click(within(sidebar).getByRole('link', { name }));
      expect(await screen.findByRole('heading', { level: 1, name })).toBeInTheDocument();
      expect(window.location.hash).toBe(hash);
    }
  });

  it('keeps ?doc=<id> on #/documents for the drawer of a later task', async () => {
    await openShell('#/documents?doc=d-42');
    expect(await screen.findByRole('heading', { level: 1, name: '单据池' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/documents?doc=d-42');
  });

  it('settings links to the old back office pages of Jiuan', async () => {
    await openShell('#/settings');
    expect(await screen.findByRole('link', { name: /打开九安原来的后台配置/ })).toHaveAttribute('href', '/analysis.html#adminConfig');
    expect(screen.getByRole('link', { name: /打开九安原来的平台总览/ })).toHaveAttribute('href', '/analysis.html#platform');
  });

  it('an unknown address goes back to 工作台', async () => {
    await openShell('#/no-such-page');
    expect(await screen.findByRole('heading', { level: 1, name: '工作台' })).toBeInTheDocument();
    expect(window.location.hash).toBe('#/');
  });
});

describe('logo', () => {
  it('draws the navy gradient tile with the cyan-to-blue "document + check" mark and the wordmark', () => {
    const { container } = render(<Logo />);
    const stops = (id: string | null) => [...container.querySelectorAll(`linearGradient[id="${id}"] stop`)].map(s => s.getAttribute('stop-color'));
    const tile = container.querySelector('[data-logo-tile]')!;
    expect(tile).toBeInTheDocument();
    const bgId = tile.getAttribute('fill')!.match(/^url\(#(.+)\)$/)![1];
    expect(stops(bgId)).toEqual(['#142B56', '#0A1A39', '#061127']);
    const mark = container.querySelector('[data-logo-mark]')!;
    const markId = mark.getAttribute('stroke')!.match(/^url\(#(.+)\)$/)![1];
    expect(stops(markId)).toEqual(['#79F4BD', '#39D9E7', '#3875F6']);
    expect(mark.getAttribute('stroke-linecap')).toBe('square');
    expect(mark.getAttribute('stroke-linejoin')).toBe('miter');
    expect([...mark.querySelectorAll('path')].map(p => p.getAttribute('d'))).toEqual(['M6 3h9l3 3v15H6z', 'M9 13l2.5 2.5L16 11']);
    expect(screen.getByText('九安审单')).toBeInTheDocument();
  });

  it('two logos on one page do not share gradient ids', () => {
    const { container } = render(<><Logo /><Logo wordmark={false} /></>);
    const ids = [...container.querySelectorAll('linearGradient')].map(g => g.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(screen.getAllByText('九安审单')).toHaveLength(1);
  });
});

function Overlays() {
  const [modal, setModal] = useState(false);
  const [drawer, setDrawer] = useState(false);
  return (
    <TooltipProvider>
      <Button onClick={() => setModal(true)}>开弹框</Button>
      <Button onClick={() => setDrawer(true)}>开抽屉</Button>
      <Tooltip content="提示文字"><Button>悬停</Button></Tooltip>
      <Modal open={modal} onOpenChange={setModal} title="上传制度"><Tabs label="页签" items={[{ value: 'a', label: '甲', content: '甲的内容' }, { value: 'b', label: '乙', content: '乙的内容' }]} /></Modal>
      <Drawer open={drawer} onOpenChange={setDrawer} title="DGZF-F07-002">抽屉内容</Drawer>
    </TooltipProvider>
  );
}

describe('CSP: style-src \'self\'', () => {
  it('nothing puts a <style> element into the page — shell, modal, drawer, tabs, tooltip', async () => {
    const { user, sidebar } = await openShell('#/settings');
    await user.click(within(sidebar).getByRole('button', { name: '收起侧栏' }));
    await user.hover(within(sidebar).getByRole('link', { name: '单据池' }));
    expect(await screen.findByRole('tooltip', { name: '单据池' })).toBeInTheDocument();
    render(<Overlays />);
    await user.hover(screen.getByRole('button', { name: '悬停' }));
    expect(await screen.findByRole('tooltip', { name: '提示文字' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '开弹框' }));
    expect(await screen.findByRole('dialog', { name: '上传制度' })).toBeInTheDocument();
    await user.click(screen.getByRole('tab', { name: '乙' }));
    expect(document.querySelectorAll('style').length).toBe(0);
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: '开抽屉' }));
    expect(await screen.findByRole('dialog', { name: 'DGZF-F07-002' })).toBeInTheDocument();
    expect(document.querySelectorAll('style').length).toBe(0);
  });

  it('the drawer (430 px) and the modal close on the close button and on Escape', async () => {
    const user = userEvent.setup();
    render(<Overlays />);
    await user.click(screen.getByRole('button', { name: '开抽屉' }));
    const drawer = await screen.findByRole('dialog', { name: 'DGZF-F07-002' });
    expect(drawer).toHaveStyle({ width: '430px' });
    await user.click(within(drawer).getByRole('button', { name: '关闭' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '开弹框' }));
    await screen.findByRole('dialog', { name: '上传制度' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('a page that fails to open (LazyPage)', () => {
  function Throws({ error }: { error: Error }): never { throw error; }
  const quiet = () => vi.spyOn(console, 'error').mockImplementation(() => {});
  it('a chunk that cannot be downloaded: maybe a new version was just released — 刷新页面', () => {
    const spy = quiet();
    for (const error of [new TypeError('Failed to fetch dynamically imported module: https://x/assets/Documents-1.js'), new TypeError('error loading dynamically imported module'),
      new TypeError('Importing a module script failed.'), Object.assign(new Error('Loading chunk 3 failed.'), { name: 'ChunkLoadError' })]) {
      const { unmount } = render(<LazyPage><Throws error={error} /></LazyPage>);
      expect(screen.getByText('这一页没有打开')).toBeInTheDocument();
      expect(screen.getByText(/可能刚发布了新版本/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '刷新页面' })).toBeInTheDocument();
      unmount();
    }
    spy.mockRestore();
  });
  it('any other error: says the page ran into an error and offers 刷新页面, without blaming a release', () => {
    const spy = quiet();
    render(<LazyPage><Throws error={new TypeError("Cannot read properties of undefined (reading 'length')")} /></LazyPage>);
    expect(screen.getByText('这一页没有打开')).toBeInTheDocument();
    expect(screen.getByText('页面出了错，没能显示出来：刷新页面后再试；一直这样请联系管理员。')).toBeInTheDocument();
    expect(screen.queryByText(/新版本/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '刷新页面' })).toBeInTheDocument();
    spy.mockRestore();
  });
});
