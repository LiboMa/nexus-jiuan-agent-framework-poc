"""audit-agent 的下发脚本（apply.py、setup.py）共用：目标环境、提示词渲染、经 nexus-ai-operator 调 Nexus。

目标环境来自环境配置（poc/infra/env/<环境名>.env，规则见 deploy_env.py）；不给配置文件就是现有环境（nxs-beine1013）。
prompt.yaml 里不写环境值：${CONNECTOR_ID}、${AGENT_NAME}、${AGENT_MODEL} 下发前按目标环境替换。
"""
import json
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from deploy_env import read_deploy_env

HERE = Path(__file__).resolve().parent
NEXUS = HERE.parent / 'skills/nexus-ai-operator/scripts/nexus.py'
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
DEFAULTS = {'AGENT_NAME': 'jiuan_audit_ai_poc', 'AGENT_DISPLAY_NAME': '九安审核AI（PoC）', 'AGENT_MODEL': 'global.anthropic.claude-opus-5-5'}
PLACEHOLDER = re.compile(r'\$\{([A-Z_]+)\}')


@dataclass(frozen=True)
class Target:
    origin: str
    profile: str
    agent_name: str
    display_name: str
    model: str
    agent_id: str
    publication_id: str
    connector_id: str


# 现有环境（不给配置文件时）：Nexus nxs-beine1013 上的「九安审核AI（PoC）」
EXISTING = Target(origin='https://nxs-beine1013.tinyboat.blog', profile='beine1013', agent_name=DEFAULTS['AGENT_NAME'],
                  display_name=DEFAULTS['AGENT_DISPLAY_NAME'], model=DEFAULTS['AGENT_MODEL'], agent_id='agent_56d44dd9350f4a568bca387319e12ae4',
                  publication_id='pub_5c53e70d8dc7ddea', connector_id='conn-f0c7233959d9')


def target_from(env_path):
    if not env_path:
        return EXISTING
    values = read_deploy_env(env_path)
    missing = [key for key in ('NEXUS_ORIGIN', 'NEXUS_PROFILE', 'CONNECTOR_ID') if not values.get(key)]
    if missing:
        raise ValueError(f"{env_path}：没写 {'、'.join(missing)}（NEXUS_ORIGIN 是 Nexus 的地址，NEXUS_PROFILE 是 nexus-ai-operator 的配置名，"
                         'CONNECTOR_ID 是知识库连接器的编号，kb.sh connector 之后从 kb.sh status 抄）')
    return Target(origin=values['NEXUS_ORIGIN'].rstrip('/'), profile=values['NEXUS_PROFILE'],
                  agent_name=values.get('AGENT_NAME', DEFAULTS['AGENT_NAME']), display_name=values.get('AGENT_DISPLAY_NAME', DEFAULTS['AGENT_DISPLAY_NAME']),
                  model=values.get('AGENT_MODEL', DEFAULTS['AGENT_MODEL']), agent_id=values.get('AGENT_ID', ''),
                  publication_id=values.get('PUBLICATION_ID', ''), connector_id=values['CONNECTOR_ID'])


def render_prompt(text, target):
    values = {'CONNECTOR_ID': target.connector_id, 'AGENT_NAME': target.agent_name, 'AGENT_MODEL': target.model}

    def value(match):
        if match.group(1) not in values:
            raise ValueError(f'提示词里有不认识的占位符 ${{{match.group(1)}}}（只认 {"、".join(values)}）')
        return values[match.group(1)]
    rendered = PLACEHOLDER.sub(value, text)
    if '${' in rendered:
        raise ValueError('提示词替换后还留着 ${：检查占位符的写法')
    return rendered


def nexus(method, path, params=(), body=None, write=False, dry_run=False, *, target):
    """经 nexus-ai-operator 调一次 Nexus 接口；写操作 dry_run 时只打印，不调。"""
    args = [sys.executable, str(NEXUS), '--profile', target.profile, '--json', 'call', method, path]
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
