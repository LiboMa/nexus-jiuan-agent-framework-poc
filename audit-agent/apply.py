#!/usr/bin/env python3
"""把 audit-agent/prompt.yaml 下发到 Nexus 上的审核 Agent，并让它的 A2A 发布用上它。目标（Nexus、operator 配置名、Agent、发布、
连接器或规则工具、知识库方式 KB_MODE）来自环境配置：--env <文件>，或环境变量 DEPLOY_ENV；都不给就是现有环境（nxs-beine1013 上的
「九安审核AI（PoC）」，pg 方式）。提示词按方式渲染（nexus_common.render_prompt：留当前方式的块，替换 ${CONNECTOR_ID} / ${RULES_TOOL_DIR}、
${AGENT_NAME}、${AGENT_MODEL}）后再比、再写。Agent 和发布还没有时先跑 setup.py；换方式时先跑 setup.py（解绑或绑上连接器）再跑这里。

1. 读线上的提示词，和渲染结果不同时打印逐行 diff（- 线上，+ 要写的）；必须和 --base 给的底稿逐字一致才写（已经是渲染结果就跳过），
   避免盖掉网页上的改动。--dry-run 时可以不给 --base，只看 diff。
2. PUT 提示词。
3. 重存发布的动态配置（overwrite_dynamic_id）：A2A 每一轮用的是动态配置里的快照，不重存就还是旧提示词。工具（tools）按
   CONFIG_TOOLS 写（pg 方式清空；打印前后两份清单），连接器、密钥等其余字段原样带回。
4. 发布描述写上「契约：jiuan.agent/v1」「任务：review_advice@1」两行：九安读名片时按这两行判断支持哪些任务。
5. 只读核对：快照里有第 9 条、工具是 CONFIG_TOOLS 那一份（去掉的工具也不在快照的 tools_dependencies 里）、连接器和密钥匹配方式
   没变、公开名片上有这两行。

经 Operator（skills/nexus-ai-operator，配置名取自环境配置的 NEXUS_PROFILE）调用；写操作都带 --yes，所以先用 --dry-run 看一遍。
用法：python3 audit-agent/apply.py [--env poc/infra/env/<环境名>.env] --dry-run [--base <底稿>]
      python3 audit-agent/apply.py [--env poc/infra/env/<环境名>.env] --base <线上现版本存的底稿>
"""
import argparse
import difflib
import json
import os
import urllib.request
from pathlib import Path

from nexus_common import CONFIG_FIELDS, DESCRIPTION, nexus, render_prompt, target_from

HERE = Path(__file__).resolve().parent
MARKER = '9. 信封模式'
# 动态配置里的工具（tools）每种方式留哪些；没写的方式原样保留。审核 Agent 用的工具都在 prompt.yaml 的 tools_dependencies 里
# （pg 方式的 data_connector_* 还会由绑着的连接器带进快照），动态配置不需要再加；加了的每一轮都进模型的工具清单，白占 token。
CONFIG_TOOLS = {'pg': []}
NOTES = {'pg': 'v3：jiuan.agent/v1 信封模式（review_advice@1）+ 知识库只读查询（kb_search）+ 审核员自定义规则',
         's3vectors': 'v3：jiuan.agent/v1 信封模式（review_advice@1）+ 规则检索（rules_search）+ 审核员自定义规则'}


def live_prompt(target):
    return nexus('GET', '/api/v2/agents/{agent_id}/files/prompt', [f'agent_id={target.agent_id}'], target=target)['content']


def print_diff(current, target_prompt, kb_mode):
    """线上提示词 → 要写的提示词，逐行 diff，不带上下文行。"""
    diff = difflib.unified_diff(current.splitlines(), target_prompt.splitlines(), fromfile='线上提示词',
                                tofile=f'prompt.yaml（{kb_mode} 方式渲染）', n=0, lineterm='')
    for line in diff:
        print(line)


def config_tools(config, kb_mode):
    """动态配置要写回的 tools：这种方式在 CONFIG_TOOLS 里就用那一份，不在就原样。"""
    return list(CONFIG_TOOLS[kb_mode]) if kb_mode in CONFIG_TOOLS else config.get('tools')


