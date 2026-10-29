"""audit-agent 的下发脚本（apply.py、setup.py）共用：目标环境、提示词渲染、经 nexus-ai-operator 调 Nexus。

目标环境来自环境配置（poc/infra/env/<环境名>.env，规则见 deploy_env.py）；不给配置文件就是现有环境（nxs-beine1013，pg 方式）。
prompt.yaml 里和知识库有关的几段按 KB_MODE 写成两种方式块：单独一行 #<kb:pg> … #</kb:pg>、#<kb:s3vectors> … #</kb:s3vectors>（行首可有缩进）；
渲染时留当前方式的块、整块删掉另一种（连同标记行），再替换占位符。prompt.yaml 里不写环境值：${AGENT_NAME}、${AGENT_MODEL} 两种方式都有，
${CONNECTOR_ID} 只在 pg 块里、${RULES_TOOL_DIR} 只在 s3vectors 块里，下发前按目标环境替换。
"""
import json
import re
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from deploy_env import KB_MODES, read_deploy_env

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
BLOCK = re.compile(r'^[ \t]*#<(/?)kb:([^>]*)>[ \t]*$')
LOOKS_LIKE_BLOCK = re.compile(r'^[ \t]*#</?kb:')
# 只能写在某一种方式的块里的占位符 → 那种方式
MODE_ONLY = {'CONNECTOR_ID': 'pg', 'RULES_TOOL_DIR': 's3vectors'}


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
    kb_mode: str = 'pg'          # 'pg' | 's3vectors'
    rules_tool_dir: str = ''     # s3vectors：规则工具导入后的目录（imported_tools/<目录>/s3vectors_rules_tools）
    kb_key_id: str = ''          # s3vectors：绑给规则工具的 S3 Vectors 密钥编号


# 现有环境（不给配置文件时）：Nexus nxs-beine1013 上的「九安审核AI（PoC）」
EXISTING = Target(origin='https://nxs-beine1013.tinyboat.blog', profile='beine1013', agent_name=DEFAULTS['AGENT_NAME'],
                  display_name=DEFAULTS['AGENT_DISPLAY_NAME'], model=DEFAULTS['AGENT_MODEL'], agent_id='agent_56d44dd9350f4a568bca387319e12ae4',
                  publication_id='pub_5c53e70d8dc7ddea', connector_id='conn-f0c7233959d9')


def target_from(env_path):
    if not env_path:
        return EXISTING
    values = read_deploy_env(env_path)
    kb_mode = values.get('KB_MODE', 'pg')
    if kb_mode == 's3vectors':
        missing = [key for key in ('NEXUS_ORIGIN', 'NEXUS_PROFILE', 'RULES_TOOL_DIR', 'KB_S3V_KEY_ID') if not values.get(key)]
        if missing:
            raise ValueError(f"{env_path}：KB_MODE=s3vectors 时没写 {'、'.join(missing)}（NEXUS_ORIGIN 是 Nexus 的地址，NEXUS_PROFILE 是 nexus-ai-operator "
                             '的配置名，RULES_TOOL_DIR 是规则工具导入后的目录名，KB_S3V_KEY_ID 是绑给规则工具的 S3 Vectors 密钥编号）')
    else:
        missing = [key for key in ('NEXUS_ORIGIN', 'NEXUS_PROFILE', 'CONNECTOR_ID') if not values.get(key)]
        if missing:
            raise ValueError(f"{env_path}：没写 {'、'.join(missing)}（NEXUS_ORIGIN 是 Nexus 的地址，NEXUS_PROFILE 是 nexus-ai-operator 的配置名，"
                             'CONNECTOR_ID 是知识库连接器的编号，kb.sh connector 之后从 kb.sh status 抄）')
    return Target(origin=values['NEXUS_ORIGIN'].rstrip('/'), profile=values['NEXUS_PROFILE'],
                  agent_name=values.get('AGENT_NAME', DEFAULTS['AGENT_NAME']), display_name=values.get('AGENT_DISPLAY_NAME', DEFAULTS['AGENT_DISPLAY_NAME']),
                  model=values.get('AGENT_MODEL', DEFAULTS['AGENT_MODEL']), agent_id=values.get('AGENT_ID', ''),
                  publication_id=values.get('PUBLICATION_ID', ''), connector_id=values.get('CONNECTOR_ID', ''),
                  kb_mode=kb_mode, rules_tool_dir=values.get('RULES_TOOL_DIR', ''), kb_key_id=values.get('KB_S3V_KEY_ID', ''))


