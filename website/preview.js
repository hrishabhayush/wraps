const preview = document.querySelector('.desktop-preview');
const toggle = preview.querySelector('.preview-toggle');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
let playing = !reducedMotion.matches;

function renderPlayback() {
  preview.classList.toggle('is-playing', playing && !document.hidden);
  toggle.textContent = playing ? 'Pause preview' : 'Play preview';
}

// Start together only after every screen is decoded, so slow loads cannot flash blank.
Promise.all([...preview.querySelectorAll('.desktop-screen')].map(image => image.decode()))
  .then(() => {
    toggle.hidden = false;
    renderPlayback();
    toggle.addEventListener('click', () => {
      playing = !playing;
      renderPlayback();
    });
    reducedMotion.addEventListener('change', () => {
      playing = !reducedMotion.matches;
      renderPlayback();
    });
    document.addEventListener('visibilitychange', renderPlayback);
  })
  .catch(() => { /* Keep the static connected preview if another screen cannot load. */ });
