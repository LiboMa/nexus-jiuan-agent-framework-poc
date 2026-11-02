// 模拟来单：先读九安的会话拿 CSRF 令牌（九安的 POST 都要 X-CSRF-Token），再列模板、来单。
const form = document.getElementById('intake');
const select = document.getElementById('template');
const message = document.getElementById('message');
const say = (text, kind = '') => { message.textContent = text; message.className = `message ${kind}`.trim(); };
let csrf = '';

async function api(path, options = {}) {
  const response = await fetch(`/api/analysis/v1${path}`, { credentials: 'same-origin', ...options,
    headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf } : {}) } });
  const payload = await response.json().catch(() => ({}));
  if (response.status === 401) throw new Error('还没有登录，或登录已过期：请先到登录页登录。');
  if (!response.ok) throw new Error(payload?.error?.message || `没有成功（${response.status}）。`);
  return payload.data;
}

async function load() {
  try {
    csrf = (await api('/session')).csrfToken || '';
    const { items } = await api('/poc/intake/templates');
    select.replaceChildren(...items.map(item => new Option(`${item.businessCode} · ${item.formName} · ${item.companyName} · ${item.title}`, item.businessCode)));
    form.hidden = false;
    say('');
  } catch (error) {
    say(error.message, 'error');
  }
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const button = form.querySelector('button');
  button.disabled = true;
  say('正在来单……');
  try {
    const result = await api('/poc/intake', { method: 'POST', body: JSON.stringify({ template: select.value }) });
    say(`已来单 ${result.businessCode}。${result.note}`, 'success');
  } catch (error) {
    say(error.message, 'error');
  } finally {
    button.disabled = false;
  }
});

void load();
