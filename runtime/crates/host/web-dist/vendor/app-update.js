/* app-update.js - release banner for zip-distributed users.
 * Dev trees have no /vendor/manifest.json -> fetch 404 -> this script stays silent.
 * The "update" button calls POST /api/self/update; the host asks scripts/update_check.py
 * to download + verify the newer zip release, then performs the handover. */
(function () {
  function vercmp(a, b) {
    var x = String(a || '').split('.').map(Number), y = String(b || '').split('.').map(Number);
    for (var i = 0; i < 3; i++) { var d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
    return 0;
  }
  function show(cur, latest, note) {
    var bar = document.createElement('div');
    bar.id = 'rsi-update-banner';
    bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:#2563eb;color:#fff;padding:8px 14px;font:13px/1.5 system-ui,sans-serif;display:flex;gap:14px;align-items:center;box-shadow:0 2px 8px rgba(0,0,0,.25)';
    var msg = document.createElement('span');
    msg.textContent = (note || '') + '  新版本 v' + latest + ' 可用（当前 v' + cur + '）';
    var btn = document.createElement('button');
    btn.textContent = '立即更新';
    btn.style.cssText = 'background:#fff;color:#1d4ed8;border:0;border-radius:4px;padding:4px 12px;cursor:pointer;font-weight:600';
    btn.onclick = function () {
      btn.disabled = true; btn.textContent = '下载中…（页面会短暂断开并自动重连）';
      fetch('/api/self/update', { method: 'POST' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        btn.textContent = '已开始更新，正在重启…';
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = '触发失败：' + e.message;
      });
    };
    var later = document.createElement('a');
    later.href = '#'; later.textContent = '稍后'; later.style.cssText = 'color:#dbeafe';
    later.onclick = function (e) { e.preventDefault(); bar.remove(); };
    bar.appendChild(msg); bar.appendChild(btn); bar.appendChild(later);
    document.body.appendChild(bar);
  }
  function init() {
    fetch('/vendor/manifest.json').then(function (r) { return r.ok ? r.json() : null; }).then(function (m) {
      if (!m || !m.version) return;
      fetch('https://api.github.com/repos/zh2673-git/rsi-agent/releases/latest').then(function (r) { return r.json(); }).then(function (j) {
        var lv = String(j && j.tag_name || '').replace(/^v/, '');
        var hasZip = (j.assets || []).some(function (a) { return /\.zip$/i.test(a.name); });
        if (lv && hasZip && vercmp(lv, m.version) > 0) show(m.version, lv);
      });
    }).catch(function () { /* offline or dev tree: stay silent */ });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
