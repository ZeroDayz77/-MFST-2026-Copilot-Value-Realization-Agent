// First-run onboarding tour. Self-contained: builds its own modal, auto-opens
// once per browser (localStorage), and wires the header "?" Help button to
// reopen on demand. Loaded as a module on every page.

const STORAGE_KEY = 'valueiq_onboarded_v1';
const BASE = new URL('../assets/onboarding/', import.meta.url).href;

const STEPS = [
  {
    img: '01-dashboard.png',
    title: 'Welcome to Value IQ',
    body: 'Your AI command center for Microsoft 365 Copilot accounts. The trained models score and rank every lead by expansion potential, then the AI builds a sales playbook for each one — so you always know who to work and why.',
  },
  {
    img: '02-intake.png',
    title: 'Add leads with AI',
    body: 'On <strong>Add Leads</strong>, paste a prompt and/or drop a file (CSV, JSON, or text). The AI parses it, fills any missing Copilot metrics, can generate net-new prospects, and the models score &amp; rank everything automatically. Or enter a single account by hand.',
  },
  {
    img: '03-lead-detail.png',
    title: 'Open a lead’s AI playbook',
    body: 'Click any lead to open its drawer: model scores and priority, ROI and net value, a plain-English summary, the recommended next action, a ready-to-edit outreach email, and the <strong>source links</strong> the AI used — so every claim is verifiable.',
  },
  {
    img: '04-autopilot.png',
    title: 'Autopilot &amp; safe outreach',
    body: 'Flip <strong>Autopilot</strong> on and pick how much control the AI has — Manual, Approval, or Auto. It drafts and queues outreach for you. Emails stay in a mock outbox until the send gate is explicitly enabled, so <strong>nothing leaves your tenant by default</strong>.',
  },
];

let root = null;
let index = 0;

function markSeen() {
  try { localStorage.setItem(STORAGE_KEY, '1'); } catch { /* ignore */ }
}
function hasSeen() {
  try { return localStorage.getItem(STORAGE_KEY) === '1'; } catch { return false; }
}

function build() {
  root = document.createElement('div');
  root.className = 'ob-overlay';
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  root.setAttribute('aria-label', 'Value IQ product tour');
  root.innerHTML = `
    <div class="ob-card">
      <button class="ob-close" type="button" aria-label="Close tour">✕</button>
      <div class="ob-shot"><img class="ob-img" alt="" /></div>
      <div class="ob-body">
        <div class="ob-step">Step <span class="ob-step-n">1</span> of ${STEPS.length}</div>
        <h2 class="ob-title"></h2>
        <p class="ob-text"></p>
        <div class="ob-dots"></div>
        <div class="ob-nav">
          <button class="btn btn-ghost btn-sm ob-skip" type="button">Skip tour</button>
          <div class="ob-nav-right">
            <button class="btn btn-ghost btn-sm ob-prev" type="button">Back</button>
            <button class="btn btn-primary btn-sm ob-next" type="button">Next</button>
          </div>
        </div>
      </div>
    </div>`;

  root.querySelector('.ob-dots').innerHTML = STEPS
    .map((_, i) => `<button class="ob-dot" type="button" data-i="${i}" aria-label="Go to step ${i + 1}"></button>`)
    .join('');

  root.addEventListener('click', (e) => {
    if (e.target === root) close();
  });
  root.querySelector('.ob-close').addEventListener('click', close);
  root.querySelector('.ob-skip').addEventListener('click', close);
  root.querySelector('.ob-prev').addEventListener('click', () => go(index - 1));
  root.querySelector('.ob-next').addEventListener('click', () => {
    if (index >= STEPS.length - 1) close();
    else go(index + 1);
  });
  root.querySelectorAll('.ob-dot').forEach((d) =>
    d.addEventListener('click', () => go(Number(d.dataset.i))),
  );

  document.body.appendChild(root);
}

function render() {
  const step = STEPS[index];
  const img = root.querySelector('.ob-img');
  img.src = BASE + step.img;
  img.alt = step.title.replace(/&amp;/g, '&');
  root.querySelector('.ob-title').innerHTML = step.title;
  root.querySelector('.ob-text').innerHTML = step.body;
  root.querySelector('.ob-step-n').textContent = String(index + 1);

  root.querySelectorAll('.ob-dot').forEach((d, i) =>
    d.classList.toggle('active', i === index),
  );

  const prev = root.querySelector('.ob-prev');
  prev.disabled = index === 0;
  prev.style.visibility = index === 0 ? 'hidden' : 'visible';
  root.querySelector('.ob-next').textContent = index >= STEPS.length - 1 ? 'Get started' : 'Next';
}

function go(i) {
  index = Math.max(0, Math.min(STEPS.length - 1, i));
  render();
}

function onKey(e) {
  if (!root || !root.classList.contains('open')) return;
  if (e.key === 'Escape') close();
  else if (e.key === 'ArrowRight') { if (index < STEPS.length - 1) go(index + 1); }
  else if (e.key === 'ArrowLeft') { if (index > 0) go(index - 1); }
}

export function openOnboarding(startAt = 0) {
  if (!root) build();
  go(startAt);
  root.classList.add('open');
  document.body.classList.add('ob-lock');
  document.addEventListener('keydown', onKey);
}

function close() {
  markSeen();
  if (!root) return;
  root.classList.remove('open');
  document.body.classList.remove('ob-lock');
  document.removeEventListener('keydown', onKey);
}

function wireHelp() {
  const help = document.getElementById('helpBtn');
  if (help) help.addEventListener('click', () => openOnboarding(0));
  if (!hasSeen()) openOnboarding(0);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', wireHelp);
} else {
  wireHelp();
}

export default { openOnboarding };
