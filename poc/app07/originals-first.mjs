/**
 * AI 独立建议之前先读原件：九安流水线里「下载原件」「抽取页文字」两步是暂停的，review_advice@1 只用已经读过的原件，
 * 不先读的话 Agent 只能回「原件未能核验」。包住九安的适配器：流水线调 run 时先 readOriginals()，再交给九安原来的 run；
 * plan、validate、modes 原样。读原件出错只记错误码，不挡这一轮。
 */
const codeOf = error => (typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'UNKNOWN');

export function withOriginalsFirst(adapter, { readOriginals, log = code => console.error(code) }) {
  return Object.freeze({
    ...adapter,
    async run(ctx) {
      try { await readOriginals(); } catch (error) { log(`POC_ORIGINALS_FIRST_FAILED ${codeOf(error)}`); }
      return adapter.run(ctx);
    },
  });
}
