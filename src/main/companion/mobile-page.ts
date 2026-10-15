/**
 * The phone companion page, served by the companion server. Self-contained (inline CSS/JS
 * under a strict CSP) and display-only: the phone receives pushed answers, explanations and
 * transcript lines; the only thing it ever sends is its own device name.
 *
 * - Remembers the pairing token (localStorage, per host), so a bookmark without the #t= part
 *   keeps working while the desktop keeps the same pairing.
 * - Reconnects on its own with backoff (desktop restarted, WiFi blip, sharing toggled).
 * - De-duplicates the backlog the desktop replays on reconnect (session id + sequence number).
 */
export function mobilePage(opts: { origins: string[]; fingerprint: string; protocol: string }): string {
  const wsOrigins = opts.origins.map((o) => o.replace(/^https:/, 'wss:'));
  const csp = `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src ${[...wsOrigins, ...opts.origins].join(' ')}`;
  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="theme-color" content="#111318">
<title>InviTerminal</title>
<style>
*{box-sizing:border-box}
body{margin:0;font:15px/1.45 system-ui,-apple-system,sans-serif;background:#111318;color:#e6e6e6}
header{position:sticky;top:0;background:#111318ee;backdrop-filter:blur(6px);padding:12px 14px 0;border-bottom:1px solid #23262e;z-index:2}
.top{display:flex;align-items:center;gap:8px}
h1{font-size:16px;margin:0;flex:1}
.dot{width:9px;height:9px;border-radius:50%;background:#ff8a80;display:inline-block;margin-right:6px}
.dot.on{background:#7fd69d}.dot.wait{background:#e6c37f}
#s{font-size:12px;color:#9aa0aa}
.tabs{display:flex;gap:4px;margin-top:10px}
.tab{flex:1;padding:8px;border:0;border-radius:8px 8px 0 0;background:#1a1d24;color:#9aa0aa;font:inherit;font-size:13px}
.tab.on{background:#23262e;color:#fff}
.tab .n{font-size:11px;background:#2e6f9d;color:#fff;border-radius:999px;padding:0 6px;margin-left:4px}
main{padding:10px 14px 80px}
.card{background:#1a1d24;border:1px solid #23262e;border-radius:10px;padding:10px 12px;margin:0 0 10px}
.meta{display:flex;align-items:center;gap:8px;font-size:11px;color:#9aa0aa;text-transform:uppercase;letter-spacing:.03em}
.meta .t{flex:1}
.q{color:#9aa0aa;font-size:13px;margin:6px 0;white-space:pre-wrap;word-break:break-word;border-left:2px solid #33485e;padding-left:8px;max-height:7.5em;overflow:hidden}
.a{white-space:pre-wrap;word-break:break-word}
.copy{border:1px solid #33485e;background:transparent;color:#cfe3ff;border-radius:6px;font:inherit;font-size:12px;padding:3px 9px}
.line{display:flex;gap:8px;padding:5px 0;border-bottom:1px solid #1e2129}
.who{flex:none;min-width:52px;font-size:11px;font-weight:700;color:#7fd69d;text-transform:uppercase;padding-top:2px}
.when{flex:none;font-size:10px;color:#6b717c;padding-top:3px}
.empty{color:#9aa0aa;text-align:center;margin-top:40px;line-height:1.6}
footer{position:fixed;bottom:0;left:0;right:0;background:#111318;border-top:1px solid #23262e;padding:8px 14px;display:flex;gap:8px;align-items:center}
footer input{flex:1;background:#1a1d24;border:1px solid #23262e;border-radius:6px;color:#e6e6e6;font:inherit;font-size:13px;padding:6px 8px}
footer button{border:1px solid #23262e;background:#1a1d24;color:#e6e6e6;border-radius:6px;font:inherit;font-size:13px;padding:6px 10px}
.fp{font-size:10px;color:#6b717c;word-break:break-all;margin:8px 0 10px}
</style></head><body>
<header>
  <div class="top"><h1>InviTerminal</h1><span><span class="dot" id="dot"></span><span id="s">connecting…</span></span></div>
  <div class="fp">cert ${opts.fingerprint}</div>
  <div class="tabs"><button class="tab on" id="tA">Answers<span class="n" id="nA" hidden>0</span></button><button class="tab" id="tT">Transcript<span class="n" id="nT" hidden>0</span></button></div>
</header>
<main>
  <section id="answers"><p class="empty" id="eA">Waiting for the desktop…<br>Answers you ask for (✨ Ask) and explanations (Ctrl+Shift+E) appear here.</p></section>
  <section id="transcript" hidden><p class="empty" id="eT">The live transcript appears here while it is running on the desktop.</p></section>
</main>
<footer><input id="name" maxlength="40" placeholder="Name this device (e.g. Pixel)"><button id="clear">Clear</button></footer>
<script>
(function(){
  var KEY = 'invi.token.' + location.host;
  var fromHash = location.hash.replace(/^#t=/, '');
  if (fromHash) { try { localStorage.setItem(KEY, fromHash); } catch (e) {} history.replaceState(null, '', location.pathname); }
  var token = fromHash; if (!token) { try { token = localStorage.getItem(KEY) || ''; } catch (e) {} }
  var $ = function (id) { return document.getElementById(id); };
  var s = $('s'), dot = $('dot'), answers = $('answers'), transcript = $('transcript');
  var seen = {}, session = null, tab = 'A', unread = { A: 0, T: 0 }, delay = 1000, ws = null, timer = null;
  var nameBox = $('name'); try { nameBox.value = localStorage.getItem('invi.name') || ''; } catch (e) {}

  function state(text, cls) { s.textContent = text; dot.className = 'dot ' + (cls || ''); }
  function badge() { ['A','T'].forEach(function (k) { var n = $('n' + k); n.textContent = unread[k]; n.hidden = !unread[k] || tab === k; }); }
  function show(which) { tab = which; answers.hidden = which !== 'A'; transcript.hidden = which !== 'T'; $('tA').className = 'tab' + (which === 'A' ? ' on' : ''); $('tT').className = 'tab' + (which === 'T' ? ' on' : ''); unread[which] = 0; badge(); }
  $('tA').onclick = function () { show('A'); }; $('tT').onclick = function () { show('T'); };
  function time(at) { try { return new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }
  function copy(text, btn) {
    var done = function () { btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
    function fallback() { var t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); done(); } catch (e) {} t.remove(); }
  }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }

  function addCard(m) {
    $('eA').hidden = true;
    var c = el('div', 'card'), meta = el('div', 'meta');
    meta.appendChild(el('span', 't', (m.title || m.type) + ' · ' + time(m.at)));
    var body = m.type === 'answer' ? m.text : (m.text || '');
    var b = el('button', 'copy', 'Copy'); b.onclick = function () { copy(body, b); }; meta.appendChild(b);
    c.appendChild(meta);
    if (m.question) c.appendChild(el('div', 'q', m.question));
    c.appendChild(el('div', 'a', body));
    answers.insertBefore(c, answers.firstChild);
    if (tab !== 'A') { unread.A++; badge(); }
  }
  function addLine(m) {
    $('eT').hidden = true;
    var r = el('div', 'line');
    r.appendChild(el('span', 'when', time(m.at)));
    if (m.speaker) r.appendChild(el('span', 'who', m.speaker));
    r.appendChild(el('span', 'a', m.text));
    var nearBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 80;
    transcript.appendChild(r);
    while (transcript.querySelectorAll('.line').length > 400) transcript.querySelector('.line').remove();
    if (tab === 'T' && nearBottom) window.scrollTo(0, document.body.scrollHeight);
    if (tab !== 'T') { unread.T++; badge(); }
  }
  function sendName() { if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'name', name: nameBox.value.trim().slice(0, 40) })); }
  nameBox.onchange = function () { try { localStorage.setItem('invi.name', nameBox.value.trim()); } catch (e) {} sendName(); };
  $('clear').onclick = function () { answers.querySelectorAll('.card').forEach(function (c) { c.remove(); }); transcript.querySelectorAll('.line').forEach(function (c) { c.remove(); }); $('eA').hidden = false; $('eT').hidden = false; unread = { A: 0, T: 0 }; badge(); };

  function connect() {
    clearTimeout(timer); timer = null;
    if (ws && ws.readyState <= 1) return; // already connecting/connected — never open a second socket
    if (!token) { state('scan the QR on the desktop to pair', ''); return; }
    state('connecting…', 'wait');
    try { ws = new WebSocket(location.origin.replace('https', 'wss') + '/', ['${opts.protocol}', token]); } catch (e) { return retry(); }
    ws.onopen = function () { delay = 1000; state('paired', 'on'); sendName(); };
    ws.onclose = function (ev) { state(ev.code === 1006 ? 'reconnecting…' : 'disconnected — reconnecting…', 'wait'); retry(); };
    ws.onmessage = function (e) {
      var m; try { m = JSON.parse(e.data); } catch (x) { return; }
      if (m.type === 'hello') { if (m.session !== session) { session = m.session; seen = {}; } return; }
      if (m.seq != null) { if (seen[m.seq]) return; seen[m.seq] = 1; }
      if (m.type === 'transcript') addLine(m); else addCard(m);
    };
  }
  function retry() { clearTimeout(timer); timer = setTimeout(connect, delay); delay = Math.min(delay * 2, 10000); }
  document.addEventListener('visibilitychange', function () { if (!document.hidden) { delay = 1000; connect(); } });
  connect();
})();
</script></body></html>`;
}
