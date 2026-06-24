// Minimal toast + button-busy helpers shared across pages.

let container;

function ensureContainer() {
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-stack';
    document.body.appendChild(container);
  }
  return container;
}

export function toast(message, kind = 'info', timeout = 4000) {
  const node = document.createElement('div');
  node.className = `toast toast-${kind}`;
  node.textContent = message;
  ensureContainer().appendChild(node);
  requestAnimationFrame(() => node.classList.add('show'));
  setTimeout(() => {
    node.classList.remove('show');
    setTimeout(() => node.remove(), 250);
  }, timeout);
  return node;
}

// Toggle a button into a loading state and back; returns a restore function.
export function busy(button, label = 'Working…') {
  if (!button) return () => {};
  const original = button.innerHTML;
  const wasDisabled = button.disabled;
  button.disabled = true;
  button.dataset.busy = 'true';
  button.innerHTML = `<span class="spinner"></span> ${label}`;
  return () => {
    button.disabled = wasDisabled;
    delete button.dataset.busy;
    button.innerHTML = original;
  };
}
