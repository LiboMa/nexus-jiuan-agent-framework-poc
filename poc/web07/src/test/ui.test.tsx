import { describe, expect, it, vi } from 'vitest';
import { useState } from 'react';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ICON_NAMES, Icon } from '../ui/icons';
import { Pill } from '../ui/Pill';
import { Segmented } from '../ui/Segmented';
import { Tabs } from '../ui/Tabs';
import { Panel } from '../ui/Panel';
import { Empty } from '../ui/Empty';
import { Button } from '../ui/Button';

describe('Icon', () => {
  it('has every name the later pages use', () => {
    expect(ICON_NAMES).toEqual(expect.arrayContaining([
      'dashboard', 'documents', 'knowledge', 'myRules', 'agent', 'settings', 'upload', 'search', 'check', 'cross', 'close', 'file',
      'chevronLeft', 'chevronRight', 'refresh', 'warning',
    ]));
  });

  it.each(ICON_NAMES)('%s is a square-line drawing on the 24 grid: stroke 1.6, square caps, miter joins, no rounding', name => {
    const { container } = render(<Icon name={name} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
    expect(svg.getAttribute('fill')).toBe('none');
    expect(svg.getAttribute('stroke')).toBe('currentColor');
    expect(svg.getAttribute('stroke-width')).toBe('1.6');
    expect(svg.getAttribute('stroke-linecap')).toBe('square');
    expect(svg.getAttribute('stroke-linejoin')).toBe('miter');
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.querySelectorAll('path, rect').length).toBeGreaterThan(0);
    expect(svg.querySelectorAll('circle, ellipse, [rx], [ry]').length).toBe(0);
    for (const path of svg.querySelectorAll('path')) expect(path.getAttribute('d')).not.toMatch(/[aAcCqQsStT]/);
  });

  it('can carry a name for screen readers when it stands alone', () => {
    render(<Icon name="warning" title="注意" />);
    expect(screen.getByRole('img', { name: '注意' })).toBeInTheDocument();
  });
});

describe('Pill', () => {
  it('pairs the pass and fail colours with ✓ / ✕ and words, never colour alone', () => {
    render(<><Pill tone="pass">建议通过</Pill><Pill tone="fail">不建议通过</Pill><Pill tone="wait">审核中</Pill></>);
    const pass = screen.getByText('建议通过').closest('[data-tone]')!;
    const fail = screen.getByText('不建议通过').closest('[data-tone]')!;
    expect(pass).toHaveAttribute('data-tone', 'pass');
    expect(pass.querySelector('svg [d="M5 12.5l4.5 4.5L19 7.5"]')).toBeInTheDocument();
    expect(fail.querySelector('svg [d="M6 6l12 12M18 6L6 18"]')).toBeInTheDocument();
    expect(screen.getByText('审核中').closest('[data-tone]')).toHaveAttribute('data-tone', 'wait');
  });
});

describe('Segmented', () => {
  function Window() {
    const [value, setValue] = useState<'today' | '14d' | 'month'>('14d');
    return <Segmented label="时间范围" value={value} onChange={setValue} options={[{ value: 'today', label: '今天' }, { value: '14d', label: '近 14 天' }, { value: 'month', label: '本月' }]} />;
  }

  it('is a radio group: click or arrow keys change the choice', async () => {
    const user = userEvent.setup();
    render(<Window />);
    const group = screen.getByRole('radiogroup', { name: '时间范围' });
    expect(within(group).getByRole('radio', { name: '近 14 天' })).toHaveAttribute('aria-checked', 'true');
    await user.click(within(group).getByRole('radio', { name: '今天' }));
    expect(within(group).getByRole('radio', { name: '今天' })).toHaveAttribute('aria-checked', 'true');
    await user.keyboard('{ArrowRight}');
    expect(within(group).getByRole('radio', { name: '近 14 天' })).toHaveAttribute('aria-checked', 'true');
    expect(within(group).getByRole('radio', { name: '近 14 天' })).toHaveFocus();
  });

  it('shows a count next to the label', () => {
    render(<Segmented label="单据" value="pending" onChange={vi.fn()} options={[{ value: 'pending', label: '待复核', count: 7 }, { value: 'all', label: '全部' }]} />);
    expect(screen.getByRole('radio', { name: '待复核 7' })).toBeInTheDocument();
  });
});

describe('Tabs', () => {
  it('switches the panel', async () => {
    const user = userEvent.setup();
    render(<Tabs label="单据" items={[{ value: 'advice', label: 'AI 建议', content: '建议内容' }, { value: 'evidence', label: '原件', count: 3, content: '原件内容' }]} />);
    expect(screen.getByRole('tabpanel')).toHaveTextContent('建议内容');
    await user.click(screen.getByRole('tab', { name: '原件 3' }));
    expect(screen.getByRole('tabpanel')).toHaveTextContent('原件内容');
    expect(screen.getByRole('tab', { name: '原件 3' })).toHaveAttribute('aria-selected', 'true');
  });
});

describe('Panel, Empty, Button', () => {
  it('Panel has a titled header and its body', () => {
    render(<Panel title="每天的 AI 建议" extra={<span>近 14 天</span>}><p>图</p></Panel>);
    const panel = screen.getByRole('region', { name: '每天的 AI 建议' });
    expect(within(panel).getByText('近 14 天')).toBeInTheDocument();
    expect(within(panel).getByText('图')).toBeInTheDocument();
  });

  it('Empty says what happened and what to do', () => {
    render(<Empty title="还没有单据" description="等汇联易的新单同步过来后会出现在这里。" action={<Button>刷新</Button>} />);
    expect(screen.getByText('还没有单据')).toBeInTheDocument();
    expect(screen.getByText('等汇联易的新单同步过来后会出现在这里。')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '刷新' })).toBeInTheDocument();
  });

  it('Button is a plain button by default, and is disabled while busy', async () => {
    const onClick = vi.fn();
    render(<><Button onClick={onClick}>提交复核</Button><Button variant="primary" busy onClick={onClick}>上传制度</Button></>);
    expect(screen.getByRole('button', { name: '提交复核' })).toHaveAttribute('type', 'button');
    const busy = screen.getByRole('button', { name: '上传制度' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');
    await userEvent.setup().click(screen.getByRole('button', { name: '提交复核' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
