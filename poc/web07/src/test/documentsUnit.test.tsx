import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { render, screen } from '@testing-library/react';
import { parseApprovalPath } from '../documents/approvalPath';
import { OVERRIDE_REASONS, REASON_LABELS, amountText, basisTag, customRulesOwner, stripCustomRulesNote } from '../api/documents';
import { Pill } from '../ui/Pill';

describe('parseApprovalPath(note)', () => {
  it('reads 「适用审批路径：…；最终审批人：…」 the way the review Agent writes the rule note', () => {
    expect(parseApprovalPath('适用审批路径：部门负责人 → 财务经理 → 分管副总裁；最终审批人：分管副总裁；核对：付款金额超过合同约定')).toEqual({
      path: '部门负责人 → 财务经理 → 分管副总裁', finalApprover: '分管副总裁',
    });
    expect(parseApprovalPath('适用审批路径：部门负责人 → 总经理；最终审批人：总经理')).toEqual({ path: '部门负责人 → 总经理', finalApprover: '总经理' });
    // 前面有别的话、半角标点也认
    expect(parseApprovalPath('按虚构规则 R-07。适用审批路径: 部门负责人 → 财务经理; 最终审批人: 财务经理。')).toEqual({ path: '部门负责人 → 财务经理', finalApprover: '财务经理' });
  });

  it('returns null when it cannot read both parts — no guessing', () => {
    for (const note of ['', '付款金额超过合同约定', '适用审批路径：部门负责人 → 财务经理', '最终审批人：总经理', '适用审批路径：；最终审批人：总经理', '适用审批路径：部门负责人；最终审批人：', '适用审批路径：  ；最终审批人：总经理']) {
      expect(parseApprovalPath(note)).toBeNull();
    }
    expect(parseApprovalPath(undefined as unknown as string)).toBeNull();
  });
});

describe('basis tags', () => {
  it('rule with 「自定义：」 → 我的规则 (own tone, the title after the prefix); other rule → 公司制度; field → 单据字段; evidence → 原件', () => {
    expect(basisTag({ kind: 'rule', ref: '自定义：运维费须附验收单（虚构）' })).toEqual({ label: '我的规则', tone: 'own', title: '运维费须附验收单（虚构）' });
    expect(basisTag({ kind: 'rule', ref: 'R-07 虚构付款审批 · 柯顿 · 10–20 万' })).toEqual({ label: '公司制度', tone: 'info', title: 'R-07 虚构付款审批 · 柯顿 · 10–20 万' });
    expect(basisTag({ kind: 'field', ref: '收款方' })).toEqual({ label: '单据字段', tone: 'neutral', title: '收款方' });
    expect(basisTag({ kind: 'evidence', ref: '虚构合同.pdf' })).toEqual({ label: '原件', tone: 'neutral', title: '虚构合同.pdf' });
  });

  it('reads the 「（含 X 的自定义规则）」 opening of the advice note', () => {
    expect(customRulesOwner('（含 审核员 的自定义规则）付款金额超过合同约定。')).toBe('审核员');
    expect(customRulesOwner('（含 poc-reviewer 的自定义规则）')).toBe('poc-reviewer');
    expect(customRulesOwner('付款金额超过合同约定。（含 审核员 的自定义规则）')).toBeNull();
    expect(customRulesOwner('')).toBeNull();
    expect(stripCustomRulesNote('（含 审核员 的自定义规则）付款金额超过合同约定。')).toBe('付款金额超过合同约定。');
  });
});

describe('override reasons', () => {
  it('mirror the shell exactly, per direction (poc/app07/reviews.mjs)', () => {
    // Vitest 在 poc/web07 里跑；外壳的 reviews.mjs 在旁边的 poc/app07
    // 外壳在 Vite 的项目根（poc/web07）之外，Vite 不让导入：请 Node 自己导入它、把值打印出来
    const where = pathToFileURL(path.resolve(process.cwd(), '../app07/reviews.mjs')).href;
    const printed = execFileSync(process.execPath, ['--input-type=module', '-e',
      `const m = await import(${JSON.stringify(where)}); process.stdout.write(JSON.stringify(m.OVERRIDE_REASONS));`], { encoding: 'utf8' });
    expect(OVERRIDE_REASONS).toEqual(JSON.parse(printed));
  });

  it('every code has the Chinese label of spec §9', () => {
    expect(REASON_LABELS).toEqual({
      contract_covers: '合同或补充协议已涵盖', evidence_complete: '原件齐全 AI 没识别', amount_ok: '金额核对无误', rule_not_applicable: '适用规则不对',
      evidence_missing: '原件缺失或不符', amount_mismatch: '金额不符', payee_mismatch: '收款方不符', other: '其他',
    });
  });
});

describe('amounts', () => {
  it('group thousands and keep two decimals; ¥ for CNY', () => {
    expect(amountText(128500, 'CNY')).toBe('¥128,500.00');
    expect(amountText('52340.18', 'CNY')).toBe('¥52,340.18');
    expect(amountText('9800.5', 'USD')).toBe('USD 9,800.50');
    expect(amountText(null, 'CNY')).toBe('金额未读到');
  });
});

// 12–13 px 的状态文字要 ≥ 4.5:1（Ruling T5a）；基础色只给图形。
const css = readFileSync(path.resolve(process.cwd(), 'src/styles.css'), 'utf8');
const token = (name: string) => css.match(new RegExp(`--color-${name}:\\s*(#[0-9A-Fa-f]{6})`))?.[1];
const luminance = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255).map(c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

describe('status text inks (T5a)', () => {
  it('the -ink tokens exist with the ruled values and pass 4.5:1 on white and on their light backgrounds', () => {
    expect(token('pass-ink')).toBe('#0B7A55');
    expect(token('fail-ink')).toBe('#C4373C');
    expect(token('wait-ink')).toBe('#9A6312');
    expect(token('pass')).toBe('#0E9F6E');
    expect(token('fail')).toBe('#E5484D');
    for (const tone of ['pass', 'fail', 'wait']) {
      expect(contrast(token(`${tone}-ink`)!, '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token(`${tone}-ink`)!, token(`${tone}-50`)!)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('Pill writes its status words in the -ink colour, the border stays the light tint', () => {
    render(<><Pill tone="pass">建议通过</Pill><Pill tone="fail">不建议通过</Pill><Pill tone="wait">审核中</Pill></>);
    expect(screen.getByText('建议通过').closest('[data-tone]')!.className).toMatch(/\btext-pass-ink\b/);
    expect(screen.getByText('不建议通过').closest('[data-tone]')!.className).toMatch(/\btext-fail-ink\b/);
    expect(screen.getByText('审核中').closest('[data-tone]')!.className).toMatch(/\btext-wait-ink\b/);
  });
});
