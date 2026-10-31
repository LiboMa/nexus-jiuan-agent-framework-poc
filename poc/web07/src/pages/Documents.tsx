/**
 * 单据池（Spec 第 6 节；样稿 drafts-v2.html 的 A 版表格 + drawer-a.html）：九安的对公付款单，按外壳的复核状态分
 * 「待复核（pending + outdated）/ 已复核（reviewed）/ 全部」。最多读 500 张（每页 50 张），状态 50 张一批问；页签、翻页都在页面里做（Ruling T5d）。
 * 点一行开右侧抽屉（地址 ?doc=<id>）；抽屉开着时表格照样能点，点另一行就换单。提交复核后开「待复核」里的下一张（Ruling T5f）。
 * 开着时自己刷新（F2）：表格这一页有审核中的行、或「待复核」是空的，每 12 秒问一次复核状态；单据池是空的，每 12 秒读一次列表；
 * 页面藏起来（切到别的标签页）或离开单据池就停。「刷新」、再搜一次同样的字都重新读列表和状态。
 * 账号在九安里没有公司（规则发布复核人，Ruling FR1）：单据池是空的，照直说，不轮询。
 */
import { useMemo, useRef, useState, type FormEvent, type Ref } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { ApiError } from '../api/client';
import { hasNoCompanies, useSession } from '../api/session';
import {
  POOL_MAX, POOL_POLL_MS, SCAN_MAX, amountText, isDocumentId, itemText, keys, loadPool, loadStates, type DocumentItem, type LatestState,
} from '../api/documents';
import { PageHeader } from '../shell/PageHeader';
import { DocumentDrawer } from '../documents/DocumentDrawer';
import { adviceLabel, reviewLabel } from '../documents/labels';
import { Button } from '../ui/Button';
import { Empty } from '../ui/Empty';
import { Icon } from '../ui/icons';
import { Panel } from '../ui/Panel';
import { Pill } from '../ui/Pill';
import { Segmented } from '../ui/Segmented';
import { cx } from '../ui/cx';
import { usePageVisible } from '../ui/usePageVisible';

type PoolTab = 'pending' | 'reviewed' | 'all';
const PAGE_ROWS = 20;
const IN_TAB: Record<Exclude<PoolTab, 'all'>, ReadonlySet<string>> = { pending: new Set(['pending', 'outdated']), reviewed: new Set(['reviewed']) };
const POOL_STATES = ['reviews', 'latest', 'pool'] as const;
const messageOf = (error: unknown) => (error instanceof ApiError ? error.message : '读取没有成功，请刷新页面重试。');

