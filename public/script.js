const form = document.getElementById('review-form');
const submitBtn = document.getElementById('submit-btn');
const loading = document.getElementById('loading');
const errorEl = document.getElementById('error');
const resultEl = document.getElementById('result');

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  errorEl.style.display = 'none';
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
