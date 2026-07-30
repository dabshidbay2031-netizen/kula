/**
 * Inline script that catches `beforeinstallprompt`.
 *
 * Chrome fires this event once, shortly after load, and if nothing calls
 * `preventDefault()` on it the opportunity is gone — you cannot ask for it
 * again. On a slow connection our React bundle routinely isn't running yet when
 * it arrives, so the Install button had nothing to fire and fell back to
 * "here's how to do it by hand" even on browsers that could have done it in one
 * tap.
 *
 * Parking the event on `window` from the document head removes the race:
 * lib/installApp.ts picks it up whenever it happens to start.
 */
export const INSTALL_CAPTURE_SCRIPT = `(function(){
  window.addEventListener('beforeinstallprompt', function(e){
    e.preventDefault();
    window.__hmInstallEvent = e;
  });
  window.addEventListener('appinstalled', function(){ window.__hmInstallEvent = null; });
})();`;