export function Documents() {
  const session = useSession();
  const [params, setParams] = useSearchParams();
  const docParam = params.get('doc');
  const [tab, setTab] = useState<PoolTab>('pending');
  const [draft, setDraft] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [notice, setNotice] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const tableRef = useRef<HTMLTableElement | null>(null);
  const queryClient = useQueryClient();
  const visible = usePageVisible();
  const noCompanies = hasNoCompanies(session?.user);
  const polling = visible && !noCompanies;
  // 复核状态要不要轮询，由这一次渲染算出的表格决定（见下面 rows）；查询在渲染之后才读它
  const pollStates = useRef(false);

  const pool = useQuery({ queryKey: keys.pool(q), queryFn: () => loadPool(q),
    refetchInterval: query => (polling && query.state.status === 'success' && !query.state.data?.items.length ? POOL_POLL_MS : false) });
  const items = useMemo(() => pool.data?.items ?? [], [pool.data]);
  const ids = useMemo(() => items.map(item => item.id), [items]);
  const states = useQuery({ queryKey: keys.poolStates(ids), queryFn: () => loadStates(ids), enabled: pool.isSuccess && ids.length > 0,
    refetchInterval: () => (pollStates.current ? POOL_POLL_MS : false) });
  const stateOf = (id: string): LatestState | undefined => states.data?.[id];

  const lists = useMemo(() => {
    const known = states.data ?? {};
    return {
      pending: items.filter(item => IN_TAB.pending.has(known[item.id]?.state)),
      reviewed: items.filter(item => IN_TAB.reviewed.has(known[item.id]?.state)),
      all: items,
    };
  }, [items, states.data]);
  const shown = lists[tab];
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_ROWS));
  const current = Math.min(page, pages);
  const rows = shown.slice((current - 1) * PAGE_ROWS, current * PAGE_ROWS);
  const counted = states.isSuccess || ids.length === 0;
  // 单据池里有审核中的单（等它出结果；默认的「待复核」页签里看不到它们），或「待复核」是空的（等新的单）：每 12 秒问一次
  pollStates.current = polling && states.isSuccess && (items.some(item => states.data?.[item.id]?.state === 'running') || lists.pending.length === 0);
  // 复核的回调可能来自更早的一次渲染（提交还在路上时人换了单）：现在开着哪张、待复核的顺序都从这两个 ref 读
  const currentDoc = useRef(docParam);
  currentDoc.current = docParam;
  const pendingOrder = useRef<string[]>([]);
  pendingOrder.current = lists.pending.map(item => item.id);

  function setDoc(id: string | null) {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      if (id) next.set('doc', id); else next.delete('doc');
      return next;
    }, { replace: true });
  }
  function open(id: string) {
    setNotice(null);
    setDoc(id);
  }
  /** 「待复核」里接着这一张往下的那一张（到底了从头找）；没有了回 null。 */
  function nextPending(from: string): string | null {
    const order = pendingOrder.current;
    const at = order.indexOf(from);
    return [...order.slice(at + 1), ...order.slice(0, Math.max(at, 0))].find(id => id !== from) ?? null;
  }
  function afterReview(id: string) {
    // 这一次复核提交时人已经换到别的单上了：记下就好，不把人拉走
    if (currentDoc.current !== id) return;
    const next = nextPending(id);
    if (next) { open(next); return; }
    setDoc(null);
    setNotice('待复核的单据都处理完了');
  }
  // 「刷新」：重新读列表，再重新问复核状态（单据没变时还是同一个查询）；连点只算一次
  const refreshing = useRef(false);
  const [refreshBusy, setRefreshBusy] = useState(false);
  async function refresh() {
    if (refreshing.current) return;
    refreshing.current = true;
    setRefreshBusy(true);
    try {
      await pool.refetch();
      await queryClient.refetchQueries({ queryKey: POOL_STATES, type: 'active' });
    } finally {
      refreshing.current = false;
      setRefreshBusy(false);
    }
  }
  function search(event: FormEvent) {
    event.preventDefault();
    const next = draft.trim();
    // 同样的字再搜一次：照样重新读
    if (next === q) void refresh(); else setQ(next);
    setPage(1);
  }
  function clearSearch() { setDraft(''); setQ(''); setPage(1); }
  function changeTab(next: PoolTab) { setTab(next); setPage(1); setNotice(null); }

  const options = (['pending', 'reviewed', 'all'] as const).map(value => ({
    value, label: { pending: '待复核', reviewed: '已复核', all: '全部' }[value], count: counted && pool.isSuccess ? lists[value].length : undefined,
  }));
  const poolItem = docParam ? items.find(item => item.id === docParam) : undefined;

  /** 关抽屉后焦点回到那一行；那一行不在这一页（或已离开这个页签）就落到表格上，表格也没有就落到搜索框。 */
  function focusAfterClose(closedId: string) {
    const row = isDocumentId(closedId) ? document.querySelector<HTMLButtonElement>(`[data-open-doc="${closedId}"]`) : null;
    (row ?? tableRef.current ?? searchRef.current)?.focus();
  }

  const drawerOpen = Boolean(docParam);
  return (
    // 抽屉开着时宽屏（≥ 1280 px）让出它的 430 px（内容区自己有 26 px 右边距，再留 16 px 空），表格每一栏、搜索框都看得见；窄屏照旧叠在上面
    <div data-testid="pool-content" data-drawer-open={drawerOpen ? 'true' : 'false'} className={cx(drawerOpen && 'xl:mr-[420px]')}>
      <PageHeader
        title="单据池"
        note="对公付款单的 AI 建议与复核"
        actions={(
          <form role="search" onSubmit={search} className="flex items-center gap-2">
            <label className="flex h-[30px] w-[240px] items-center gap-2 rounded-ctl border border-line bg-surface px-[10px] text-steel focus-within:border-blue">
              <Icon name="search" size={16} />
              <input
                ref={searchRef} type="search" value={draft} onChange={event => setDraft(event.target.value)} maxLength={100} autoComplete="off"
                aria-label="搜索单号、收款方" placeholder="搜索单号、收款方" className="min-w-0 flex-1 bg-transparent text-13 text-ink outline-none placeholder:text-faint"
              />
            </label>
            <Button type="submit">搜索</Button>
            <Button icon="refresh" busy={refreshBusy} onClick={() => void refresh()}>刷新</Button>
          </form>
        )}
      />
      <Segmented<PoolTab> label="复核状态" options={options} value={tab} onChange={changeTab} className="mt-[14px]" />

      {notice && (
        <div role="status" className="mt-[14px] flex items-center gap-2 rounded-box border border-pass-200 bg-pass-50 px-[14px] py-[10px] text-13 text-ink">
          <span className="text-pass"><Icon name="check" size={16} /></span>
          <span className="font-semibold">{notice}</span>
          <span className="text-steel">复核过的单据在「已复核」里；有新的 AI 建议时会回到「待复核」。</span>
        </div>
      )}
      {states.isError && (
        <div role="alert" className="mt-[14px] flex items-center gap-2 rounded-box border border-wait-200 bg-wait-50 px-[14px] py-[10px] text-13">
          <span className="text-wait"><Icon name="warning" size={16} /></span>
          <span className="min-w-0 flex-1">{messageOf(states.error)}</span>
          <Button size="sm" icon="refresh" onClick={() => void states.refetch()}>重新读取</Button>
        </div>
      )}

      <Panel className="mt-[14px] overflow-x-auto">
        {pool.isPending ? <p role="status" className="m-0 px-4 py-10 text-center text-13 text-steel">正在读取单据…</p>
          : pool.isError ? (
            <Empty icon="warning" title="单据池没有读出来" description={messageOf(pool.error)}
              action={<Button icon="refresh" onClick={() => void pool.refetch()}>重新读取</Button>} />
          )
            : !items.length ? (
              q ? <Empty icon="search" title="没有找到单据" description="换个单号或收款方再搜一次，或清空搜索看全部单据。" action={<Button onClick={clearSearch}>清空搜索</Button>} />
                : noCompanies
                  ? <Empty title="这个账号没有可看的单据" description="这个账号没有分到任何公司，所以单据池是空的。要看单据，请换管理员或分析员账号登录。" />
                  : <Empty title="单据池里还没有对公付款单" description="汇联易的新单同步过来、读完详情后会出现在这里；要造一张测试单，打开测试台的「模拟来单」。" />
            )
              : tab !== 'all' && !states.isSuccess ? (
                states.isError ? null : <p role="status" className="m-0 px-4 py-10 text-center text-13 text-steel">正在读取复核状态…</p>
              )
                : !rows.length ? (
                  tab === 'pending'
                    ? <Empty icon="check" title="没有待复核的单据" description="AI 给出新建议后，单据会出现在这里；复核过的在「已复核」里。" />
                    : <Empty title="还没有复核过的单据" description="在「待复核」里打开一张单，采纳或改判 AI 建议后，它会出现在这里。" />
                ) : (
                  <PoolTable tableRef={tableRef} rows={rows} selected={docParam} stateOf={stateOf} statesReady={states.isSuccess} onOpen={open} compact={drawerOpen} />
                )}
      </Panel>

      {pool.isSuccess && rows.length > 0 && pages > 1 && (
        <div className="mt-3 flex items-center justify-end gap-2 text-13 text-steel">
          <span>第 {current} / {pages} 页</span>
          <Button size="sm" icon="chevronLeft" disabled={current <= 1} onClick={() => setPage(current - 1)}>上一页</Button>
          <Button size="sm" disabled={current >= pages} onClick={() => setPage(current + 1)}>下一页<Icon name="chevronRight" size={14} /></Button>
        </div>
      )}
      {pool.data?.capped && (
        <p className="m-0 mt-3 text-12 text-steel">
          {pool.data.stoppedBy === 'scan'
            ? `只读了最近的 ${SCAN_MAX.toLocaleString('en-US')} 张单据，其中 ${items.length.toLocaleString('en-US')} 张对公付款单：要找更早的单，请按单号或收款方搜索。`
            : `只列出了最近的 ${POOL_MAX} 张对公付款单：要找更早的单，请按单号或收款方搜索。`}
        </p>
      )}

      <DocumentDrawer
        id={docParam}
        item={poolItem}
        role={session?.user.role}
        onClose={() => setDoc(null)}
        onReviewed={afterReview}
        onNext={docParam ? () => { const next = nextPending(docParam); if (next) open(next); } : undefined}
        hasNext={docParam ? nextPending(docParam) !== null : false}
        returnFocus={focusAfterClose}
      />
    </div>
  );
}

