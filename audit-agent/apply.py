#!/usr/bin/env python3
"""把 audit-agent/prompt.yaml 下发到 Nexus 上的「九安审核AI（PoC）」，并让发布 pub_5c53e70d8dc7ddea 用上它。

1. 读线上的提示词：必须和 --base 给的底稿逐字一致才写（已经是 prompt.yaml 就跳过），避免盖掉网页上的改动。
2. PUT 提示词。
3. 原样重存发布的动态配置（overwrite_dynamic_id）：A2A 每一轮用的是动态配置里的快照，不重存就还是旧提示词。
4. 发布描述写上「契约：jiuan.agent/v1」「任务：review_advice@1」两行：九安读名片时按这两行判断支持哪些任务。
5. 只读核对：快照里有第 9 条、连接器和密钥匹配方式没变、公开名片上有这两行。

经 Operator（skills/nexus-ai-operator，profile beine1013）调用；写操作都带 --yes，所以先用 --dry-run 看一遍。
用法：python3 audit-agent/apply.py --base audit-agent/prompt-owner-2026-10-25.yaml [--dry-run]
"""
import argparse
import json
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
NEXUS = HERE.parent / 'skills/nexus-ai-operator/scripts/nexus.py'
AGENT_ID = 'agent_56d44dd9350f4a568bca387319e12ae4'
PUBLISH_ID = 'pub_5c53e70d8dc7ddea'
ORIGIN = 'https://nxs-beine1013.tinyboat.blog'
MARKER = '9. 信封模式'
DESCRIPTION = '\n'.join([
    '九安自助审核平台经 A2A 调用 Nexus Agent 的对接验证（PoC）：三段式的审批建议；九安 v0.7.10 的单据审核建议，'
    '按《财务事项审批及授权管理办法》知识库只读查询后给出通过 / 不通过和依据。',
    '契约：jiuan.agent/v1',
    '任务：review_advice@1',
])
# 动态配置里原样带回的字段（null 是继承、[] 是清空，所以一律按现值写回）
CONFIG_FIELDS = ['config_name', 'skills', 'tools', 'agents', 'cowork_mode', 'swarm_entry_point', 'graph_nodes', 'graph_edges',
                 'connectors', 'keys', 'directive_ids', 'template_asset_ids', 'template_collection_ids', 'key_match_mode',
                 'env_recipe_refs', 'custom_resource_ids']


def nexus(method, path, params=(), body=None, write=False, dry_run=False):
    args = [sys.executable, str(NEXUS), '--profile', 'beine1013', '--json', 'call', method, path]
    for item in params:
        args += ['-p', item]
    with tempfile.NamedTemporaryFile('w', suffix='.json', encoding='utf-8') as data:
        if body is not None:
            json.dump(body, data, ensure_ascii=False)
            data.flush()
            args += ['--data-file', data.name]
        if write:
            args += ['--dry-run'] if dry_run else ['--yes']
        done = subprocess.run(args, capture_output=True, text=True, timeout=120)
    if done.returncode != 0:
        raise SystemExit(f'{method} {path} 失败（退出码 {done.returncode}）：{done.stderr.strip()[:600]}')
    if write and dry_run:
        print(f'[dry-run] {method} {path}')
        return None
    payload = json.loads(done.stdout)
    return payload.get('data', payload) if isinstance(payload, dict) else payload


def live_prompt():
    return nexus('GET', '/api/v2/agents/{agent_id}/files/prompt', [f'agent_id={AGENT_ID}'])['content']


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--base', required=True, help='线上提示词应当是的那份底稿（上次下发的版本，或网页上改过后存下来的副本）')
    parser.add_argument('--dry-run', action='store_true')
    opts = parser.parse_args()
    target = (HERE / 'prompt.yaml').read_text(encoding='utf-8')
    base = Path(opts.base).read_text(encoding='utf-8')

    current = live_prompt()
    if current == target:
        print('提示词：线上已是 prompt.yaml，跳过')
    elif current != base:
        raise SystemExit('线上提示词和底稿不一致（可能有人在网页上改过）：先把线上版本存成新底稿、合并改动，再重新运行。')
    else:
        nexus('PUT', '/api/v2/agents/{agent_id}/files/prompt', [f'agent_id={AGENT_ID}'],
              {'content': target, 'file_type': 'prompt', 'notes': 'v3：jiuan.agent/v1 信封模式（review_advice@1）+ 知识库只读查询'},
              write=True, dry_run=opts.dry_run)
        print('提示词：已写入')

    config = nexus('GET', '/api/v2/publications/{publish_id}/dynamic-config', [f'publish_id={PUBLISH_ID}'])
    body = {field: config.get(field) for field in CONFIG_FIELDS}
    body['overwrite_dynamic_id'] = config['dynamic_id']
    nexus('POST', '/api/v2/publications/{publish_id}/dynamic-config', [f'publish_id={PUBLISH_ID}'], body, write=True, dry_run=opts.dry_run)
    print(f"动态配置：已原样重存 {config['dynamic_id']}（连接器 {config.get('connectors')}，key_match_mode {config.get('key_match_mode')}）")

    publication = nexus('GET', '/api/v2/publications/{publish_id}', [f'publish_id={PUBLISH_ID}'])
    if publication.get('description') != DESCRIPTION:
        nexus('PATCH', '/api/v2/publications/{publish_id}', [f'publish_id={PUBLISH_ID}'], {'description': DESCRIPTION},
              write=True, dry_run=opts.dry_run)
        print('发布描述：已写上契约和任务两行')
    else:
        print('发布描述：已是最新，跳过')
    if opts.dry_run:
        return

    after = nexus('GET', '/api/v2/publications/{publish_id}/dynamic-config', [f'publish_id={PUBLISH_ID}'])
    snapshot = after['resolved_definition']['agent']['versions'][0]['system_prompt']
    problems = []
    if MARKER not in snapshot:
        problems.append('动态配置的快照里没有第 9 条')
    for field in ('connectors', 'keys', 'key_match_mode', 'tools'):
        if after.get(field) != config.get(field):
            problems.append(f'动态配置的 {field} 变了：{config.get(field)} → {after.get(field)}')
    with urllib.request.urlopen(f'{ORIGIN}/a2a/{PUBLISH_ID}/.well-known/agent-card.json', timeout=30) as response:
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
