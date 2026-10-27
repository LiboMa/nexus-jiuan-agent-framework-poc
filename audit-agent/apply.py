#!/usr/bin/env python3
"""把 audit-agent/prompt.yaml 下发到 Nexus 上的审核 Agent，并让它的 A2A 发布用上它。目标（Nexus、operator 配置名、Agent、发布、
连接器）来自环境配置：--env <文件>，或环境变量 DEPLOY_ENV；都不给就是现有环境（nxs-beine1013 上的「九安审核AI（PoC）」）。
提示词里的 ${CONNECTOR_ID}、${AGENT_NAME}、${AGENT_MODEL} 按目标替换后再比、再写。Agent 和发布还没有时先跑 setup.py。

1. 读线上的提示词：必须和 --base 给的底稿逐字一致才写（已经是 prompt.yaml 就跳过），避免盖掉网页上的改动。
2. PUT 提示词。
3. 原样重存发布的动态配置（overwrite_dynamic_id）：A2A 每一轮用的是动态配置里的快照，不重存就还是旧提示词。
4. 发布描述写上「契约：jiuan.agent/v1」「任务：review_advice@1」两行：九安读名片时按这两行判断支持哪些任务。
5. 只读核对：快照里有第 9 条、连接器和密钥匹配方式没变、公开名片上有这两行。

经 Operator（skills/nexus-ai-operator，配置名取自环境配置的 NEXUS_PROFILE）调用；写操作都带 --yes，所以先用 --dry-run 看一遍。
用法：python3 audit-agent/apply.py [--env poc/infra/env/<环境名>.env] --base <线上现版本存的底稿> [--dry-run]
"""
import argparse
import json
import os
import urllib.request
from pathlib import Path

from nexus_common import CONFIG_FIELDS, DESCRIPTION, nexus, render_prompt, target_from

HERE = Path(__file__).resolve().parent
MARKER = '9. 信封模式'


def live_prompt(target):
    return nexus('GET', '/api/v2/agents/{agent_id}/files/prompt', [f'agent_id={target.agent_id}'], target=target)['content']


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument('--env', default=os.environ.get('DEPLOY_ENV') or None, help='环境配置（poc/infra/env/<环境名>.env）；不给就是现有环境')
    parser.add_argument('--base', required=True, help='线上提示词应当是的那份底稿（上次下发的版本，或网页上改过后存下来的副本）')
    parser.add_argument('--dry-run', action='store_true')
    opts = parser.parse_args(argv)
    try:
        target = target_from(opts.env)
    except ValueError as error:
        raise SystemExit(str(error)) from None
    if not target.agent_id or not target.publication_id:
        raise SystemExit(f'{opts.env}：AGENT_ID / PUBLICATION_ID 是空的：先跑 audit-agent/setup.py 建好 Agent 和发布（它会把编号写回配置）')
    target_prompt = render_prompt((HERE / 'prompt.yaml').read_text(encoding='utf-8'), target)
    base = Path(opts.base).read_text(encoding='utf-8')

    current = live_prompt(target)
    if current == target_prompt:
        print('提示词：线上已是 prompt.yaml，跳过')
    elif current != base:
        raise SystemExit('线上提示词和底稿不一致（可能有人在网页上改过）：先把线上版本存成新底稿、合并改动，再重新运行。')
    else:
        nexus('PUT', '/api/v2/agents/{agent_id}/files/prompt', [f'agent_id={target.agent_id}'],
              {'content': target_prompt, 'file_type': 'prompt', 'notes': 'v3：jiuan.agent/v1 信封模式（review_advice@1）+ 知识库只读查询（kb_search）'},
              write=True, dry_run=opts.dry_run, target=target)
        print('提示词：已写入')

    config = nexus('GET', '/api/v2/publications/{publish_id}/dynamic-config', [f'publish_id={target.publication_id}'], target=target)
    body = {field: config.get(field) for field in CONFIG_FIELDS}
    body['overwrite_dynamic_id'] = config['dynamic_id']
    nexus('POST', '/api/v2/publications/{publish_id}/dynamic-config', [f'publish_id={target.publication_id}'], body, write=True,
          dry_run=opts.dry_run, target=target)
    print(f"动态配置：已原样重存 {config['dynamic_id']}（连接器 {config.get('connectors')}，key_match_mode {config.get('key_match_mode')}）")

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
    for field in ('connectors', 'keys', 'key_match_mode', 'tools'):
        if after.get(field) != config.get(field):
            problems.append(f'动态配置的 {field} 变了：{config.get(field)} → {after.get(field)}')
    with urllib.request.urlopen(f'{target.origin}/a2a/{target.publication_id}/.well-known/agent-card.json', timeout=30) as response:
        card = json.load(response)
    lines = card.get('description', '').splitlines()
    for line in ('契约：jiuan.agent/v1', '任务：review_advice@1'):
        if line not in lines:
            problems.append(f'名片描述里没有「{line}」')
    if problems:
        raise SystemExit('核对没通过：' + '；'.join(problems))
    print(f"核对通过：快照有第 9 条（{len(snapshot)} 字），连接器与密钥匹配方式不变，名片有契约和任务两行（发布修订号 {card.get('version')}）")


if __name__ == '__main__':
    main()
