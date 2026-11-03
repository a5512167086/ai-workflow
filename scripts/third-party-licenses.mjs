#!/usr/bin/env node
// 產生 src-tauri/licenses/THIRD_PARTY_LICENSES.txt：安裝包裡實際帶著的第三方套件與它們的授權全文。
//   Rust：Windows 目標的執行期依賴（不含 build、dev 依賴與 proc-macro，它們不會進執行檔）。
//   npm：package-lock.json 裡非 dev 的套件（打包進前端的上限）。
// 每個套件附上自己的 LICENSE／NOTICE／COPYING 檔；授權文字完全相同的套件合併成一段。
// 用法：node scripts/third-party-licenses.mjs          產生檔案
//       node scripts/third-party-licenses.mjs --check  內容過期時失敗（CI 用）
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outFile = path.join(root, 'src-tauri', 'licenses', 'THIRD_PARTY_LICENSES.txt');
const LICENSE_FILE = /^(licen[cs]e|copying|notice|copyright|unlicense)([-._ ].*)?$/i;
const COPYLEFT = /\b(EPL|MPL|LGPL|GPL|CDDL|EUPL|OSL)\b/;

const normalize = (text) => text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();

function licenseFiles(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => LICENSE_FILE.test(n) && fs.statSync(path.join(dir, n)).isFile())
    .sort()
    .map((n) => ({ name: n, text: normalize(fs.readFileSync(path.join(dir, n), 'utf8')) }));
}

function mitText(holders) {
  return normalize(`MIT License

Copyright (c) ${holders || 'the authors'}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`);
}

function bsd3Text(holders) {
  return normalize(`BSD 3-Clause License

Copyright (c) ${holders || 'the authors'}

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its
   contributors may be used to endorse or promote products derived from
   this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.`);
}

/** 套件沒有附授權檔時：MIT 用作者產生授權文字，其他授權指向 SPDX 的標準全文（本檔最後也附了 Apache-2.0 全文）。 */
function fallbackText(pkg) {
  const holders = pkg.authors.join(', ');
  if (/^BSD-3-Clause$/.test(pkg.license)) return `(The package ships no license file; the BSD-3-Clause text below uses the package's declared authors.)\n\n${bsd3Text(holders)}`;
  if (/\bMIT\b/.test(pkg.license)) return `(The package ships no license file; the MIT text below uses the package's declared authors.)\n\n${mitText(holders)}`;
  return `(The package ships no license file.) License: ${pkg.license || 'see repository'}${holders ? `\nAuthors: ${holders}` : ''}\nStandard license texts: https://spdx.org/licenses/`;
}

// ---------- Rust ----------
function rustPackages() {
  // 授權檔在下載下來的 crate 原始碼裡；乾淨的 CI 環境要先下載（已經有就不做事）。
  execFileSync('cargo', ['fetch', '--locked', '--manifest-path', path.join(root, 'src-tauri', 'Cargo.toml')], { stdio: 'ignore' });
  const meta = JSON.parse(execFileSync('cargo', ['metadata', '--format-version', '1', '--locked', '--manifest-path', path.join(root, 'src-tauri', 'Cargo.toml'), '--filter-platform', 'x86_64-pc-windows-msvc'], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }));
  const byId = new Map(meta.packages.map((p) => [p.id, p]));
  const nodes = new Map(meta.resolve.nodes.map((n) => [n.id, n]));
  const isProcMacro = (p) => p.targets.some((t) => t.kind.includes('proc-macro'));
  const seen = new Set();
  const queue = [meta.resolve.root];
  while (queue.length) {
    const id = queue.shift();
    for (const dep of nodes.get(id)?.deps || []) {
      if (!dep.dep_kinds.some((k) => k.kind === null)) continue; // 只看一般依賴（不含 build、dev）
      const pkg = byId.get(dep.pkg);
      if (!pkg || isProcMacro(pkg) || seen.has(dep.pkg)) continue; // proc-macro 只在編譯時執行，不會進執行檔
      seen.add(dep.pkg);
      queue.push(dep.pkg);
    }
  }
  return [...seen].map((id) => byId.get(id)).filter((p) => p.source).map((p) => ({
    ecosystem: 'Rust crate',
    name: p.name,
    version: p.version,
    license: p.license || (p.license_file ? `see ${p.license_file}` : ''),
    repository: p.repository || p.homepage || `https://crates.io/crates/${p.name}`,
    authors: (p.authors || []).map((a) => a.replace(/\s*<[^>]*>/, '').trim()).filter(Boolean),
    files: licenseFiles(path.dirname(p.manifest_path)),
  }));
}

