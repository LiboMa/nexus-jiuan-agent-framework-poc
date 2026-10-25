/**
 * 按 Host 转发：九安 v0.7.10 的站点（第二个 CloudFront 分发）也用这台实例的 4180 端口。安全组那条入站规则引用 CloudFront 前缀列表，
 * 按 55 条规则计（上限 60），扩端口有超配额的风险；实例的安全组挂在网卡上，改它会换实例。所以 PoC 进程收到这个 Host 的请求，
 * 原样转给本机端口上的 v0.7.10：请求体、响应体都流式转发，不读不改；请求头原样（含 Host、Cookie、Origin、X-Forwarded-For），
 * 只去掉逐跳头。上游连不上回 502。
 */
import http from 'node:http';

const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'proxy-authorization', 'transfer-encoding', 'te', 'trailer', 'upgrade']);
const endToEnd = headers => Object.fromEntries(Object.entries(headers).filter(([name]) => !HOP.has(name)));

export function createHostProxy({ host, port, upstreamHost = '127.0.0.1', timeoutMs = 300_000 }) {
  return {
    matches: req => req.headers.host === host,
    forward(req, res) {
      const upstream = http.request({ host: upstreamHost, port, method: req.method, path: req.url, headers: endToEnd(req.headers), timeout: timeoutMs }, response => {
        res.writeHead(response.statusCode, endToEnd(response.headers));
        response.pipe(res);
      });
      upstream.on('timeout', () => upstream.destroy(new Error('upstream timeout')));
      upstream.on('error', () => {
        if (res.headersSent) { res.destroy(); return; }
        res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end('upstream unavailable');
      });
      req.pipe(upstream);
    },
  };
}
