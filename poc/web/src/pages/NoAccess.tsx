import { Link } from 'react-router';
import { ROLE_LABELS, useSession } from '../api/session';
import { Icon } from '../ui/icons';

/** 角色进不去的页面（Review Focus 5）。接口那头九安和外壳照样拒绝；这里只是不让人看到一页报错。 */
export function NoAccess() {
  const role = useSession()?.user.role;
  const who = role && ROLE_LABELS[role] ? `当前账号是${ROLE_LABELS[role]}，` : '当前账号';
  return (
    <div className="mx-auto mt-16 flex max-w-[460px] flex-col items-center gap-2 rounded-box border border-line bg-surface px-8 py-10 text-center">
      <span className="grid h-10 w-10 place-items-center bg-wait-50 text-wait-ink"><Icon name="warning" size={20} /></span>
      <h1 className="m-0 mt-1 text-16 font-semibold">没有权限</h1>
      <p className="m-0 text-13 text-steel">{who}不能打开这一页。需要的话，请联系管理员调整账号的角色。</p>
      <Link to="/" className="mt-3 inline-flex h-[30px] items-center rounded-ctl border border-line px-3 text-13 font-semibold text-ink hover:bg-canvas">回到工作台</Link>
    </div>
  );
}
