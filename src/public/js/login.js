'use strict';

(function () {
  const form = document.getElementById('login-form');
  const passwordInput = document.getElementById('password');
  const errorEl = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function clearError() {
    errorEl.hidden = true;
    errorEl.textContent = '';
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearError();
    btn.disabled = true;

    const password = passwordInput.value;

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ password }),
      });

      if (!res.ok) {
        let message = 'Invalid password';
        try {
          const data = await res.json();
          if (data && typeof data.error === 'string') {
            message = data.error;
          }
        } catch {
          // keep default
        }
        showError(message);
        passwordInput.focus();
        passwordInput.select();
        return;
      }

      window.location.assign('/app');
    } catch {
      showError('Unable to reach server');
    } finally {
      btn.disabled = false;
    }
  });
})();
