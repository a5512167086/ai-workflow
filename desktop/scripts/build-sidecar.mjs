// 把 aipipe（bin/aipipe.js + src/ + ui/）打包成單一 exe（Node SEA），給 Tauri 當 sidecar。
// 使用者不需要另外安裝 Node 就能跑 aipipe 本身；claude／codex／task-master 仍是各自安裝的 CLI。
//
// 步驟：esbuild 合併成一個 CJS → node --experimental-sea-config 產生 blob（UI 檔案當 asset 內嵌）
//       → 複製目前的 node.exe → postject 注入 blob。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.resolve(DESKTOP, '..');
const DIST = path.join(DESKTOP, 'dist');
const TRIPLE = 'x86_64-pc-windows-msvc';
const OUT = path.join(DESKTOP, 'src-tauri', 'binaries', `aipipe-sidecar-${TRIPLE}${process.platform === 'win32' ? '.exe' : ''}`);
const UI_FILES = ['index.html', 'overview.html', 'app.js', 'overview.js', 'common.js', 'markdown.js', 'style.css'];

fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(DIST, { recursive: true });
fs.mkdirSync(path.dirname(OUT), { recursive: true });

console.log('1/3 esbuild：合併成 dist/aipipe.cjs');
await build({
  entryPoints: [path.join(ROOT, 'bin', 'aipipe.js')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  outfile: path.join(DIST, 'aipipe.cjs'),
  // CJS 沒有 import.meta；SEA 版的 UI 檔案從內嵌 asset 讀，不會用到這個路徑。
  define: { 'import.meta.url': '__aipipeImportMetaUrl' },
  banner: { js: "const __aipipeImportMetaUrl = require('node:url').pathToFileURL(typeof __filename === 'string' ? __filename : process.execPath).href;" },
  logLevel: 'warning',
});

console.log('2/3 產生 SEA blob（含 UI asset）');
const seaConfig = {
  main: path.join(DIST, 'aipipe.cjs'),
  output: path.join(DIST, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  useCodeCache: false,
  useSnapshot: false,
  assets: Object.fromEntries(UI_FILES.map((f) => [f, path.join(ROOT, 'ui', f)])),
};
fs.writeFileSync(path.join(DIST, 'sea-config.json'), JSON.stringify(seaConfig, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', path.join(DIST, 'sea-config.json')], { stdio: 'inherit' });

console.log(`3/3 注入到 ${path.relative(DESKTOP, OUT)}`);
fs.copyFileSync(process.execPath, OUT);
const postject = path.join(DESKTOP, 'node_modules', 'postject', 'dist', 'cli.js');
execFileSync(process.execPath, [postject, OUT, 'NODE_SEA_BLOB', seaConfig.output, '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'], { stdio: 'inherit' });

// 冒煙測試：exe 要能自己跑 aipipe 的 help。
const help = execFileSync(OUT, ['help'], { encoding: 'utf8' });
if (!help.includes('aipipe')) throw new Error('sidecar exe 執行 help 失敗');
console.log(`完成：${OUT}（${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB）`);