def print_tools(before, after, kb_mode):
    """动态配置的工具：前后两份清单（- 去掉的，+ 加上的，空格开头是留着的）。"""
    before, after = list(before or []), list(after or [])
    if before == after:
        print(f'动态配置的工具：不变（{len(after)} 个）')
        return
    print(f'动态配置的工具（{kb_mode} 方式按 CONFIG_TOOLS）：{len(before)} 个 → {len(after)} 个')
    for tool in before:
        print(f'  {" " if tool in after else "-"} {tool}')
    for tool in after:
        if tool not in before:
            print(f'  + {tool}')


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--env', default=os.environ.get('DEPLOY_ENV') or None, help='环境配置（poc/infra/env/<环境名>.env）；不给就是现有环境')
    parser.add_argument('--base', help='线上提示词应当是的那份底稿（上次下发的版本，或网页上改过后存下来的副本）；真写时必须给，--dry-run 时可以不给')
    parser.add_argument('--dry-run', action='store_true')
    opts = parser.parse_args(argv)
    if not opts.base and not opts.dry_run:
        parser.error('要给 --base <底稿>（线上现版本存下来的副本）；只看 diff 用 --dry-run')
    try:
        target = target_from(opts.env)
    except ValueError as error:
        raise SystemExit(str(error)) from None
    if not target.agent_id or not target.publication_id:
        raise SystemExit(f'{opts.env}：AGENT_ID / PUBLICATION_ID 是空的：先跑 audit-agent/setup.py 建好 Agent 和发布（它会把编号写回配置）')
    try:
        target_prompt = render_prompt((HERE / 'prompt.yaml').read_text(encoding='utf-8'), target)
    except ValueError as error:
        raise SystemExit(f'prompt.yaml 渲染失败：{error}') from None
    base = Path(opts.base).read_text(encoding='utf-8') if opts.base else None

    current = live_prompt(target)
    if current == target_prompt:
        print(f'提示词：线上已是 prompt.yaml（{target.kb_mode} 方式），跳过')
    else:
        print_diff(current, target_prompt, target.kb_mode)
        if base is None:
            print('提示词：没给 --base，不核对底稿（真写时要给）')
        elif current != base:
            raise SystemExit('线上提示词和底稿不一致（可能有人在网页上改过）：先把线上版本存成新底稿、合并改动，再重新运行。')
        nexus('PUT', '/api/v2/agents/{agent_id}/files/prompt', [f'agent_id={target.agent_id}'],
              {'content': target_prompt, 'file_type': 'prompt', 'notes': NOTES[target.kb_mode]},
              write=True, dry_run=opts.dry_run, target=target)
        print('提示词：已写入')

    config = nexus('GET', '/api/v2/publications/{publish_id}/dynamic-config', [f'publish_id={target.publication_id}'], target=target)
    body = {field: config.get(field) for field in CONFIG_FIELDS}
    body['tools'] = config_tools(config, target.kb_mode)
    body['overwrite_dynamic_id'] = config['dynamic_id']
    print_tools(config.get('tools'), body['tools'], target.kb_mode)
    nexus('POST', '/api/v2/publications/{publish_id}/dynamic-config', [f'publish_id={target.publication_id}'], body, write=True,
          dry_run=opts.dry_run, target=target)
    print(f"动态配置：已重存 {config['dynamic_id']}（工具 {len(body['tools'] or [])} 个；其余原样：连接器 {config.get('connectors')}，"
          f"key_match_mode {config.get('key_match_mode')}）")

    publication = nexus('GET', '/api/v2/publications/{publish_id}', [f'publish_id={target.publication_id}'], target=target)
    if publication.get('description') != DESCRIPTION:
        nexus('PATCH', '/api/v2/publications/{publish_id}', [f'publish_id={target.publication_id}'], {'description': DESCRIPTION},
              write=True, dry_run=opts.dry_run, target=target)
        print('发布描述：已写上契约和任务两行')
    else:
        print('发布描述：已是最新，跳过')
    if opts.dry_run:
        return

    after = nexus('GET', '/api/v2/publications/{publish_id}/dynamic-config', [f'publish_id={target.publication_id}'], target=target)
    snapshot = after['resolved_definition']['agent']['versions'][0]['system_prompt']
    problems = []
    if MARKER not in snapshot:
        problems.append('动态配置的快照里没有第 9 条')
    for field in ('connectors', 'keys', 'key_match_mode'):
        if after.get(field) != config.get(field):
            problems.append(f'动态配置的 {field} 变了：{config.get(field)} → {after.get(field)}')
    if (after.get('tools') or []) != (body['tools'] or []):
        problems.append(f"动态配置的 tools 是 {after.get('tools')}（应当是 {body['tools']}）")
    dependencies = (after['resolved_definition']['agent']['versions'][0].get('metadata') or {}).get('tools_dependencies') or []
    dropped = [tool for tool in (config.get('tools') or []) if tool not in (body['tools'] or []) and tool in dependencies]
    if dropped:
        problems.append(f'快照的 tools_dependencies 里还有去掉的工具：{dropped}')
    with urllib.request.urlopen(f'{target.origin}/a2a/{target.publication_id}/.well-known/agent-card.json', timeout=30) as response:
        card = json.load(response)
    lines = card.get('description', '').splitlines()
    for line in ('契约：jiuan.agent/v1', '任务：review_advice@1'):
        if line not in lines:
            problems.append(f'名片描述里没有「{line}」')
    if problems:
        raise SystemExit('核对没通过：' + '；'.join(problems))
    print(f"核对通过：快照有第 9 条（{len(snapshot)} 字），工具 {len(body['tools'] or [])} 个，连接器与密钥匹配方式不变，"
          f"名片有契约和任务两行（发布修订号 {card.get('version')}）")


if __name__ == '__main__':
    main()
