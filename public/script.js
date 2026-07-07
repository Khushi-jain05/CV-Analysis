const form = document.getElementById('review-form');
const submitBtn = document.getElementById('submit-btn');
const loading = document.getElementById('loading');
const errorEl = document.getElementById('error');
const candidateEl = document.getElementById('candidate');
const resultEl = document.getElementById('result');

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  errorEl.style.display = 'none';
  candidateEl.style.display = 'none';
  candidateEl.innerHTML = '';
  resultEl.style.display = 'none';
  resultEl.textContent = '';
  loading.style.display = 'flex';
  submitBtn.disabled = true;

  const formData = new FormData(form);

  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      body: formData,
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || 'Something went wrong.');
    }

    const candidate = data.candidate || {};
    const rows = [
      ['Name', candidate.name],
      ['Email', candidate.email],
      ['Phone', candidate.phone],
    ].filter(([, value]) => Boolean(value));

    if (rows.length > 0) {
      candidateEl.innerHTML = rows
        .map(([label, value]) => `<div class="candidate-row"><strong>${label}:</strong> ${escapeHtml(value)}</div>`)
        .join('');
      candidateEl.style.display = 'block';
    }

    resultEl.textContent = data.result;
    resultEl.style.display = 'block';
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.style.display = 'block';
  } finally {
    loading.style.display = 'none';
    submitBtn.disabled = false;
  }
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
