/**
 * 我的规则（Spec 第 6 节；补丁 0005 的「我的规则」）：管理员、分析员各自的附加审核要求，存在测试台本机。
 * 「已用 N / 5,000 字」和份数随列表更新；上传 .md / .docx（拖入或选择）→ 弹框给出转出来的文字核对；查看全文（弹框）；删除（先确认）。
 * 限额（10 份、2 MB、合计 5,000 字）由外壳核对，超了照它的中文提示显示。一次一个请求：上传、删除进行中「选择文件」和每行的按钮都不可用。
 */
import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { timeText } from '../api/documents';
import { DOCX, thousands } from '../api/knowledge';
import { RULE_FILE, RULE_MAX_BYTES, deleteRule, fetchRules, rulesKeys, uploadRule, type OwnRule, type OwnRuleText } from '../api/myRules';
import { messageOf } from '../knowledge/AgentNotice';
import { CheckModal, DeleteModal, ViewModal } from '../myRules/RuleModals';
import { PageHeader } from '../shell/PageHeader';
import { Button } from '../ui/Button';
import { DropZone } from '../ui/DropZone';
import { Empty } from '../ui/Empty';
import { Panel } from '../ui/Panel';
import { cx } from '../ui/cx';

type Line = { text: string; ok: boolean };

