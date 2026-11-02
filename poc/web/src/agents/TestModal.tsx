/**
 * 「测试」弹框（补丁 0002 的 testForm；Ruling T8d）。三种测法，请求体照外壳 agent-tests.mjs：
 *   单据      {mode:'document', documentId}：/test-documents 里的一张对公付款单，照九安自动初审的做法组装 review_advice@1 发给它
 *   文本      {mode:'text', text}：一段话原样发过去（4000 字以内，可以用示例）
 *   请求信封  {mode:'envelope', request}：/test-templates 的示例请求，可以改；这里先认 JSON，契约由外壳查，查不过的地方原样列出
 * 外壳先回 202 和这次测试；之后每 3 秒问一次 /tests/:id，停在结果上（最多等 5 分钟），结果出来时调用记录跟着刷新。
 * 状态放在弹框外层（页面一直挂着这个组件）：关掉弹框测试照常进行、照常轮询，再打开同一个 Agent 还看得到；换一个 Agent 页面换 key，从头开始。
 * 审批 Agent 默认「单据」，别的默认「文本」（例如知识库 Agent，它不审单）。测试只记进调用记录，不改单据上的 AI 建议。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError } from '../api/client';
import {
  TEST_POLL_MS, TEST_WAIT_MS, TEXT_MAX, agentKeys, fetchTest, fetchTestDocuments, fetchTestTemplates, startTest,
  type AgentRow, type CallRow, type Problem, type TestInput, type TestMode,
} from '../api/agents';
import { charCount, clipChars, thousands } from '../api/knowledge';
import { messageOf } from '../knowledge/AgentNotice';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { Tabs } from '../ui/Tabs';
import { CallFeedback, MONO } from './CallFeedback';
import { inputClass } from './KeyModal';
import { problemText } from './labels';

export const SAMPLE_TEXT = '你好，请用一句话说明你能做什么';
const pretty = (value: unknown) => (value === undefined ? '' : JSON.stringify(value, null, 2));
const areaClass = 'w-full resize-y rounded-ctl border border-line bg-surface px-[10px] py-[6px] text-13 text-ink hover:border-faint focus:border-blue disabled:opacity-55';
// 4xx：这次测试找不到了（外壳重启会清空），再问也一样
const final = (error: unknown) => error instanceof ApiError && error.status >= 400 && error.status < 500;

export function TestModal({ agent, open, isApproval, onClose }: { agent: AgentRow; open: boolean; isApproval: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<TestMode>(isApproval ? 'document' : 'text');
  const [documentId, setDocumentId] = useState('');
  const [text, setText] = useState('');
  const [task, setTask] = useState('');
  const [envelope, setEnvelope] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [testId, setTestId] = useState<string | null>(null);
  // 等够 5 分钟的那次测试（计时器到点时记下）。不能在渲染时拿 Date.now() 算：一直「进行中」时每次问到的结果都一样，
  // 结构共享让 data 不变，最后一次问完也不会重新渲染，页面就一直说「一般几秒到两分钟」
  const [expired, setExpired] = useState<string | null>(null);
  const since = useRef(0);
  const inFlight = useRef(false);

  const documents = useQuery({ queryKey: agentKeys.documents, queryFn: fetchTestDocuments, enabled: open && mode === 'document' });
  const templates = useQuery({ queryKey: agentKeys.templates, queryFn: fetchTestTemplates, enabled: open && mode === 'envelope' });
  const start = useMutation({
    mutationFn: (input: TestInput) => startTest(agent.publishId, input),
    onSuccess: data => {
      if (typeof data?.testId !== 'string') { setProblem('测试台没有给出这次测试的编号，请刷新页面重试。'); return; }
      since.current = Date.now();
      queryClient.setQueryData(agentKeys.test(data.testId), data);
      setTestId(data.testId);
    },
    onSettled: () => { inFlight.current = false; },
  });
  const run = useQuery({
    queryKey: agentKeys.test(testId ?? ''), queryFn: () => fetchTest(testId!), enabled: Boolean(testId),
    refetchInterval: query => (query.state.data?.status === 'running' && !final(query.state.error) && expired !== testId ? TEST_POLL_MS : false),
  });
  const current = testId ? run.data ?? null : null;
  const settled = current && current.status !== 'running' ? current : null;
  const gone = Boolean(testId) && !settled && final(run.error);
  const timedOut = Boolean(testId) && expired === testId && !settled && !gone;
  const running = start.isPending || (Boolean(testId) && !settled && !gone && !timedOut);
  // 有了结果，调用记录里就多了这一轮
  const settledKey = settled ? `${settled.testId}:${settled.status}` : null;
  useEffect(() => { if (settledKey) void queryClient.invalidateQueries({ queryKey: agentKeys.calls }); }, [settledKey, queryClient]);
  // 开始后 5 分钟还没结果：停止轮询，说一声，按钮放开
  useEffect(() => {
    if (!testId || settledKey || gone) return;
    const timer = setTimeout(() => setExpired(testId), Math.max(0, since.current + TEST_WAIT_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [testId, settledKey, gone]);

  function refuse(text: string) { setProblem(text); start.reset(); }
  function send(input: TestInput) {
    if (inFlight.current || running) return;
    inFlight.current = true;
    setProblem(null);
    setTestId(null);
    start.mutate(input);
  }

  const docs = documents.data ?? [];
  const pickedId = documentId || docs[0]?.id || '';
  const list = templates.data ?? [];
  const chosen = list.find(item => item.task === task) ?? list[0] ?? null;
  const envelopeText = envelope ?? pretty(chosen?.request);

  const forms: Record<TestMode, ReactNode> = {
    document: (
      <Form hint="选一张对公付款单，照九安自动初审的做法（先读原件）组装一份单据审核建议的请求发给它。结果只记进调用记录，不改单据上的 AI 建议。">
        <Field label="对公付款单" id={`test-doc-${agent.publishId}`}>
          <select id={`test-doc-${agent.publishId}`} className={inputClass} value={pickedId} disabled={running || !docs.length} onChange={event => setDocumentId(event.target.value)}>
            {documents.isPending ? <option value="">正在读取单据…</option> : docs.map(item => (
              <option key={item.id} value={item.id}>{[item.number, item.title || item.formName].filter(Boolean).join(' · ') || item.id}</option>
            ))}
          </select>
        </Field>
        {documents.isError && <p className="m-0 text-13 text-fail-ink">{messageOf(documents.error)}</p>}
        {documents.isSuccess && !docs.length && <p className="m-0 text-13 text-steel">单据池里还没有对公付款单：先在九安同步单据，再来测。</p>}
        <Actions><Button variant="primary" busy={running} onClick={() => (pickedId ? send({ mode: 'document', documentId: pickedId }) : refuse('请先选一张对公付款单'))}>开始测试</Button></Actions>
      </Form>
    ),
    text: (
      <Form hint="把这段话原样发给 Agent，看它怎么回。">
        <Field label="发给 Agent 的文字" id={`test-text-${agent.publishId}`} extra={`${thousands(charCount(text))} / ${thousands(TEXT_MAX)} 字`}>
          <textarea id={`test-text-${agent.publishId}`} rows={4} className={areaClass} value={text} placeholder={`例如：${SAMPLE_TEXT}`} disabled={running}
            onChange={event => setText(clipChars(event.target.value, TEXT_MAX))} />
        </Field>
        <Actions>
          <Button variant="primary" busy={running} onClick={() => (text.trim() ? send({ mode: 'text', text: text.trim() }) : refuse('请写一段话'))}>发送</Button>
          <Button disabled={running} onClick={() => setText(SAMPLE_TEXT)}>用示例</Button>
        </Actions>
      </Form>
    ),
    envelope: (
      <Form hint="选一个任务，页面按九安的契约填好示例请求，可以改。发出去和九安一样：一行说明加上请求信封；回答按契约判合格或不合格，原始回答也留着。">
        <Field label="任务" id={`test-task-${agent.publishId}`}>
          <select id={`test-task-${agent.publishId}`} className={inputClass} value={chosen?.task ?? ''} disabled={running || !list.length}
            onChange={event => { setTask(event.target.value); setEnvelope(null); }}>
            {templates.isPending ? <option value="">正在读取契约里的任务…</option> : list.map(item => <option key={item.task} value={item.task}>{`${item.title || item.task}（${item.task}）`}</option>)}
          </select>
        </Field>
        {templates.isError && <p className="m-0 text-13 text-fail-ink">{messageOf(templates.error)}</p>}
        <Field label="请求信封（JSON）" id={`test-envelope-${agent.publishId}`}>
          <textarea id={`test-envelope-${agent.publishId}`} rows={12} spellCheck={false} className={areaClass} style={MONO} value={envelopeText} disabled={running || !chosen}
            onChange={event => setEnvelope(event.target.value)} />
        </Field>
        <Actions>
          <Button variant="primary" busy={running} onClick={() => {
            let request: unknown;
            try { request = JSON.parse(envelopeText); } catch { refuse('不是合法的 JSON：请检查括号、引号和逗号。'); return; }
            if (!request || typeof request !== 'object' || Array.isArray(request)) { refuse('请求信封要是一个 JSON 对象（{ … }）。'); return; }
            send({ mode: 'envelope', request: request as Record<string, unknown> });
          }}>发送</Button>
          <Button disabled={running || !chosen} onClick={() => setEnvelope(null)}>恢复示例</Button>
        </Actions>
      </Form>
    ),
  };

  const status = running ? `已发给「${agent.name}」，一般几秒到两分钟…`
    : timedOut ? '等了五分钟还没有结果：测试还在 Agent 那边跑，结果出来后会记进下面的调用记录。'
      : settled ? (settled.status === 'failed' ? '这次没有完成，原因见下。' : '测试完成，已记进下面的调用记录。') : null;
  return (
    <Modal open={open} onOpenChange={next => { if (!next) onClose(); }} title={`测试「${agent.name}」`} icon="agent" width={640}>
      <Tabs label="测法" value={mode} onValueChange={value => { setMode(value as TestMode); setProblem(null); }} className="pt-1"
        items={[{ value: 'document', label: '单据', content: forms.document }, { value: 'text', label: '文本', content: forms.text }, { value: 'envelope', label: '请求信封', content: forms.envelope }]} />
      <div className="flex flex-col gap-2 px-[18px] pb-4">
        {problem ? <p role="alert" className="m-0 text-13 text-fail-ink">{problem}</p>
          : start.isError ? <StartError error={start.error} />
            : gone ? <p role="alert" className="m-0 text-13 text-fail-ink">这次测试的结果读不到了：{messageOf(run.error)}结果出来后会记进下面的调用记录。</p> : null}
        {status && <p role="status" className="m-0 text-13 text-steel">{status}</p>}
        {settled && (
          <section aria-label="测试结果" className="mt-1 border-t border-line pt-3">
            <CallFeedback call={settled as CallRow} nameOf={() => agent.name} />
          </section>
        )}
      </div>
    </Modal>
  );
}

function StartError({ error }: { error: Error }) {
  const details = error instanceof ApiError && error.details && typeof error.details === 'object' ? error.details as { problems?: unknown } : null;
  const problems = Array.isArray(details?.problems) ? (details.problems as Problem[]).filter(item => item && typeof item === 'object') : [];
  return (
    <div role="alert" className="text-13 text-fail-ink">
      <p className="m-0">{messageOf(error)}</p>
      {problems.length > 0 && <ul className="m-0 mt-1 list-disc pl-5">{problems.map((item, index) => <li key={index}>{problemText(item)}</li>)}</ul>}
    </div>
  );
}

const Form = ({ hint, children }: { hint: string; children: ReactNode }) => (
  <div className="flex flex-col gap-3 px-[18px] pb-3 pt-3"><p className="m-0 text-13 text-steel">{hint}</p>{children}</div>
);
const Actions = ({ children }: { children: ReactNode }) => <div className="flex flex-wrap items-center gap-2">{children}</div>;
function Field({ label, id, extra, children }: { label: string; id: string; extra?: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="flex text-12 font-medium text-steel"><label htmlFor={id}>{label}</label>{extra && <span className="ml-auto font-normal text-faint">{extra}</span>}</span>
      {children}
    </div>
  );
}
