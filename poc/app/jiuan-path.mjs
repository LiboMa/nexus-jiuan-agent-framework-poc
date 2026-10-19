/**
 * 九安开发包在哪里。本机默认指向 audit-nexus/source/ 下解压的开发包；EC2 上由 JIUAN_CODE_DIR 指到构件里的副本。
 * 开发包只读引用，PoC 不修改其中任何文件。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const JIUAN_CODE_DIR = path.resolve(process.env.JIUAN_CODE_DIR
  || path.join(here, '../../source/审核平台-测试环境开发包-v0.5.3/code'));
export const JIUAN_PUBLIC_DIR = path.join(JIUAN_CODE_DIR, 'public');
