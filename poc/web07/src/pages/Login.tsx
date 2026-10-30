/**
 * 登录页（新前端自己画）：账号 + 口令 → POST /poc/login 拿一次性票据 → POST /auth/exchange 换会话 → 回到原来的位置或工作台。
 * 会话过期、旧入口的票据失效时，顶上照原样说明。
 */
import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router';
import { ApiError } from '../api/client';
import { login, useLoginNotice, useSessionQuery } from '../api/session';
import { Button } from '../ui/Button';
import { Icon } from '../ui/icons';
import { Logo } from '../ui/Logo';

// 测试台的两个虚构账号（与 poc/app07/public/login.html 相同）。
export const BENCH_ACCOUNTS = [
  { value: 'poc-reviewer', label: '审核员（虚构）· 管理员' },
  { value: 'poc-checker', label: '复核人（虚构）· 分析员' },
];

function safeFrom(state: unknown): string {
  const from = (state as { from?: unknown } | null)?.from;
  return typeof from === 'string' && from.startsWith('/') && !from.startsWith('//') && !from.startsWith('/login') ? from : '/';
}

const field = 'h-[34px] w-full rounded-ctl border border-line bg-surface px-[10px] text-13 text-ink hover:border-faint focus:border-blue';

export function Login() {
  const location = useLocation();
  const session = useSessionQuery().data;
  const notice = useLoginNotice();
  const [account, setAccount] = useState(BENCH_ACCOUNTS[0].value);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (session) return <Navigate to={safeFrom(location.state)} replace />;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!password) { setError('请先输入口令。'); return; }
    setBusy(true);
    setError(null);
    try {
      await login(account, password);
      setPassword('');
      // 会话写进缓存后，本页会重新渲染并跳回原来的位置。
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : '登录没有成功，请检查网络后重试。');
      setBusy(false);
    }
  }

  return (
    <div className="grid min-h-screen place-items-center bg-canvas px-4 py-10">
      <main className="w-full max-w-[380px] rounded-box border border-line bg-surface px-7 pb-6 pt-7">
        <Logo />
        <h1 className="m-0 mt-6 text-22 font-title">登录九安审单</h1>
        <p className="m-0 mt-1 text-13 text-steel">v0.7.10 测试台。单据、公司、人员全部虚构。</p>

        {notice && (
          <div role="status" className="mt-4 flex items-start gap-2 border border-wait-200 bg-wait-50 px-3 py-[10px] text-13 text-ink">
            <span className="mt-px text-wait-ink"><Icon name="warning" size={16} /></span>
            <span>{notice}</span>
          </div>
        )}

        <form className="mt-5 flex flex-col gap-[14px]" onSubmit={submit} noValidate>
          <div className="flex flex-col gap-[6px]">
            <label htmlFor="login-account" className="text-12 font-medium text-steel">账号</label>
            <select id="login-account" name="account" className={field} value={account} onChange={event => setAccount(event.target.value)}>
              {BENCH_ACCOUNTS.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-[6px]">
            <label htmlFor="login-password" className="text-12 font-medium text-steel">口令</label>
            <input
              id="login-password" name="password" type="password" autoComplete="current-password" maxLength={200} required
              className={field} value={password} onChange={event => setPassword(event.target.value)}
            />
          </div>
          {error && (
            <p role="alert" className="m-0 flex items-start gap-2 text-13 text-fail">
              <span className="mt-px"><Icon name="cross" size={16} /></span>{error}
            </p>
          )}
          <Button type="submit" variant="primary" busy={busy} className="mt-1 h-[34px] w-full">
            {busy ? '正在登录…' : '登录'}
          </Button>
        </form>

        <p className="m-0 mt-5 text-12 text-steel">
          口令由部署脚本生成，写在 infra/secrets.env。要往单据池里加一张新单，打开 <a className="text-blue hover:underline" href="/poc/intake">模拟来单</a>。
        </p>
      </main>
    </div>
  );
}
