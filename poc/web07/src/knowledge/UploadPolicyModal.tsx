/**
 * 「上传制度」弹框（Spec 第 6 节；补丁 0005；样稿 A 版的上传弹框）。知识库页和工作台都用它：要的数据（/mode、制度清单）自己读。
 * 拖入或选一份 .docx（20 MB 以内）→ 制度标识按文件名预填、文档名按 Ruling T6b 预填、版本说明 →「上传并入库」（POST 原文，202）→
 * 每 2.5 秒问一次上传记录，停在 ingested / skipped / failed 上，给出条数。进行中「上传并入库」不可点；关掉弹框不中断入库（状态留着，再打开还在）。
 * 只给管理员（外壳那头也只认管理员）。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import {
  DEFAULT_AGENT, DOCX, KB_POLL_MS, NOT_READY_CODES, POLICY_MAX_BYTES, SOURCE_ID, TITLE_MAX, VERSION_MAX, clipChars, fetchMode, fetchSources, fetchUpload,
  kbKeys, nameOf, prefillSourceId, prefillTitle, sizeText, thousands, uploadPolicy, type Agent, type KbUpload, type UploadInput,
} from '../api/knowledge';
import { useSessionQuery } from '../api/session';
import { Button } from '../ui/Button';
import { DropZone } from '../ui/DropZone';
import { Icon } from '../ui/icons';
import { Modal } from '../ui/Modal';
import { Pill } from '../ui/Pill';
import { cx } from '../ui/cx';
import { AgentNotice, messageOf, readyAgent } from './AgentNotice';

// 人改过的才存；没改过的标识、文档名随清单算（清单晚到也能按它预填）
interface Draft { file: File; sourceId: string | null; title: string | null; version: string }
const ID_RULE = '制度标识只能用小写字母、数字和连字符（2–63 位，字母或数字开头），例如 fin-approval。';
const inputClass = 'h-[30px] w-full rounded-ctl border border-line bg-surface px-[10px] text-13 text-ink hover:border-faint focus:border-blue disabled:opacity-55';

export function UploadPolicyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const session = useSessionQuery();
  const admin = session.data?.user.role === 'admin';
  const queryClient = useQueryClient();
  const mode = useQuery({ queryKey: kbKeys.mode, queryFn: fetchMode, enabled: open && admin, retry: false });
  const agent = readyAgent(mode);
  const sources = useQuery({ queryKey: kbKeys.sources, queryFn: () => fetchSources(agent ?? DEFAULT_AGENT), enabled: open && Boolean(agent), retry: false });
  const list = sources.data ?? [];

  const [draft, setDraft] = useState<Draft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [uploadId, setUploadId] = useState<number | null>(null);
  // 正在提交：按钮要等下一次渲染才变灰，连点两下的第二下在这里挡住
  const inFlight = useRef(false);
  const send = useMutation({
    mutationFn: (input: UploadInput) => uploadPolicy(input),
    onSuccess: ({ id }) => { setUploadId(id); void queryClient.invalidateQueries({ queryKey: kbKeys.uploads }); },
    onError: error => { if (error instanceof ApiError && NOT_READY_CODES.has(error.code)) void queryClient.invalidateQueries({ queryKey: kbKeys.mode }); },
    onSettled: () => { inFlight.current = false; },
  });
  // 弹框关着也接着问（组件一直挂着），停在结果上
  const record = useQuery({
    queryKey: kbKeys.upload(uploadId ?? 0), queryFn: () => fetchUpload(uploadId!), enabled: uploadId !== null,
    refetchInterval: query => (query.state.data && query.state.data.status !== 'ingesting') || (query.state.error instanceof ApiError && query.state.error.status === 404) ? false : KB_POLL_MS,
  });
  const settled = record.data && record.data.status !== 'ingesting' ? record.data : null;
  const settledStatus = settled?.status;
  useEffect(() => {
    if (!settledStatus) return;
    void queryClient.invalidateQueries({ queryKey: kbKeys.uploads });
    if (settledStatus !== 'failed') void queryClient.invalidateQueries({ queryKey: kbKeys.sources }, { cancelRefetch: false });
  }, [settledStatus, uploadId, queryClient]);

  // 失败了回到表单（改了标识可以再传）；成功或没有变化才是「完成」
  const phase = send.isPending ? 'sending' : uploadId !== null && !settled ? 'ingesting' : settled && settled.status !== 'failed' ? 'done' : draft ? 'form' : 'pick';
  const working = phase === 'sending' || phase === 'ingesting';
  const sourceId = draft ? draft.sourceId ?? prefillSourceId(draft.file.name, list) : '';
  const title = draft ? draft.title ?? prefillTitle(sourceId.trim(), draft.file.name, list) : '';
  const same = list.find(source => source.source_id === sourceId.trim());

  function reset() { setDraft(null); setProblem(null); setUploadId(null); send.reset(); }
  // 入库进行中关掉：什么都不动，服务端照样入库；再打开还看得到
  function close() { if (!working) reset(); onClose(); }
  function pick(file: File) {
    if (working) return;
    if (!/\.docx$/iu.test(file.name)) { setProblem('只收 .docx 文件（审批矩阵格式的 Word 文档）'); return; }
    if (file.size > POLICY_MAX_BYTES) { setProblem('文件超过 20 MB'); return; }
    setDraft({ file, sourceId: null, title: null, version: '' });
    setProblem(null);
    setUploadId(null);
    send.reset();
  }
  function submit() {
    if (inFlight.current || working || !draft) return;
    const input = { file: draft.file, sourceId: sourceId.trim(), sourceVersion: draft.version.trim(), title: title.trim() };
    if (!SOURCE_ID.test(input.sourceId)) { setProblem(ID_RULE); return; }
    inFlight.current = true;
    setProblem(null);
    setUploadId(null);
    send.mutate(input);
  }

  let body: ReactNode;
  if (session.isPending) body = <p role="status" className="m-0 text-13 text-steel">正在读取登录状态…</p>;
  else if (!admin) body = <Notice title="只有管理员能上传制度" text="需要上传制度请找管理员；你可以在知识库页看制度清单、检索。" />;
  else if (!agent) body = <AgentNotice mode={mode} admin />;
  else if (phase === 'pick') {
    body = (
      <>
        <p className="m-0 mb-3 text-13 text-steel">填好制度标识、文档名和版本说明后上传：{agent.lead}解析、给每条规则生成向量并写入规则库，写完在上传记录里看结果。同一个标识再上传就是新版本。</p>
        <DropZone lead="把制度 .docx 拖到这里，或" hint="审批矩阵格式：每章一张表，表头第一列是「序号」；20 MB 以内" accept={`.docx,${DOCX}`} inputLabel="选择制度文件" onPick={pick} />
      </>
    );
  } else if (draft && phase === 'done' && settled) {
    body = <Outcome file={draft.file} item={settled} />;
  } else if (draft) {
    body = (
      <>
        <FileLine file={draft.file} extra={working
          ? <Pill tone="wait" icon="refresh">{phase === 'sending' ? '上传中' : '入库中'}</Pill>
          : <Button size="sm" variant="ghost" onClick={() => { setDraft(null); setUploadId(null); send.reset(); }}>换一个文件</Button>} />
        {working ? <Working agent={agent} file={draft.file} sending={phase === 'sending'} error={record.isError ? messageOf(record.error) : null} /> : (
          <div className="mt-3 flex flex-col gap-3">
            <Field label="制度标识" hint="小写字母、数字和连字符；同一份制度用同一个标识，再上传就是新版本">
              <input aria-label="制度标识" className={inputClass} value={sourceId} placeholder="例如 fin-approval" autoComplete="off" spellCheck={false}
                onChange={event => setDraft({ ...draft, sourceId: event.target.value.slice(0, 63) })} />
            </Field>
            {same && (
              <p className="m-0 rounded-box border border-wait-200 bg-wait-50 px-3 py-2 text-13 text-wait-ink">
                规则库里已有「{nameOf(same)}」用这个标识（版本 {same.source_version || '—'}，{thousands(same.rules_total ?? 0)} 条规则）：这次上传会作为它的新版本，旧版本里有、新版本没有的规则会删掉。不是同一份制度就换一个标识。
              </p>
            )}
            <Field label="文档名">
              <input aria-label="文档名" className={inputClass} value={title} autoComplete="off" onChange={event => setDraft({ ...draft, title: clipChars(event.target.value, TITLE_MAX) })} />
            </Field>
            <Field label="版本说明">
              <input aria-label="版本说明" className={inputClass} value={draft.version} placeholder="例如 V4.0 正式签批版" autoComplete="off"
                onChange={event => setDraft({ ...draft, version: clipChars(event.target.value, VERSION_MAX) })} />
            </Field>
            {sources.isPending && <p className="m-0 text-12 text-steel">正在读取制度清单（约 10–20 秒）：读到后按清单预填标识和文档名。</p>}
            {sources.isError && <p className="m-0 text-12 text-wait-ink">制度清单没有读出来，没法提示标识是不是已经用过：{messageOf(sources.error)}</p>}
            {settled?.status === 'failed' && <Failure item={settled} />}
            {send.isError && <p role="alert" className="m-0 text-13 text-fail-ink">{messageOf(send.error)}</p>}
          </div>
        )}
      </>
    );
  }
  const problemLine = problem && <p role="alert" className="m-0 mt-2 text-13 text-fail-ink">{problem}</p>;

  const showForm = admin && agent && phase !== 'pick';
  const footer = !admin || !agent ? <Button onClick={close}>知道了</Button>
    : phase === 'pick' ? <Button onClick={close}>取消</Button>
      : phase === 'done' ? <><Button onClick={reset}>再传一份</Button><Button variant="primary" onClick={close}>完成</Button></>
        : <><Button onClick={close}>{working ? '稍后再看' : '取消'}</Button><Button variant="primary" icon="upload" busy={working} onClick={submit}>上传并入库</Button></>;

  return (
    <Modal open={open} onOpenChange={next => { if (!next) close(); }} title="上传制度" icon="upload" width={480}
      extra={agent && admin ? <Pill tone="pass">{agent.lead}就绪</Pill> : undefined} footer={footer}>
      <div className={cx('px-[18px] pb-2', showForm ? 'pt-3' : 'pt-4')}>{body}{problemLine}</div>
    </Modal>
  );
}

function Notice({ title, text }: { title: string; text: string }) {
  return (
    <div className="py-4 text-center">
      <p className="m-0 text-14 font-semibold">{title}</p>
      <p className="m-0 mt-1 text-13 text-steel">{text}</p>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-12 font-medium text-steel">{label}{hint && <span className="ml-2 font-normal text-faint">{hint}</span>}</span>
      {children}
    </div>
  );
}

function FileLine({ file, extra }: { file: File; extra?: ReactNode }) {
  return (
    <div className="flex items-center gap-[10px] border border-line bg-sunken px-3 py-[10px]">
      <span className="text-steel"><Icon name="file" /></span>
      <b className="min-w-0 flex-1 truncate font-semibold" title={file.name}>「{file.name}」（{sizeText(file.size)}）</b>
      {extra}
    </div>
  );
}

function Working({ agent, file, sending, error }: { agent: Agent; file: File; sending: boolean; error: string | null }) {
  return (
    <div role="status" className="mt-3 flex flex-col gap-2 text-13">
      <p className="m-0 text-ink">{sending ? `正在上传「${file.name}」…` : `正在入库：${agent.lead}解析、生成向量并写入规则库（规则多时要几分钟）。`}</p>
      <p className="m-0 text-steel">可以关掉这个弹框：入库在后台继续，稍后在上传记录里看结果。</p>
      {error && <p className="m-0 text-wait-ink">上传记录暂时没读到：{error}</p>}
    </div>
  );
}

function Numbers({ item }: { item: KbUpload }) {
  const cells: Array<[string, unknown]> = [['规则', item.rulesTotal], ['写入', item.written], ['删除', item.removed], ['不变', item.unchanged], ['冲突', item.conflicts?.length ?? 0]];
  return (
    <ul aria-label="入库结果" className="m-0 mt-3 grid list-none grid-cols-5 border border-line p-0">
      {cells.map(([label, value]) => (
        <li key={label} className="border-r border-line px-3 py-2 last:border-r-0">
          <span className="block text-12 text-steel">{label}</span>
          <b className="block text-16 font-semibold">{thousands(value)}</b>
        </li>
      ))}
    </ul>
  );
}

function Outcome({ file, item }: { file: File; item: KbUpload }) {
  const name = item.title || item.sourceId || file.name;
  const text = item.status === 'ingested'
    ? `入库完成：「${name}」共 ${item.rulesTotal ?? 0} 条规则（写入 ${item.written ?? 0}、删除 ${item.removed ?? 0}、不变 ${item.unchanged ?? 0}）。审核 Agent 下一次检索就用上新规则。`
    : `规则库里的「${name}」已经是这一版（共 ${item.rulesTotal ?? 0} 条规则），没有重写。`;
  return (
    <>
      <FileLine file={file} extra={<Pill tone={item.status === 'ingested' ? 'pass' : 'info'} icon={item.status === 'ingested' ? 'check' : null}>{item.status === 'ingested' ? '已入库' : '没有变化'}</Pill>} />
      <p role="status" className="m-0 mt-3 text-13 text-ink">{text}</p>
      <Numbers item={item} />
    </>
  );
}

function Failure({ item }: { item: KbUpload }) {
  const conflicts = Array.isArray(item.conflicts) ? item.conflicts : [];
  return (
    <div role="alert" className="flex flex-col gap-1 rounded-box border border-fail-200 bg-fail-50 px-3 py-2 text-13 text-fail-ink">
      <p className="m-0">没有入库：{item.error?.message || '知识库 Agent 没有完成这次入库'}</p>
      {conflicts.length > 0 && (
        <p className="m-0">冲突的规则编号 {conflicts.length} 条：{conflicts.slice(0, 12).join('、')}{conflicts.length > 12 ? '…' : ''}。若这是库里那份制度的新版本，用它原来的制度标识再上传。</p>
      )}
      {item.error?.suggestion && <p className="m-0">建议：{item.error.suggestion}</p>}
    </div>
  );
}
