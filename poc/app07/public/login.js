// 口令登录：口令对了拿到九安的本地票据，跳到 /#access=<票据>，由九安自己的前端换成会话。
const form = document.getElementById('login');
const message = document.getElementById('message');
const MESSAGES = { 401: '账号或口令不正确。', 429: '登录尝试过多，请一分钟后再试。' };
const say = (text, kind = '') => { message.textContent = text; message.className = `message ${kind}`.trim(); };
form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  say('');
  try {
    const response = await fetch('/api/analysis/v1/poc/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ account: form.account.value, password: form.password.value }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(MESSAGES[response.status] || payload?.error?.message || '登录没有成功，请稍后再试。');
    form.password.value = '';
    location.replace(`/#access=${encodeURIComponent(payload.data.ticket)}`);
  } catch (error) {
    say(error.message, 'error');
    button.disabled = false;
    form.password.focus();
  }
});
