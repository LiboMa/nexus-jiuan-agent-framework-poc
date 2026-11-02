/**
 * 工作台（Spec 第 6 节；样稿 dashboard-a-v9.html）：登录后的首页。一次读 /poc/dashboard?window=…（默认近 14 天，Ruling T7b），
 * 右上「今天 / 近 14 天 / 本月」每换一次重读；换窗口时上一份数留着、变淡，不闪空。
 * 上排四个数；中间每天的 AI 建议、不通过最常见的依据；人工改判率、按审核员；底排知识库、最常引用的规则、我的规则。
 * 「上传制度」只给管理员（知识库暂时只给管理员，Ruling T7a）：用知识库页的同一个弹框；关弹框时还在入库，就在这里提示去知识库页看结果。
 * 那句提示放在一直挂着的空播报区（role="status"）里、后填进去：带着字一起插进页面的播报区，有的读屏不念。
 */
import { useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { DEFAULT_WINDOW, WINDOW_OPTIONS, dashboardKeys, fetchDashboard, windowLabel, type DashboardWindow } from '../api/dashboard';
import { useSession } from '../api/session';
import { DailyAdviceChart } from '../dashboard/DailyAdviceChart';
import { KnowledgeCard } from '../dashboard/KnowledgeCard';
import { MyRulesCard } from '../dashboard/MyRulesCard';
import { OverrideRateChart } from '../dashboard/OverrideRateChart';
import { Reviewers } from '../dashboard/Reviewers';
import { StatTiles } from '../dashboard/StatTiles';
import { TopBasis } from '../dashboard/TopBasis';
import { TopRules } from '../dashboard/TopRules';
import { todayText } from '../dashboard/format';
import { messageOf } from '../knowledge/AgentNotice';
import { UploadPolicyModal } from '../knowledge/UploadPolicyModal';
import { PageHeader } from '../shell/PageHeader';
import { Button } from '../ui/Button';
import { Empty } from '../ui/Empty';
import { Icon } from '../ui/icons';
import { Panel } from '../ui/Panel';
import { Segmented } from '../ui/Segmented';
import { cx } from '../ui/cx';

export function Dashboard() {
  const session = useSession();
  const role = session?.user.role;
  const admin = role === 'admin';
  const [range, setRange] = useState<DashboardWindow>(DEFAULT_WINDOW);
  const [uploading, setUploading] = useState(false);
  const [ingestNotice, setIngestNotice] = useState(false);
  const query = useQuery({ queryKey: dashboardKeys.window(range), queryFn: () => fetchDashboard(range), placeholderData: keepPreviousData });
  const data = query.data;
  const busy = query.isPlaceholderData;
  const rangeText = windowLabel(range);

  let body;
  if (data) {
    body = (
      <div data-testid="dashboard-content" aria-busy={busy} className={cx(busy && 'opacity-60')}>
        <StatTiles data={data} role={role} />
        <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1.55fr)_minmax(0,1fr)]">
          <DailyAdviceChart daily={data.daily} />
          <TopBasis items={data.topBasis} fail={data.advice.fail} />
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
          <OverrideRateChart days={data.overrideRate} />
          <Reviewers rows={data.reviewers} me={session?.user.id} role={role} windowText={rangeText} />
        </div>
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-3">
          <KnowledgeCard knowledge={data.knowledge} admin={admin} />
          <TopRules items={data.topRules} windowText={rangeText} />
          <MyRulesCard mine={data.myRules} role={role} />
        </div>
      </div>
    );
  } else if (query.isError) {
    body = (
      <Panel className="mt-4">
        <Empty icon="warning" title="工作台的数没有读出来" description={messageOf(query.error)}
          action={<Button icon="refresh" busy={query.isFetching} onClick={() => void query.refetch()}>重试</Button>} />
      </Panel>
    );
  } else {
    body = <p role="status" className="m-0 mt-4 text-13 text-steel">正在读取工作台的数…</p>;
  }

  return (
    <>
      <PageHeader
        title="工作台"
        note={todayText(Date.now())}
        actions={<>
          <Segmented label="统计范围" options={WINDOW_OPTIONS} value={range} onChange={setRange} />
          {admin && <Button variant="primary" icon="upload" onClick={() => setUploading(true)}>上传制度</Button>}
        </>}
      />
      <div role="status" data-notice="">
        {ingestNotice && (
          <div className="mt-3 flex items-center gap-3 rounded-box border border-blue-200 bg-blue-50 px-4 py-[10px] text-13 text-ink">
            <span className="text-blue"><Icon name="refresh" size={16} /></span>
            <span>入库在后台继续，稍后在知识库页的上传记录里看结果</span>
            <a href="#/knowledge" className="whitespace-nowrap font-semibold text-blue hover:underline">打开知识库</a>
            <button type="button" aria-label="关掉提示" onClick={() => setIngestNotice(false)}
              className="ml-auto grid h-[26px] w-[26px] shrink-0 place-items-center rounded-ctl text-steel hover:bg-surface hover:text-ink">
              <Icon name="close" size={16} />
            </button>
          </div>
        )}
      </div>
      {body}
      {admin && <UploadPolicyModal open={uploading} onClose={result => { setUploading(false); if (result?.ingesting) setIngestNotice(true); }} />}
    </>
  );
}
