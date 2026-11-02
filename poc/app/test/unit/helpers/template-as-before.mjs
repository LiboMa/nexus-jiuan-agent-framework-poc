import assert from 'node:assert/strict';

// 模板里经 SSH 管理的几处（KeyName、根卷大小、Name 标签、SSM 托管策略、安全组说明、SshIngress 和 EC2 Instance Connect 端点那三个资源），按参数的默认值还原成原来的文字。
// 默认参数下（现有的栈）这几处和原来一字不差：还原后再和原来的模板比，就知道实例、角色、安全组都不会变。
export function asBefore(text) {
  return [
    ['      KeyName: !If [HasKeyName, !Ref KeyName, !Ref AWS::NoValue]\n', ''],
    ['VolumeSize: !Ref RootVolumeSize', 'VolumeSize: 16'],
    ['{ Key: Name, Value: !Ref AWS::StackName }', '{ Key: Name, Value: andon-finance-poc }'],
    ["      ManagedPolicyArns: !If\n        - UseSsm\n        - [!Sub 'arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore']\n        - !Ref AWS::NoValue\n",
      "      ManagedPolicyArns:\n        - !Sub 'arn:${AWS::Partition}:iam::aws:policy/AmazonSSMManagedInstanceCore'\n"],
    ['      # SSH is a separate rule (SshIngress); the description only changes when it exists, so stacks without SSH keep their security group.\n'
      + '      GroupDescription: !If\n        - SshEnabled\n        - andon-finance PoC - app port only from the CloudFront origin-facing prefix list; SSH from SshAllowedCidr\n'
      + '        - andon-finance PoC - app port only from the CloudFront origin-facing prefix list; no SSH\n',
      '      GroupDescription: andon-finance PoC - app port only from the CloudFront origin-facing prefix list; no SSH\n'],
  ].reduce((out, [from, to]) => { assert.ok(out.includes(from), `模板里要有：${from.slice(0, 60)}`); return out.replace(from, to); }, text)
    .replace(/\n\n  SshIngress:\n[\s\S]*?(?=\n\n  KbBedrockPolicy:)/, '');
}
