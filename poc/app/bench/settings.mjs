/**
 * 测试台给九安配置对象多加的几项（PoC 的配置对象在代码里拼，不经九安的配置加载器）：
 * docker 模式让九安的密钥来源只看环境变量和文件（这里都不给，汇联易、钉钉都是未绑定）；
 * 汇联易来源指向不存在的文件，连接器登记的「测试实例只连测试租户」检查照样通过。
 */
export const BENCH_CONNECTION_ID = 'poc-bench';
export const BENCH_JIUAN_CONFIG = Object.freeze({
  deployment: 'ecs-docker', mode: 'read_only_analysis', connectionId: BENCH_CONNECTION_ID,
  automaticSync: false, syncIntervalMs: 0, schedulerChain: false,
  source: Object.freeze({ kind: 'huilianyi-stage-oauth', appIdFile: '/nonexistent/hly_stage_app_id', appSecretFile: '/nonexistent/hly_stage_app_secret' }),
});
