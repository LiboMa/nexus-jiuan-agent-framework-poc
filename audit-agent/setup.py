#!/usr/bin/env python3
"""在 Nexus 上找或建审核 Agent、它的 A2A 发布，并把知识库连接器绑进发布的动态配置。幂等：每一步先读现状，
已是目标状态就跳过（=），新建（+）、修改（~）才写。目标来自环境配置（--env <文件> 或环境变量 DEPLOY_ENV，必须给）。

1. 按 AGENT_NAME 找 Agent：没有就克隆 Nexus 的通用助手模板，写入 prompt.yaml（按环境替换占位符）；已有就不动提示词（改提示词用 apply.py）。
2. 找这个 Agent 的 A2A 发布：没有就建（a2a + mcp，跟随最新版本，模型 AGENT_MODEL，描述带「契约」「任务」两行）；已有就只核对描述。
3. 发布的动态配置里没有 CONNECTOR_ID 就加上（没有动态配置就新建一份，没绑上就绑）。
4. 配置文件里 AGENT_ID、PUBLICATION_ID 为空时写回；不为空又和 Nexus 上的不一致就报错，什么都不写。

调用密钥不在这里签发（接口不让，只能由发布者在 Nexus 网页上签发）；九安上的连接 Nexus、启用、设为审批 Agent 也是人做。
--delete 只给演练用：AGENT_NAME 以 _rehearsal 结尾才允许，删掉它的发布和 Agent，再查一遍确认没有残留。

用法：python3 audit-agent/setup.py --env poc/infra/env/<环境名>.env [--dry-run] [--delete]
"""
import argparse
import os
import re
from pathlib import Path
from time import sleep

from nexus_common import CONFIG_FIELDS, DESCRIPTION, nexus, render_prompt, target_from

HERE = Path(__file__).resolve().parent
TEMPLATE_AGENT = 'featured_general_assistant'
CONFIG_NAME = 'jiuan-audit'
CLONE_TIMEOUT, POLL_SECONDS, PAGE = 600, 5, 100


def say(mark, text):
    print(f'  {mark} {text}')


def find_agents(target):
    found, page = [], 1
    while True:
        items = nexus('GET', '/api/v2/agents', query=[f'page={page}', f'limit={PAGE}'], target=target) or []
        found += [agent for agent in items if agent.get('agent_name') == target.agent_name]
        if len(items) < PAGE:
            return found
        page += 1


def find_publications(target, agent_id):
    items = (nexus('GET', '/api/v2/publications', target=target) or {}).get('items') or []
    return [p for p in items if agent_id in (p.get('agent_id'), p.get('effective_agent_id')) and p.get('access') == 'owner']


def prompt_text(target):
    return render_prompt((HERE / 'prompt.yaml').read_text(encoding='utf-8'), target)