// ---------- npm ----------
function npmPackages() {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const out = [];
  for (const [key, entry] of Object.entries(lock.packages || {})) {
    if (!key || entry.dev || entry.devOptional || entry.link) continue;
    const dir = path.join(root, key);
    const manifest = path.join(dir, 'package.json');
    if (!fs.existsSync(manifest)) continue; // 沒安裝的平台專屬套件
    const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
    const person = (p) => (typeof p === 'string' ? p.replace(/\s*[<(][^>)]*[>)]/g, '').trim() : p?.name);
    out.push({
      ecosystem: 'npm package',
      name: pkg.name || key.replace(/^.*node_modules\//, ''),
      version: pkg.version || entry.version || '',
      license: typeof pkg.license === 'string' ? pkg.license : pkg.license?.type || (pkg.licenses || []).map((l) => l.type).join(' OR ') || entry.license || '',
      repository: (repo || pkg.homepage || `https://www.npmjs.com/package/${pkg.name}`).replace(/^git\+/, '').replace(/\.git$/, ''),
      authors: [pkg.author, ...(pkg.contributors || [])].map(person).filter(Boolean),
      files: licenseFiles(dir),
    });
  }
  return out;
}

// ---------- 輸出 ----------
function render(packages) {
  const key = (p) => `${p.ecosystem}\u0000${p.name}\u0000${p.version}`;
  const unique = [...new Map(packages.map((p) => [key(p), p])).values()]
    .sort((a, b) => a.ecosystem.localeCompare(b.ecosystem) || a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true }));
  const groups = new Map();
  for (const p of unique) {
    const text = p.files.length ? p.files.map((f) => (p.files.length > 1 ? `--- ${f.name} ---\n${f.text}` : f.text)).join('\n\n') : fallbackText(p);
    if (!groups.has(text)) groups.set(text, []);
    groups.get(text).push(p);
  }
  const copyleft = unique.filter((p) => COPYLEFT.test(p.license));
  const mpl = unique.flatMap((p) => p.files).find((f) => /^Mozilla Public License Version 2\.0/.test(f.text));
  const apache = unique.flatMap((p) => p.files).find((f) => /^Apache License\s+Version 2\.0/.test(f.text) && f.text.length > 9000);
  const line = '='.repeat(78);
  const parts = [
    'ai-workflow — third-party software licenses',
    '',
    'ai-workflow is licensed under the MIT License (see LICENSE.txt). The installer and the',
    'application include the third-party components listed below. Each component is used',
    'under its own license, reproduced here. Code adapted into ai-workflow\'s own source',
    '(for example the built-in skills) is credited in THIRD_PARTY_NOTICES.txt.',
    '',
    `Components: ${unique.length} (${unique.filter((p) => p.ecosystem === 'Rust crate').length} Rust crates, ${unique.filter((p) => p.ecosystem === 'npm package').length} npm packages).`,
    'This file is generated by scripts/third-party-licenses.mjs; do not edit it by hand.',
  ];
  if (copyleft.length) {
    parts.push('', 'Components under file-level copyleft licenses are included unmodified. Their', 'source code is available from:');
    for (const p of copyleft) parts.push(`  - ${p.name} ${p.version} (${p.license}): ${p.repository}`);
  }
  for (const [text, list] of groups) {
    parts.push('', line);
    for (const p of list) parts.push(`${p.name} ${p.version} — ${p.ecosystem} — ${p.license || 'license not declared'} — ${p.repository}`);
    parts.push(line, '', text);
  }
  if (mpl) parts.push('', line, 'Standard text: Mozilla Public License, Version 2.0 (referenced above as MPL-2.0)', line, '', mpl.text);
  if (apache) parts.push('', line, 'Standard text: Apache License, Version 2.0 (referenced above as Apache-2.0)', line, '', apache.text);
  return parts.join('\n') + '\n';
}

const text = render([...rustPackages(), ...npmPackages()]);
if (process.argv.includes('--check')) {
  const current = fs.existsSync(outFile) ? normalize(fs.readFileSync(outFile, 'utf8')) + '\n' : '';
  if (current !== text) {
    console.error('src-tauri/licenses/THIRD_PARTY_LICENSES.txt is out of date. Run: npm run licenses');
    process.exit(1);
  }
  console.log('Third-party licenses are up to date.');
} else {
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, text);
  console.log(`Wrote ${path.relative(root, outFile)} (${(text.length / 1024).toFixed(0)} KB)`);
}
