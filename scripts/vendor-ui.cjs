const fs = require('node:fs');
const path = require('node:path');
const source = path.dirname(require.resolve('mermaid/package.json'));
const target = path.resolve(__dirname, '../src/vendor');
fs.mkdirSync(target, { recursive: true });
fs.copyFileSync(path.join(source, 'dist/mermaid.min.js'), path.join(target, 'mermaid.min.js'));
fs.copyFileSync(path.join(source, 'LICENSE'), path.join(target, 'MERMAID-LICENSE.txt'));
console.log(`Bundled Mermaid ${require(path.join(source, 'package.json')).version} for offline diagrams.`);