export function MyRules() {
  const queryClient = useQueryClient();
  const list = useQuery({ queryKey: rulesKeys.list, queryFn: fetchRules });
  const [line, setLine] = useState<Line | null>(null);
  const [checking, setChecking] = useState<OwnRuleText | null>(null);
  const [viewing, setViewing] = useState<OwnRule | null>(null);
  const [deleting, setDeleting] = useState<OwnRule | null>(null);
  // 一次一个请求：按钮要等下一次渲染才变灰，这里先挡住
  const inFlight = useRef(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: rulesKeys.list });

  const upload = useMutation({
    mutationFn: (file: File) => uploadRule(file),
    onSuccess: rule => setChecking(rule),
    onError: error => setLine({ text: messageOf(error), ok: false }),
    onSettled: () => { inFlight.current = false; void refresh(); },
  });
  const remove = useMutation({
    mutationFn: (rule: OwnRule) => deleteRule(rule.id),
    onSuccess: (_data, rule) => {
      setLine({ text: `已删除「${rule.title}」。`, ok: true });
      setChecking(current => (current?.id === rule.id ? null : current));
      setViewing(current => (current?.id === rule.id ? null : current));
    },
    onError: error => setLine({ text: messageOf(error), ok: false }),
    onSettled: () => { inFlight.current = false; void refresh(); },
  });
  const busy = upload.isPending || remove.isPending;

  function pick(file: File) {
    if (inFlight.current || busy) return;
    if (!RULE_FILE.test(file.name)) { setLine({ text: '只收 Markdown（.md）或 Word（.docx）文件。', ok: false }); return; }
    if (file.size > RULE_MAX_BYTES) { setLine({ text: '文件超过 2 MB。', ok: false }); return; }
    inFlight.current = true;
    setLine(null);
    upload.mutate(file);
  }
  function confirmDelete(rule: OwnRule) {
    setDeleting(null);
    if (inFlight.current || busy) return;
    inFlight.current = true;
    setLine(null);
    remove.mutate(rule);
  }

  const data = list.data;
  const used = data?.usedChars ?? 0, limit = data?.limitChars ?? 5000;
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  const status = upload.isPending ? `正在上传「${upload.variables?.name ?? ''}」并转成文字…` : remove.isPending ? `正在删除「${remove.variables?.title ?? ''}」…` : null;
  const head = 'whitespace-nowrap border-b border-line px-3 py-[9px] text-left text-12 font-medium text-steel';
  const cell = 'whitespace-nowrap border-b border-line px-3 py-[11px]';

  return (
    <>
      <PageHeader title="我的规则" note="只有你自己看得到" />
      <p className="m-0 mt-2 max-w-[880px] text-13 text-steel">
        你自己的附加审核要求：只在你在单据抽屉里手动发起 AI 审核（「发起审核」「重新审核」）时随请求带上，AI 把它和公司制度一起核对，只会让结论更严、不会放宽；自动初审不带。
      </p>

      <Panel className="mt-[14px] p-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <b className="text-16 font-semibold">{data ? `已用 ${thousands(used)} / ${thousands(limit)} 字` : `已用 — / ${thousands(limit)} 字`}</b>
          {data && <span className="text-13 text-steel">{`${data.items.length} / ${data.limitFiles} 份`}</span>}
          <span className="ml-auto text-12 text-faint">合计 5,000 字以内，一轮 AI 审核才能在时限内跑完</span>
        </div>
        <div role="meter" aria-label="已用字数" aria-valuemin={0} aria-valuemax={limit} aria-valuenow={used} aria-valuetext={`已用 ${thousands(used)} / ${thousands(limit)} 字`}
          className="mt-2 h-1 bg-track">
          <span className={cx('block h-full', percent >= 90 ? 'bg-wait' : 'bg-own')} style={{ width: `${percent}%` }} />
        </div>
        <div className="mt-4">
          <DropZone lead="把规则文件拖到这里，或" hint="Markdown（.md）或 Word（.docx）；单个文件 2 MB 以内，每人最多 10 份、合计 5,000 字"
            accept={`.md,.docx,text/markdown,${DOCX}`} inputLabel="选择规则文件" onPick={pick} disabled={busy} />
        </div>
        {status ? <p role="status" className="m-0 mt-2 text-13 text-steel">{status}</p>
          : line && <p role={line.ok ? 'status' : 'alert'} className={cx('m-0 mt-2 text-13', line.ok ? 'text-pass-ink' : 'text-fail-ink')}>{line.text}</p>}
      </Panel>

      <Panel title="规则清单" className="mt-[14px]" extra={data ? <span>{data.items.length} 份</span> : undefined}>
        {list.isPending ? <p role="status" className="m-0 px-4 py-10 text-center text-13 text-steel">正在读取我的规则…</p>
          : list.isError && !data ? (
            <Empty icon="warning" title="我的规则没有读出来" description={messageOf(list.error)} action={<Button icon="refresh" onClick={() => void list.refetch()}>重新读取</Button>} />
          ) : !data?.items.length ? (
            <Empty icon="myRules" title="还没有上传规则" description="把 .md 或 .docx 拖到上面，或点「选择文件」；上传后会显示转出来的文字给你核对。" />
          ) : (
            <table aria-label="我的规则" className="w-full border-collapse">
              <thead>
                <tr>
                  <th scope="col" className={head}>标题</th>
                  <th scope="col" className={cx(head, 'text-right')}>字数</th>
                  <th scope="col" className={head}>上传时间</th>
                  <th scope="col" className={head}>操作</th>
                </tr>
              </thead>
              <tbody>
                {data.items.map(rule => (
                  <tr key={rule.id} data-title={rule.title} className="hover:bg-canvas">
                    <td className={cx(cell, 'max-w-[420px] truncate font-semibold')} title={rule.title}>{rule.title}</td>
                    <td className={cx(cell, 'text-right')}>{thousands(rule.chars)}</td>
                    <td className={cx(cell, 'text-steel')}>{timeText(rule.uploadedAt)}</td>
                    <td className={cell}>
                      <div className="flex gap-[6px]">
                        <Button size="sm" disabled={busy} onClick={() => setViewing(rule)}>查看全文</Button>
                        <Button size="sm" variant="danger" disabled={busy} onClick={() => setDeleting(rule)}>删除</Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
      </Panel>

      <CheckModal rule={checking} onClose={() => setChecking(null)} onDelete={rule => { setChecking(null); setDeleting(rule); }} />
      <ViewModal rule={viewing} onClose={() => setViewing(null)} />
      <DeleteModal rule={deleting} busy={busy} onClose={() => setDeleting(null)} onConfirm={confirmDelete} />
    </>
  );
}