def select_blocks(text, kb_mode):
    """留 kb_mode 的方式块（去掉标记行），整块删掉另一种；块没成对、嵌套、方式不认识、标记行写错都报 ValueError（带行号）。"""
    if kb_mode not in KB_MODES:
        raise ValueError(f'不认识的知识库方式 {kb_mode!r}（只认 {"、".join(KB_MODES)}）')
    kept, opened = [], None   # opened：(方式, 行号)
    for number, line in enumerate(text.splitlines(keepends=True), start=1):
        bare = line.rstrip('\r\n')
        match = BLOCK.match(bare)
        if not match:
            if LOOKS_LIKE_BLOCK.match(bare):
                raise ValueError(f'提示词第 {number} 行像方式块的标记但写法不对（要单独一行 #<kb:pg> 或 #</kb:pg>）：{bare.strip()}')
            if opened is None or opened[0] == kb_mode:
                kept.append(line)
            continue
        closing, mode = match.groups()
        if mode not in KB_MODES:
            raise ValueError(f'提示词第 {number} 行：不认识的方式块 {mode!r}（只认 {"、".join(KB_MODES)}）')
        if not closing:
            if opened:
                raise ValueError(f'提示词第 {number} 行：#<kb:{mode}> 套在第 {opened[1]} 行的 #<kb:{opened[0]}> 里（方式块不能嵌套）')
            opened = (mode, number)
        elif not opened or opened[0] != mode:
            raise ValueError(f'提示词第 {number} 行：#</kb:{mode}> 前面没有对应的 #<kb:{mode}>')
        else:
            opened = None
    if opened:
        raise ValueError(f'提示词第 {opened[1]} 行的 #<kb:{opened[0]}> 没有结束标记 #</kb:{opened[0]}>')
    return ''.join(kept)


def render_prompt(text, target):
    text = select_blocks(text, target.kb_mode)
    values = {'AGENT_NAME': target.agent_name, 'AGENT_MODEL': target.model}
    if target.kb_mode == 'pg':
        values['CONNECTOR_ID'] = target.connector_id
    else:
        values['RULES_TOOL_DIR'] = target.rules_tool_dir

    def value(match):
        name = match.group(1)
        if name in MODE_ONLY and MODE_ONLY[name] != target.kb_mode:
            raise ValueError(f'提示词里的 ${{{name}}} 只能写在 #<kb:{MODE_ONLY[name]}> 块里（现在是 {target.kb_mode} 方式）')
        if name not in values:
            raise ValueError(f'提示词里有不认识的占位符 ${{{name}}}（只认 {"、".join(values)}）')
        if not values[name]:
            raise ValueError(f'提示词里的 ${{{name}}} 没有值：检查环境配置')
        return values[name]
    rendered = PLACEHOLDER.sub(value, text)
    if '${' in rendered:
        raise ValueError('提示词替换后还留着 ${：检查占位符的写法')
    return rendered


def nexus(method, path, params=(), body=None, write=False, dry_run=False, *, target, query=(), missing_ok=False):
    """经 nexus-ai-operator 调一次 Nexus 接口：params 是路径参数（-p），query 是查询参数（-q）；写操作 dry_run 时只打印，不调；
    missing_ok 时接口回 404 就返回 None（例如发布还没有动态配置）。"""
    args = [sys.executable, str(NEXUS), '--profile', target.profile, '--json', 'call', method, path]
    for item in params:
        args += ['-p', item]
    for item in query:
        args += ['-q', item]
    with tempfile.NamedTemporaryFile('w', suffix='.json', encoding='utf-8') as data:
        if body is not None:
            json.dump(body, data, ensure_ascii=False)
            data.flush()
            args += ['--data-file', data.name]
        if write:
            args += ['--dry-run'] if dry_run else ['--yes']
        done = subprocess.run(args, capture_output=True, text=True, timeout=120)
    if done.returncode != 0:
        if missing_ok:
            try:
                if json.loads(done.stdout).get('status') == 404:
                    return None
            except (ValueError, AttributeError):
                pass
        raise SystemExit(f'{method} {path} 失败（退出码 {done.returncode}）：{done.stderr.strip()[:600]}')
    if write and dry_run:
        print(f'[dry-run] {method} {path}')
        return None
    payload = json.loads(done.stdout)
    return payload.get('data', payload) if isinstance(payload, dict) else payload
