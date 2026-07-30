/**
 * Pre-hydration boot watchdog.
 *
 * The server renders a splash (logo + spinner) and everything else waits for
 * ~300 KB of JavaScript. On a weak connection that download can take tens of
 * seconds, and until it lands the app is a spinner with no explanation — the
 * "it stays outside, I have to open it three times" complaint. Worse, when the
 * device has no internet at all the splash is *still* what you get, because the
 * "you're offline" banner is itself part of the JavaScript that never arrived.
 *
 * So this runs as plain inline script, before any bundle: if the app hasn't
 * signalled that it booted within BOOT_WARN_MS, reveal a message that names the
 * real problem (offline vs. slow) and offers a retry. Deliberately dependency-
 * free and inert once the app is alive.
 */

export const BOOT_WARN_MS = 7000;

/** Markup for the warning. Hidden until the script below reveals it. */
export const BOOT_WATCHDOG_HTML = `
<div style="max-width:22rem;margin:0 auto;display:flex;flex-direction:column;align-items:center;gap:10px;text-align:center">
  <div style="font-size:2.5rem;line-height:1">📡</div>
  <div id="hm-boot-title" style="font-weight:800;font-size:1.1rem">Still loading…</div>
  <div id="hm-boot-msg" style="font-size:.88rem;line-height:1.55;opacity:.75">
    Hamar Mall is taking longer than usual to open. Your connection may be slow.
  </div>
  <button type="button" onclick="location.reload()"
    style="margin-top:6px;padding:11px 24px;border:0;border-radius:10px;background:#1257e5;color:#fff;font:inherit;font-weight:700;cursor:pointer">
    Try again
  </button>
</div>`;

/**
 * Inline script. Defines window.__hmBoot() — which AppShell calls once React is
 * running — and arms the timer that reveals the warning if it never comes.
 */
export const BOOT_WATCHDOG_SCRIPT = `(function(){
  var W = ${BOOT_WARN_MS};
  var el = function(){ return document.getElementById('hm-boot-warn'); };
  var timer = setTimeout(function(){
    var box = el(); if (!box || window.__hmBooted) return;
    if (navigator.onLine === false) {
      var t = document.getElementById('hm-boot-title');
      var m = document.getElementById('hm-boot-msg');
      if (t) t.textContent = 'No internet connection';
      if (m) m.textContent = 'Check your mobile data or Wi-Fi, then try again.';
    }
    box.style.display = 'flex';
  }, W);
  window.__hmBoot = function(){
    window.__hmBooted = true;
    clearTimeout(timer);
    var box = el(); if (box) box.style.display = 'none';
  };
  // A connection returning while we're stuck is the clearest retry signal there is.
  window.addEventListener('online', function(){ if (!window.__hmBooted) location.reload(); });
})();`;
