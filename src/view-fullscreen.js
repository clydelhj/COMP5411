(function setupFullscreen() {
  'use strict';

  const root = document.documentElement;
  const button = document.querySelector('#fullscreen-button');
  const message = document.querySelector('#fullscreen-message');
  const icon = button.querySelector('path');
  const enterIcon = icon.getAttribute('d');
  const exitIcon = 'M3 8h5V3m13 5h-5V3M3 16h5v5m13-5h-5v5';
  const supported = document.fullscreenEnabled && typeof root.requestFullscreen === 'function' && typeof document.exitFullscreen === 'function';
  let pending = false;
  let messageTimeout;

  function sync() {
    const active = document.fullscreenElement === root;
    const action = active ? 'Exit full screen' : 'Enter full screen';
    button.setAttribute('aria-label', action);
    button.title = supported ? action : 'Full screen is unavailable in this browser or window';
    icon.setAttribute('d', active ? exitIcon : enterIcon);
  }

  button.disabled = !supported;
  sync();
  document.addEventListener('fullscreenchange', sync);
  button.addEventListener('click', async event => {
    if (pending) return;
    pending = true;
    clearTimeout(messageTimeout);
    message.textContent = '';
    try {
      if (document.fullscreenElement === root) await document.exitFullscreen();
      else await root.requestFullscreen();
      const focusTarget = event.detail ? document.querySelector('#viewport canvas') : button;
      focusTarget?.focus({ preventScroll: true });
    } catch {
      message.textContent = 'The browser could not switch full-screen mode.';
      messageTimeout = setTimeout(() => { message.textContent = ''; }, 5000);
    } finally {
      pending = false;
      sync();
    }
  });
})();
