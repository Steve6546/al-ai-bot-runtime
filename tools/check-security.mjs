#!/usr/bin/env node
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const ignored = new Set(['.git', 'node_modules', '.env']);
const secretPatterns = [
  { name: 'private key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/ },
  { name: 'Discord token assignment', re: /DISCORD_TOKEN\s*=\s*(?!your_|<|\$\{|$)[^\s#]+/i },
  { name: 'adapter token assignment', re: /ADAPTER_TOKEN\s*=\s*(?!your_|<|\$\{|$)[^\s#]+/i },
  { name: 'generic secret assignment', re: /(?:API_KEY|API_SECRET|ACCESS_TOKEN|CLIENT_SECRET|PASSWORD)\s*=\s*['"]?[A-Za-z0-9_\-]{24,}/i },
];
const textExtensions = new Set(['.js', '.mjs', '.json', '.md', '.yml', '.yaml', '.txt', '.sh', '.ps1', '.dockerignore', '.gitignore']);
let failures = 0;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (ignored.has(name)) continue;
    const path = join(dir, name);
    const st = statSync(path);
    if (st.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

for (const file of walk(root)) {
  const name = file.split(/[\\/]/).pop();
  const ext = name.includes('.') ? `.${name.split('.').pop()}` : '';
  if (!textExtensions.has(ext) && !['Dockerfile', 'LICENSE'].includes(name)) continue;
  let content;
  try { content = readFileSync(file, 'utf8'); } catch { continue; }
  for (const pattern of secretPatterns) {
    if (pattern.re.test(content)) {
      failures++;
      console.error(`FAIL ${pattern.name}: ${relative(root, file)}`);
    }
  }
}

console.log(failures === 0 ? 'SECURITY CHECK OK — no obvious committed secrets found' : `SECURITY CHECK FAILED — ${failures} finding(s)`);
process.exit(failures === 0 ? 0 : 1);
