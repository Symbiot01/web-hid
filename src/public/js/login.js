'use strict';

(function () {
  const form = document.getElementById('login-form');
  const passwordEl = document.getElementById('password');
  const errorEl = document.getElementById('login-error');
  const btn = document.getElementById('login-btn');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.hidden = true;
    errorEl.textContent = '';
    btn.disabled = true;
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ password: passwordEl.value }),
      });
      if (!res.ok) {
        errorEl.textContent = 'Invalid password';
        errorEl.hidden = false;
        btn.disabled = false;
        return;
      }
      window.location.assign('/app');
    } catch {
      errorEl.textContent = 'Login failed';
      errorEl.hidden = false;
      btn.disabled = false;
    }
  });
})();
