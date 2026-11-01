'use strict';

let diagramRuntime = null, diagramQueue = Promise.resolve(), diagramSerial = 0;
function loadDiagramRuntime() {
  if (window.mermaid) return Promise.resolve(window.mermaid);
  if (!diagramRuntime) diagramRuntime = new Promise((resolve, reject) => {
    const script = document.createElement('script'); script.src = 'vendor/mermaid.min.js';
    script.onload = () => resolve(window.mermaid);
    script.onerror = () => { diagramRuntime = null; script.remove(); reject(new Error('離線圖表元件未載入，仍可複製下方 Mermaid 原始碼')); };
    document.head.append(script);
  });
  return diagramRuntime;
}

function renderChatMarkdown(host, text) {
  host.innerHTML = typeof window.renderMarkdown === 'function' ? window.renderMarkdown(text) : `<pre>${escapeHtml(text)}</pre>`;
  const jobs = [];
  for (const block of $$('pre.md-code[data-lang="mermaid"]', host).slice(0, 8)) {
    const source = block.querySelector('code').textContent;
    const figure = document.createElement('figure'); figure.className = 'chat-diagram';
    const preview = document.createElement('div'); preview.className = 'diagram-preview'; preview.textContent = '正在繪製圖表…';
    const tools = document.createElement('figcaption'); tools.className = 'diagram-tools';
    const copy = document.createElement('button'); copy.type = 'button'; copy.textContent = '複製 Mermaid';
    copy.onclick = async () => { try { await navigator.clipboard.writeText(source); toast('已複製圖表原始碼'); } catch { toast('無法複製，請展開原始碼自行選取', true); } };
    tools.append(document.createTextNode('架構／流程圖'), copy);
    const raw = document.createElement('details'); raw.className = 'diagram-source';
    raw.innerHTML = '<summary>Mermaid 原始碼</summary>';
    block.replaceWith(figure); raw.append(block); figure.append(preview, tools, raw);
    const render = async () => {
      try {
        if (source.length > 30000 || /%%\s*\{|^\s*---/m.test(source)) throw new Error('圖表過大或含自訂設定，請使用下方原始碼');
        const mermaid = await loadDiagramRuntime();
        const dark = getTheme() === 'dark' || getTheme() === 'system' && !!window.matchMedia?.('(prefers-color-scheme: dark)')?.matches;
        mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', suppressErrorRendering: true, theme: dark ? 'dark' : 'default', fontFamily: 'Segoe UI, Microsoft JhengHei, sans-serif', flowchart: { htmlLabels: false }, maxTextSize: 30000 });
        const id = `chat-diagram-${++diagramSerial}`;
        const { svg } = await mermaid.render(id, source);
        if (!figure.isConnected) return;
        preview.innerHTML = svg;
        const download = document.createElement('a'); download.className = 'btn'; download.textContent = '下載 SVG'; download.download = `architecture-${diagramSerial}.svg`;
        download.href = '#';
        download.onclick = () => { const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' })); download.href = url; setTimeout(() => URL.revokeObjectURL(url), 60000); };
        tools.append(download);
      } catch (error) {
        preview.textContent = `圖表無法預覽：${error.message || error}`; preview.classList.add('hint'); raw.open = true;
      }
    };
    const job = diagramQueue.then(render); diagramQueue = job.catch(() => {}); jobs.push(job);
  }
  return Promise.allSettled(jobs);
}