def ensure_agent(target, dry_run):
    agents = find_agents(target)
    if len(agents) > 1:
        raise SystemExit(f'Nexus 上有两个或更多叫 {target.agent_name} 的 Agent（{", ".join(a["agent_id"] for a in agents)}）：'
                         '先在网页上确认留哪一个、删掉别的，再重跑')
    found = agents[0]['agent_id'] if agents else None
    if target.agent_id and found != target.agent_id:
        raise SystemExit(f'配置里的 AGENT_ID（{target.agent_id}）和 Nexus 上叫 {target.agent_name} 的 Agent（{found or "没有"}）不一致：'
                         '核对配置文件写的是不是这个环境')
    if found:
        say('=', f'Agent {target.agent_name}（{found}）已在，提示词不动（改提示词用 apply.py）')
        return found
    if dry_run:
        say('+', f'[dry-run] 克隆通用助手为 {target.agent_name}（{target.display_name}），写入 prompt.yaml')
        return None
    description = re.search(r'^  description: (.+)$', prompt_text(target), re.M).group(1)
    clone = nexus('POST', '/api/v2/agents/{source_id}/clone', [f'source_id={TEMPLATE_AGENT}'],
                  {'name_cn': target.display_name, 'name_en': target.agent_name, 'description': description, 'locale': 'zh-CN'},
                  write=True, target=target)
    agent_id = clone['agent_id']
    for _ in range(CLONE_TIMEOUT // POLL_SECONDS):
        status = (nexus('GET', '/api/v2/agents/{agent_id}/clone-status', [f'agent_id={agent_id}'], target=target) or {}).get('status')
        if status == 'completed':
            break
        if status == 'failed':
            raise SystemExit(f'克隆 Agent 失败（{agent_id}）：在 Nexus 网页上看这个 Agent 的状态，删掉后重跑')
        sleep(POLL_SECONDS)
    else:
        raise SystemExit(f'克隆 Agent 超过 {CLONE_TIMEOUT} 秒没有完成（{agent_id}）：稍后重跑，会接着做')
    nexus('PUT', '/api/v2/agents/{agent_id}/files/prompt', [f'agent_id={agent_id}'],
          {'content': prompt_text(target), 'file_type': 'prompt', 'notes': 'setup.py：prompt.yaml（按环境配置替换占位符）'},
          write=True, target=target)
    say('+', f'Agent {target.agent_name}（{agent_id}）：已克隆，写入了提示词')
    return agent_id


def ensure_publication(target, agent_id, dry_run):
    if agent_id is None:
        say('+', '[dry-run] 建 A2A 发布（a2a + mcp），把连接器绑进动态配置')
        return None
    publications = find_publications(target, agent_id)
    if len(publications) > 1:
        raise SystemExit(f'Agent {agent_id} 有两个或更多发布（{", ".join(p["publish_id"] for p in publications)}）：'
                         '把要用的那个写进配置的 PUBLICATION_ID，其他的在网页上删掉，再重跑')
    found = publications[0] if publications else None
    if target.publication_id and (found or {}).get('publish_id') != target.publication_id:
        raise SystemExit(f'配置里的 PUBLICATION_ID（{target.publication_id}）和 Nexus 上这个 Agent 的发布（{(found or {}).get("publish_id") or "没有"}）不一致')
    if found is None:
        if dry_run:
            say('+', '[dry-run] 建 A2A 发布（a2a + mcp）')
            return None
        created = nexus('POST', '/api/v2/publications', body={
            'agent_id': agent_id, 'channels': ['a2a', 'mcp'], 'follow_updates': True, 'display_name': target.display_name,
            'description': DESCRIPTION, 'model_id': target.model}, write=True, target=target)
        publish_id = created['publication']['publish_id']
        say('+', f'A2A 发布 {publish_id}：已建（跟随最新版本，模型 {target.model}）')
        return publish_id
    publish_id = found['publish_id']
    if found.get('description') != DESCRIPTION:
        nexus('PATCH', '/api/v2/publications/{publish_id}', [f'publish_id={publish_id}'], {'description': DESCRIPTION},
              write=True, dry_run=dry_run, target=target)
        say('~', f'A2A 发布 {publish_id}：描述改成带「契约」「任务」两行')
    else:
        say('=', f'A2A 发布 {publish_id} 已在，描述是最新的')
    return publish_id


def ensure_connector(target, publish_id, dry_run):
    if publish_id is None:
        return
    config = nexus('GET', '/api/v2/publications/{publish_id}/dynamic-config', [f'publish_id={publish_id}'], target=target, missing_ok=True)
    if config and target.connector_id in (config.get('connectors') or []):
        say('=', f'动态配置 {config.get("config_name")} 已绑连接器 {target.connector_id}')
        return
    if config:
        body = {field: config.get(field) for field in CONFIG_FIELDS}
        body['connectors'] = [*(config.get('connectors') or []), target.connector_id]
        body['overwrite_dynamic_id'] = config['dynamic_id']
    else:
        body = {'config_name': CONFIG_NAME, 'connectors': [target.connector_id], 'key_match_mode': 'exact'}
    saved = nexus('POST', '/api/v2/publications/{publish_id}/dynamic-config', [f'publish_id={publish_id}'], body,
                  write=True, dry_run=dry_run, target=target)
    if dry_run:
        say('~', f'[dry-run] 动态配置加上连接器 {target.connector_id}')
        return
    after = nexus('GET', '/api/v2/publications/{publish_id}/dynamic-config', [f'publish_id={publish_id}'], target=target, missing_ok=True)
    if not after or target.connector_id not in (after.get('connectors') or []):
        nexus('PUT', '/api/v2/publications/{publish_id}/dynamic-config/bind', [f'publish_id={publish_id}'],
              {'dynamic_id': (saved or {})['dynamic_id']}, write=True, target=target)
    say('~' if config else '+', f'动态配置：已绑上连接器 {target.connector_id}')


def write_back(env_path, values):
    """把建好的编号写回配置文件里空着的那一行（没有这一行就加在末尾），其他行原样不动。"""
    lines = Path(env_path).read_text(encoding='utf-8').splitlines(keepends=True)
    changed = []
    for key, value in values.items():
        for index, line in enumerate(lines):
            if line.rstrip('\r\n') == f'{key}=':
                lines[index] = f'{key}={value}\n'
                changed.append(key)
                break
        else:
            if not any(line.startswith(f'{key}=') for line in lines):
                lines.append(f'{key}={value}\n')
                changed.append(key)
    if changed:
        Path(env_path).write_text(''.join(lines), encoding='utf-8')
        print(f'已把 {"、".join(changed)} 写回 {env_path}')


def delete_rehearsal(target, env_path, dry_run):
    if not target.agent_name.endswith('_rehearsal'):
        raise SystemExit(f'--delete 只给演练用：AGENT_NAME 要以 _rehearsal 结尾（现在是 {target.agent_name}）')
    for agent in find_agents(target):
        for publication in find_publications(target, agent['agent_id']):
            nexus('DELETE', '/api/v2/publications/{publish_id}', [f'publish_id={publication["publish_id"]}'],
                  write=True, dry_run=dry_run, target=target)
            say('-', f'删了发布 {publication["publish_id"]}')
        nexus('DELETE', '/api/v2/agents/{agent_id}', [f'agent_id={agent["agent_id"]}'], query=['delete_local_files=true', 'delete_cloud_resources=true'],
              write=True, dry_run=dry_run, target=target)
        say('-', f'删了 Agent {agent["agent_id"]}')
    if dry_run:
        return
    left = find_agents(target)
    if left:
        raise SystemExit(f'还有残留：{", ".join(a["agent_id"] for a in left)}')
    print(f'没有残留：Nexus 上已经没有叫 {target.agent_name} 的 Agent')
    text = Path(env_path).read_text(encoding='utf-8')
    Path(env_path).write_text(re.sub(r'^(AGENT_ID|PUBLICATION_ID)=.*$', r'\1=', text, flags=re.M), encoding='utf-8')


def main(argv=None):
    parser = argparse.ArgumentParser(description='在 Nexus 上找或建审核 Agent、A2A 发布，并绑上知识库连接器')
    parser.add_argument('--env', default=os.environ.get('DEPLOY_ENV') or None, help='环境配置（poc/infra/env/<环境名>.env），必须给')
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--delete', action='store_true', help='删掉演练用的 Agent 和发布（AGENT_NAME 以 _rehearsal 结尾）')
    opts = parser.parse_args(argv)
    if not opts.env:
        raise SystemExit('要指明是哪个环境：--env poc/infra/env/<环境名>.env（或环境变量 DEPLOY_ENV）')
    try:
        target = target_from(opts.env)
    except ValueError as error:
        raise SystemExit(str(error)) from None
    print(f'环境：{opts.env}（Nexus {target.origin}，Agent {target.agent_name}）')
    if opts.delete:
        delete_rehearsal(target, opts.env, opts.dry_run)
        return
    agent_id = ensure_agent(target, opts.dry_run)
    publish_id = ensure_publication(target, agent_id, opts.dry_run)
    ensure_connector(target, publish_id, opts.dry_run)
    if opts.dry_run:
        return
    write_back(opts.env, {'AGENT_ID': agent_id, 'PUBLICATION_ID': publish_id})
    print(f'下一步（人做）：在 Nexus 网页上给发布 {publish_id} 签发调用密钥；在九安「后台配置 › Agent 接入」连接 Nexus、'
          '启用这个发布、设为审批 Agent（docs/delivery/test-deployment.md）')


if __name__ == '__main__':
    main()
