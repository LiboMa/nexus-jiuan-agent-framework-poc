# 配方

命令都相对本 Skill 目录；写操作的 `--yes` 只在用户同意了这一步之后才加。

## 登录与连接（第一次）

```bash
python3 scripts/agent_access.py login --origin https://andon-finance.tinyboat.blog --account poc-reviewer --password-stdin --client claude_code --yes <<'EOF'
<用户给的应用口令>
EOF
python3 scripts/agent_access.py status
python3 scripts/agent_access.py nexus connect --yes <<'EOF'
<用户在 Nexus「个人设置 › API 密钥」新建的 API 密钥>
EOF
```

## 新建并启用一个 Agent

1. `nexus-ai-operator`：建 Agent（或复制一个），写好提示词，在平台内试用，建发布并打开 A2A。
2. 用户本人在 Nexus 网页「互联中心 › 对外发布」签发这个发布的调用密钥，交给你。
3. 启用（应用当场验证，默认读一次能力清单，约 0.03 美元）：

   ```bash
   python3 scripts/agent_access.py refresh
   python3 scripts/agent_access.py enable pub_xxxxxxxxxxxxxxxx --key-stdin --yes <<'EOF'
   <调用密钥>
   EOF
   ```
4. 调一次确认能用（约 0.05 美元）：

   ```bash
   python3 scripts/agent_access.py invoke pub_xxxxxxxxxxxxxxxx --task describe --wait --yes
   ```

## 改了 Agent 之后

1. `nexus-ai-operator` 改提示词并更新 Agent。发布开着「跟随最新版本」时立即生效。
2. 重新验证并刷新能力清单（不用新密钥）：`python3 scripts/agent_access.py enable pub_… --yes`
3. 再测一次：`python3 scripts/agent_access.py invoke pub_… --task <任务名> --input '{"…": "…"}' --wait --yes`

## 带附件调用

```bash
python3 scripts/agent_access.py invoke pub_… --text "这张发票的金额和日期是多少？" --attach ./invoice.pdf --wait --yes
```

附件合计不超过 6 MB（这套 Nexus 的请求体上限是 10 MB）。

## 换密钥

用户在 Nexus 上签一把新的 → `enable pub_… --key-stdin --yes`。开发测试阶段不主动吊销旧的。

## 排障

1. `python3 scripts/agent_access.py status --json`
2. 按 `SKILL.md` 第 6 节的退出码处理。
3. 看调用记录：`python3 scripts/agent_access.py runs --limit 5`，再 `python3 scripts/agent_access.py run <编号>` 看错误码和原始返回。
