/**
 * 抽屉的「单据信息」页签：九安 1:1 单据页（GET /documents/:id/page，值都已格式化好，照 document-page.js 的用法）的
 * 申请人与状态、单据字段、付款明细，以及汇联易里的实际审批流程（有就显示，Spec 第 9 节）。
 */
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { fetchPage, keys, type PageModel } from '../api/documents';
import { Button } from '../ui/Button';
import { Empty } from '../ui/Empty';
import { cx } from '../ui/cx';

const shown = (value: unknown) => (typeof value === 'string' && value.trim() ? value.trim() : '');
/** 「公司|部门」：部门路径通常已带公司名（同 document-page.js 的 applicantOrgText）。 */
function orgText(companyName?: string, departmentPath?: string) {
  const company = shown(companyName), path = shown(departmentPath);
  if (!path) return company;
  return !company || path === company || path.startsWith(`${company}|`) ? path : `${company}|${path}`;
}
/** 值旁边的编码照原单的写法：「名称-1000」「CNY 人民币」「名称 (编码)」。 */
function fieldValue(field: NonNullable<PageModel['infoFields']>[number]) {
  if (!field.code) return field.value;
  if (field.codeStyle === 'suffix') return `${field.value}-${field.code}`;
  if (field.codeStyle === 'prefix') return `${field.code} ${field.value}`;
  return `${field.value} (${field.code})`;
}
const TONE_DOT: Record<string, string> = { pending: 'border-wait bg-wait-50', reject: 'border-fail bg-fail', withdraw: 'border-faint bg-faint', pass: 'border-pass bg-pass' };