/**
 * 抽屉开着时（compact，P1）：宽屏上表格只剩视口减去侧栏和抽屉的宽度（1280 px、侧栏展开时约 586 px），六栏都要放下、不横向滚动——
 * 单号、金额、AI 建议、复核定宽（放得下单号、百万级的金额和最长的状态），板块和事项平分剩下的，最多两行，放不下的截掉（悬停看全文）；格子左右边距收窄。
 */
const COMPACT_WIDTHS = [116, null, null, 104, 112, 128] as const;

function PoolTable({ tableRef, rows, selected, stateOf, statesReady, onOpen, compact }: {
  tableRef: Ref<HTMLTableElement>; rows: DocumentItem[]; selected: string | null; stateOf: (id: string) => LatestState | undefined; statesReady: boolean; onOpen: (id: string) => void;
  compact: boolean;
}) {
  const pad = compact ? 'px-2' : 'px-3';
  const head = cx('whitespace-nowrap border-b border-line py-[9px] text-left text-12 font-medium text-steel', pad);
  const cell = cx('whitespace-nowrap border-b border-line py-[11px]', pad);
  // 板块、事项：宽的时候一行、截到最宽；挤的时候最多两行
  const wraps = (wide: string) => (compact ? cx('border-b border-line py-[11px]', pad) : cx(cell, wide));
  const clamp = 'line-clamp-2 whitespace-normal [overflow-wrap:anywhere]';
  return (
    // tabIndex -1：关抽屉后那一行不在屏上时，焦点落在表格上（不进 Tab 顺序）
    <table ref={tableRef} tabIndex={-1} aria-label="单据" className={cx('w-full border-collapse', compact && 'table-fixed')}>
      {compact && <colgroup>{COMPACT_WIDTHS.map((width, index) => <col key={index} style={width ? { width } : undefined} />)}</colgroup>}
      <thead>
        <tr>
          <th scope="col" className={head}>单号</th>
          <th scope="col" className={head}>板块</th>
          <th scope="col" className={head}>事项</th>
          <th scope="col" className={cx(head, 'text-right')}>金额</th>
          <th scope="col" className={head}>AI 建议</th>
          <th scope="col" className={head}>复核</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(item => {
          const state = stateOf(item.id);
          const advice = statesReady && state ? adviceLabel(state) : null;
          const review = statesReady && state ? reviewLabel(state) : null;
          const on = item.id === selected;
          return (
            <tr
              key={item.id} data-number={item.number ?? item.id} aria-current={on ? 'true' : undefined} onClick={() => onOpen(item.id)}
              className={cx('cursor-pointer', on ? 'bg-blue-50' : 'hover:bg-canvas')}
            >
              <td className={cell}>
                <button type="button" data-open-doc={item.id} className="font-semibold text-ink hover:text-blue">{item.number || item.id}</button>
              </td>
              <td className={wraps('max-w-[180px] truncate')}>
                {compact ? <span className={clamp} title={item.companyName || undefined}>{item.companyName || '—'}</span> : item.companyName || '—'}
              </td>
              <td className={cx(wraps('max-w-[260px] truncate'), 'text-steel')}>
                {compact ? <span className={clamp} title={itemText(item)}>{itemText(item)}</span> : itemText(item)}
              </td>
              <td className={cx(cell, 'text-right')}>{amountText(item.amount, item.currency)}</td>
              <td className={cell}>{advice ? <Pill tone={advice.tone} icon={advice.icon}>{advice.text}</Pill> : <span className="text-faint">—</span>}</td>
              <td className={cell}>
                {!review ? <span className="text-faint">—</span>
                  : review.pill ? <Pill tone={review.tone} icon={review.icon}>{review.text}</Pill>
                    : <span className="text-steel">{review.text}</span>}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
