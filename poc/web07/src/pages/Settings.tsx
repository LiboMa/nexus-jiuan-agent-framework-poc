import { PageHeader } from '../shell/PageHeader';
import { Panel } from '../ui/Panel';
import { Icon } from '../ui/icons';

// 设置第一期（Spec 第 6 节、第 9 节）：九安原来的后台页面在 /analysis.html 一直保留，这里只放入口；第二期再搬过来。
const LINKS = [
  { href: '/analysis.html#adminConfig', title: '打开九安原来的后台配置', note: '数据同步、连接器、中间件、审计和数据等配置。' },
  { href: '/analysis.html#platform', title: '打开九安原来的平台总览', note: '平台概况、Agent 中心、运行日程，以及暂停 / 运行。' },
];

export function Settings() {
  return (
    <>
      <PageHeader title="设置" />
      <Panel title="九安原来的后台" extra="第二期搬到新前端" className="mt-[14px]">
        <ul className="m-0 list-none p-0">
          {LINKS.map(link => (
            <li key={link.href} className="border-t border-line first:border-t-0">
              <a href={link.href} className="flex items-center gap-3 px-4 py-3 text-ink hover:bg-canvas">
                <span className="min-w-0 flex-1">
                  <span className="block font-semibold text-blue">{link.title}</span>
                  <span className="block text-12 text-steel">{link.note}</span>
                </span>
                <Icon name="chevronRight" size={16} className="text-faint" />
              </a>
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}