export function DetailTab({ id }: { id: string }) {
  const page = useQuery({ queryKey: keys.page(id), queryFn: () => fetchPage(id) });
  if (page.isPending) return <Pad><p role="status" className="m-0 text-13 text-steel">正在读取单据页…</p></Pad>;
  if (page.isError) {
    return <Pad><p role="alert" className="m-0 text-13 text-fail-ink">{page.error.message}</p><Button size="sm" icon="refresh" className="mt-2" onClick={() => void page.refetch()}>重新读取</Button></Pad>;
  }
  const model = page.data;
  if (model.supported !== true) {
    return <Empty title="这类单据还没有 1:1 单据页" description="单据页目前只接入对公付款单；这张单请在九安原来的页面里查看。"
      action={<a href="/analysis.html" className="inline-flex h-[30px] items-center rounded-ctl border border-line px-3 text-13 font-semibold text-ink hover:bg-canvas">打开九安原来的页面</a>} />;
  }
  const { header = {}, applicant = {}, status = {}, amounts = {} } = model;
  const person = [shown(applicant.name), shown(applicant.employeeId)].filter(Boolean).join(' · ');
  const state = [shown(status.label), shown(status.currentNodeName)].filter(Boolean).join(' · ');
  const basics: Array<[string, string]> = ([
    ['表单', shown(header.formName)], ['单号', shown(header.businessCode)], [shown(header.dateLabel).replace(/[：:]$/, '') || '日期', shown(header.date)],
    ['制单人', shown(header.creatorName)], ['申请人', person], ['部门', orgText(applicant.companyName, applicant.departmentPath)],
    ['单据状态', state], ['支付金额', shown(amounts.payment)], ['到票金额', shown(amounts.withReceipt)],
  ] as Array<[string, string]>).filter(([, value]) => value);
  const fields = Array.isArray(model.infoFields) ? model.infoFields.filter(field => shown(field.label) && shown(field.value)) : [];
  const rows = Array.isArray(model.payment?.rows) ? model.payment.rows : [];
  const flow = Array.isArray(model.timeline?.items) ? model.timeline.items : [];
  return (
    <Pad>
      <Section title="基本信息" note={model.dataAsOf ? `数据截至 ${model.dataAsOf}` : undefined}><Pairs pairs={basics} /></Section>
      <Section title="单据字段">
        {fields.length ? <Pairs pairs={fields.map(field => [field.label, fieldValue(field)])} /> : <p className="m-0 text-13 text-steel">这张单没有可显示的单据字段。</p>}
      </Section>
      <Section title="付款明细" note={model.payment?.paymentTotal ? `支付总金额 ${model.payment.paymentTotal.replace(/^[A-Z]{3} /u, '')}` : undefined}>
        {rows.length ? (
          <ul aria-label="付款明细" className="m-0 list-none p-0">
            {rows.map((row, index) => (
              <li key={index} className="border-t border-line py-2 first:border-t-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-12 text-faint">{row.no ?? index + 1}</span>
                  <b className="min-w-0 flex-1 font-semibold">{shown(row.expense?.typeName) || shown(row.type) || '其他'}</b>
                  <span>{shown(row.expense?.amount) || '-'}</span>
                </div>
                {(shown(row.type) || shown(row.expense?.code)) && (
                  <div className="text-12 text-steel">{[shown(row.type), shown(row.expense?.code) && `编号 ${shown(row.expense?.code)}`].filter(Boolean).join(' · ')}</div>
                )}
                {shown(row.expense?.comment) && <div className="text-13 text-steel">事由：{shown(row.expense?.comment)}</div>}
              </li>
            ))}
          </ul>
        ) : <p className="m-0 text-13 text-steel">这张单没有付款明细。</p>}
      </Section>
      <Section title="审批流程" note="汇联易里的实际流程">
        {flow.length ? (
          <ol aria-label="审批流程" className="m-0 list-none p-0">
            {flow.map((item, index) => (
              <li key={index} data-tone={item.tone ?? 'pass'} className="relative flex gap-[10px] pb-3 last:pb-0">
                <span aria-hidden="true" className={cx('mt-[5px] h-[9px] w-[9px] shrink-0 border', TONE_DOT[item.tone ?? 'pass'] ?? TONE_DOT.pass)} />
                <div className="min-w-0 flex-1 text-13">
                  <div className="flex flex-wrap items-baseline gap-x-2">
                    <b className={cx('font-semibold', item.tone === 'reject' && 'text-fail-ink')}>{shown(item.action) || '其他操作'}</b>
                    {shown(item.nodeName) && <span className="text-steel">{item.nodeName}</span>}
                    {item.at && <span className="ml-auto text-12 text-faint">{item.at}</span>}
                  </div>
                  {(shown(item.personName) || shown(item.employeeId)) && (
                    <div className="text-steel">{[shown(item.personName) || (item.tone === 'pending' ? '平台未能读取当前审批人' : ''), shown(item.employeeId)].filter(Boolean).join(' ')}</div>
                  )}
                  {shown(item.note) && <div className="text-steel">{item.tone === 'reject' ? `意见「${item.note}」` : `意见：${item.note}`}</div>}
                </div>
              </li>
            ))}
          </ol>
        ) : <p className="m-0 text-13 text-steel">汇联易没有返回审批流程。</p>}
      </Section>
    </Pad>
  );
}

const Pad = ({ children }: { children: ReactNode }) => <div className="px-[18px] py-[14px]">{children}</div>;

function Section({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="mt-4 first:mt-0">
      <h3 className="m-0 mb-2 flex items-baseline gap-2 text-13 font-semibold">{title}{note && <span className="text-12 font-normal text-steel">{note}</span>}</h3>
      {children}
    </section>
  );
}

function Pairs({ pairs }: { pairs: Array<[string, string]> }) {
  return (
    <dl className="m-0 grid grid-cols-[84px_1fr] gap-x-[10px] gap-y-[6px] text-13">
      {pairs.map(([label, value], index) => (
        <div key={index} className="contents">
          <dt className="text-steel">{label}</dt>
          <dd className="m-0 min-w-0 break-words">{value}</dd>
        </div>
      ))}
    </dl>
  );
}
