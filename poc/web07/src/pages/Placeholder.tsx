import { PageHeader } from '../shell/PageHeader';
import { NAV_ITEMS, type PageKey } from '../shell/nav';
import { Panel } from '../ui/Panel';
import { Empty } from '../ui/Empty';

// 后面几个任务会把这些页面换成真的；先占位，说清这一页将来放什么、现在去哪里操作。
const WHAT: Record<Exclude<PageKey, 'settings'>, string> = {
  dashboard: '待我复核、AI 已出建议、建议通过率、出建议用时和每天的趋势会放在这里',
  documents: '待复核、已复核和全部单据，以及右侧的单据详情与复核会放在这里',
  knowledge: '制度清单、上传制度和检索会放在这里',
  myRules: '上传、查看和删除你自己的审核规则会放在这里',
  agents: '连接 Nexus、发布清单、调用密钥、审批 Agent 和测试会放在这里',
};

export function Placeholder({ page }: { page: Exclude<PageKey, 'settings'> }) {
  return (
    <>
      <PageHeader title={NAV_ITEMS[page].label} />
      <Panel className="mt-[14px]">
        <Empty
          icon={NAV_ITEMS[page].icon}
          title="这一页正在搬到新前端"
          description={`${WHAT[page]}。搬好之前，请先在九安原来的页面里操作。`}
          action={<a href="/analysis.html" className="inline-flex h-[30px] items-center rounded-ctl border border-line px-3 text-13 font-semibold text-ink hover:bg-canvas">打开九安原来的页面</a>}
        />
      </Panel>
    </>
  );
}
