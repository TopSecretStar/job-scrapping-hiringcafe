// Runs inside hiringcafe.com pages (page context), but ONLY in tabs opened by the extension
// (URL contains js_scrape=1). Records the JSON responses the site's own code fetches, so the
// extension can read the job data instead of parsing HTML. Does nothing during normal browsing.
(() => {
  const FLAG = 'job-scrapper-active';
  const active = location.search.includes('js_scrape=1') || sessionStorage.getItem(FLAG) === '1';
  if (!active) return;
  sessionStorage.setItem(FLAG, '1');

  const store = (window.__jobScrapperCaptured = []);
  const record = (url, requestBody, text) => {
    try {
      store.push({ url: String(url), requestBody: requestBody ?? null, data: JSON.parse(text) });
    } catch {}
  };

  const origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const res = await origFetch.apply(this, arguments);
    try {
      if ((res.headers.get('content-type') || '').includes('json')) {
        const url = typeof input === 'string' ? input : input?.url;
        const body = typeof init?.body === 'string' ? init.body : null;
        res.clone().text().then((t) => record(url, body, t)).catch(() => {});
      }
    } catch {}
    return res;
  };

  const open = XMLHttpRequest.prototype.open;
  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__jsUrl = url;
    return open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    this.addEventListener('load', () => {
      try {
        if ((this.getResponseHeader('content-type') || '').includes('json')) {
          record(this.__jsUrl, typeof body === 'string' ? body : null, this.responseText);
        }
      } catch {}
    });
    return send.apply(this, arguments);
  };
})();
