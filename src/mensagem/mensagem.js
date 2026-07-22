// Página "Mensagem do professor" (show_message com popup:true, ext >= 0.4.8).
// Texto chega em ?m=<b64url(JSON {de, corpo})> — gerado pelo service worker.

function lerMensagem() {
  try {
    const b64 = new URLSearchParams(location.search).get('m') ?? '';
    const json = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(decodeURIComponent(escape(json)));
  } catch {
    return null;
  }
}

const msg = lerMensagem();
if (msg?.de) {
  document.getElementById('titulo').textContent = `Mensagem do professor — ${msg.de}`;
}
document.getElementById('corpo').textContent = msg?.corpo ?? '';

document.getElementById('btn-ok').addEventListener('click', async () => {
  // Página de extensão tem chrome.tabs: fecha a própria aba.
  const tab = await chrome.tabs.getCurrent();
  if (tab?.id != null) chrome.tabs.remove(tab.id);
  else window.close();
});
