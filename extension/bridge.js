// Runs on the Job Scrapper website. Relays messages between the page and the extension.
const VERSION = chrome.runtime.getManifest().version;
const post = (msg) => window.postMessage({ source: 'job-scrapper-ext', ...msg }, location.origin);
const announce = () => post({ type: 'ready', version: VERSION });

announce();
document.addEventListener('DOMContentLoaded', announce);

window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.source !== 'job-scrapper-page') return;
  const msg = e.data;

  if (msg.type === 'ping') return announce();

  if (msg.type === 'search') {
    let finished = false;
    const port = chrome.runtime.connect({ name: 'job-scrapper' });
    port.onMessage.addListener((r) => {
      post(r);
      if (r.type === 'result' || r.type === 'error') {
        finished = true;
        port.disconnect();
      }
    });
    port.onDisconnect.addListener(() => {
      if (!finished) post({ id: msg.id, type: 'error', error: 'The extension stopped unexpectedly. Reload the extension and try again.' });
    });
    port.postMessage({ type: 'search', id: msg.id, params: msg.params });
  }
});
