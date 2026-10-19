/** 读 progress.json、校验、拼出页面状态；实时服务和快照共用。 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveState, validateManifest } from './lib.mjs';

export const ROOT = fileURLToPath(new URL('../../', import.meta.url));   // audit-nexus/
export const MANIFEST = path.join(ROOT, 'progress.json');

export async function loadProject({ root = ROOT, manifestFile = MANIFEST } = {}) {
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestFile, 'utf8')); } catch (error) {
    return { manifest: null, errors: [`progress.json 读不出来：${error.message}`], warnings: [] };
  }
  const { errors, warnings } = validateManifest(manifest, { exists: file => existsSync(path.join(root, file)) });
  return { manifest, errors, warnings };
}

export const composeState = ({ manifest, signals = {}, errors = [], warnings = [] }) =>
  ({ ...deriveState(manifest, signals), problems: { errors, warnings }, generatedAt: new Date().toISOString() });
