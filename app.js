'use strict';

const $ = id => document.getElementById(id);
const state = { mode: 'text', configured: false, authenticated: true, loading: false, imageFile: null, imageObjectUrl: null, jobs: [], selectedId: null, filter: 'all', timer: null };
const prompts = {
  car: 'A cinematic low-angle tracking shot of a matte black supercar racing across a golden desert road at sunset. Clouds of dust, realistic reflections, anamorphic lens flares, smooth camera movement, photorealistic, dramatic lighting.',
  fashion: 'Editorial fashion film: a stylish model in a flowing sculptural silk outfit walks through a minimalist architectural studio. Fabric moves naturally in a soft breeze, slow-motion dolly shot, elegant shadows, luxury campaign aesthetic, 35mm film look.',
  nature: 'An astronaut stands on a violet alien ocean under a giant luminous planet. Mist flows over the water, the camera slowly pushes forward, ethereal reflections, grand cinematic scale, atmospheric science-fiction film, ultra-detailed.',
  city: 'A rain-soaked futuristic city at night, glowing signs in magenta and cobalt, a lone figure walking through reflections on wet pavement. Slow cinematic crane shot, drifting fog, moody lighting, realistic depth of field, immersive atmosphere.'
};
const terminal = new Set(['completed', 'failed', 'nsfw', 'canceled']);
const statusLabels = { queued: 'در صف انتظار', in_progress: 'در حال تولید', processing: 'در حال پردازش', completed: 'آماده‌شده', failed: 'ناموفق', nsfw: 'ردشده', canceled: 'لغوشده' };

async function api(url, options = {}) {
  const res = await fetch(url, { credentials: 'same-origin', ...options });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && url !== '/api/login') showLogin();
    throw new Error(data.error || `خطای ${res.status}`);
  }
  return data;
}
function escapeHtml(input) { return String(input ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
function safeMedia(url) { try { const u = new URL(url); return u.protocol === 'https:' ? u.href : null; } catch { return null; } }
function alertUser(text, error = false) {
  const toast = $('toast');
  toast.textContent = text; toast.classList.toggle('error', error); toast.hidden = false;
  clearTimeout(alertUser.timeout); alertUser.timeout = setTimeout(() => toast.hidden = true, 5600);
}
function setMode(mode) {
  state.mode = mode;
  $('textMode').classList.toggle('active', mode === 'text');
  $('imageMode').classList.toggle('active', mode === 'image');
  $('textMode').setAttribute('aria-selected', String(mode === 'text'));
  $('imageMode').setAttribute('aria-selected', String(mode === 'image'));
  $('uploadField').hidden = mode !== 'image';
  $('ratioField').hidden = mode === 'image';
  $('promptRequired').hidden = mode === 'image';
  $('prompt').required = mode === 'text';
  $('prompt').placeholder = mode === 'text'
    ? 'مثلاً: یک ماشین اسپرت مشکی زیر باران در خیابان‌های توکیو، نورهای نئون روی آسفالت منعکس می‌شوند، حرکت دوربین سینمایی...'
    : 'مثلاً: دوربین به‌آرامی به سوژه نزدیک شود، موها در باد حرکت کنند، نور طبیعی و حرکت سینمایی... (اختیاری)';
}
function usePreset(key) {
  if (!prompts[key]) return;
  setMode('text'); $('prompt').value = prompts[key]; updateCount();
  $('studio').scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => $('prompt').focus({ preventScroll: true }), 350);
  alertUser('ایده انتخاب شد. می‌توانی آن را تغییر بدهی.');
}
function updateCount() { $('charCount').textContent = `${$('prompt').value.length} / 2500`; }
function selectFile(file) {
  if (!file) return;
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) return alertUser('فقط JPG، PNG یا WebP قابل قبول است.', true);
  if (file.size > 10 * 1024 * 1024) return alertUser('حجم عکس باید کمتر از ۱۰ مگابایت باشد.', true);
  if (state.imageObjectUrl) URL.revokeObjectURL(state.imageObjectUrl);
  state.imageObjectUrl = URL.createObjectURL(file);
  state.imageFile = file;
  $('imagePreview').src = state.imageObjectUrl;
  $('imagePreview').hidden = false;
  $('uploadPlaceholder').hidden = true;
  $('selectedFile').textContent = `${file.name} · ${(file.size / 1024 / 1024).toFixed(1)} MB`;
  $('selectedFile').hidden = false;
}
function showSetup() { $('setupModal').hidden = false; $('closeSetup').focus(); }
function hideSetup() { $('setupModal').hidden = true; }
function showLogin() { state.authenticated = false; $('loginModal').hidden = false; setTimeout(() => $('password').focus(), 50); }
function hideLogin() { $('loginModal').hidden = true; $('password').value = ''; $('loginError').textContent = ''; }
function showPreview(job) {
  state.selectedId = job?.id || null;
  for (const id of ['previewEmpty', 'previewLoading', 'previewDone', 'previewError']) $(id).hidden = true;
  $('cancelBtn').hidden = true; $('openVideoBtn').hidden = true;
  const badge = $('previewStatus'); badge.classList.remove('done', 'error');
  const player = $('videoPlayer');
  if (!job) {
    $('previewEmpty').hidden = false; player.removeAttribute('src'); player.load();
    badge.lastChild.textContent = ' آماده شروع';
    $('previewSubtitle').textContent = 'هنوز ویدیویی ساخته نشده است';
    $('previewDescription').textContent = 'نتیجهٔ تولید اینجا نمایش داده می‌شود.';
    return;
  }
  const label = statusLabels[job.status] || 'در حال بررسی';
  badge.lastChild.textContent = ` ${label}`;
  if (job.status === 'completed') badge.classList.add('done');
  if (['failed', 'nsfw', 'canceled'].includes(job.status)) badge.classList.add('error');
  $('previewSubtitle').textContent = `${job.mode === 'image' ? 'عکس به ویدیو' : 'متن به ویدیو'} · ${job.duration} ثانیه · ${job.resolution}`;
  $('previewDescription').textContent = job.prompt ? (job.prompt.length > 110 ? `${job.prompt.slice(0, 110)}…` : job.prompt) : 'متحرک‌سازی عکس انتخاب‌شده';
  const video = safeMedia(job.videoUrl);
  if (job.status === 'completed' && video) {
    $('previewDone').hidden = false;
    if (player.src !== video) player.src = video;
    $('openVideoBtn').href = video; $('openVideoBtn').hidden = false;
  } else if (terminal.has(job.status)) {
    player.removeAttribute('src'); player.load();
    $('previewError').hidden = false;
    $('errorMessage').textContent = job.status === 'nsfw' ? 'این درخواست توسط سیستم بررسی محتوا رد شد.' : job.status === 'canceled' ? 'درخواست لغو شد.' : (job.error || 'نتیجه قابل دریافت نیست. دوباره امتحان کن.');
  } else {
    player.removeAttribute('src'); player.load();
    $('previewLoading').hidden = false;
    $('loadingTitle').textContent = job.status === 'queued' ? 'ویدیو در صف ساخت است...' : 'هوش مصنوعی در حال ساخت ویدیوست...';
    $('loadingText').textContent = 'ساخت واقعی بسته به شلوغی سرویس زمان می‌برد. وضعیت در آرشیو هم ذخیره شده است.';
    $('cancelBtn').hidden = job.status !== 'queued';
  }
}
function renderLibrary() {
  const all = state.jobs;
  $('jobCount').textContent = `${all.length.toLocaleString('fa-IR')} پروژه`;
  let items = all;
  if (state.filter === 'completed') items = all.filter(j => j.status === 'completed');
  if (state.filter === 'active') items = all.filter(j => !terminal.has(j.status));
  const root = $('libraryItems');
  if (!items.length) {
    root.innerHTML = `<div class="empty-library"><span>▧</span><strong>${all.length ? 'پروژه‌ای با این وضعیت وجود ندارد' : 'هنوز پروژه‌ای ثبت نشده'}</strong><p>${all.length ? 'فیلتر دیگری را انتخاب کن.' : 'اولین ویدیوی خودت را از استودیو بساز.'}</p><a href="#studio">برو به استودیو ←</a></div>`;
    return;
  }
  root.innerHTML = items.map(job => {
    const mode = job.mode === 'image' ? 'عکس به ویدیو' : 'متن به ویدیو';
    const thumb = safeMedia(job.imageUrl);
    const video = safeMedia(job.videoUrl);
    const media = thumb ? `<img src="${escapeHtml(thumb)}" loading="lazy" alt="تصویر ورودی پروژه">` : '<span class="job-placeholder">M✦</span>';
    const date = new Date(job.createdAt);
    const dateText = Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('fa-IR');
    return `<article class="job-card"><div class="job-thumb">${media}<span class="job-icon">${escapeHtml(mode)}</span></div><div class="job-meta"><p title="${escapeHtml(job.prompt || 'متحرک‌سازی عکس')}">${escapeHtml(job.prompt || 'متحرک‌سازی عکس')}</p><div class="job-info"><span>${escapeHtml(dateText)} · ${escapeHtml(job.duration)}s</span><span class="job-status ${escapeHtml(job.status)}">● ${escapeHtml(statusLabels[job.status] || job.status)}</span></div><div class="job-links"><button type="button" data-view="${escapeHtml(job.id)}">مشاهده جزئیات</button>${video ? `<a href="${escapeHtml(video)}" target="_blank" rel="noopener noreferrer">باز کردن ویدیو ↖</a>` : ''}${!terminal.has(job.status) ? `<button type="button" data-update="${escapeHtml(job.id)}">بررسی وضعیت ↻</button>` : ''}</div></div></article>`;
  }).join('');
}
function upsertJob(job) {
  const pos = state.jobs.findIndex(j => j.id === job.id);
  if (pos >= 0) state.jobs[pos] = job;
  else state.jobs.unshift(job);
  state.jobs.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  renderLibrary();
  if (state.selectedId === job.id) showPreview(job);
}
async function refreshOne(id, silent = false) {
  try {
    const { job } = await api(`/api/jobs/${encodeURIComponent(id)}`);
    const oldStatus = state.jobs.find(j => j.id === id)?.status;
    upsertJob(job);
    if (!silent && job.status === 'completed' && oldStatus !== 'completed') alertUser('ویدیوی شما آماده شد!');
    return job;
  } catch (e) { if (!silent) alertUser(e.message, true); return null; }
}
function startPolling() {
  if (state.timer) clearInterval(state.timer);
  state.timer = setInterval(async () => {
    if (document.hidden || !state.authenticated || !state.configured) return;
    const active = state.jobs.filter(j => !terminal.has(j.status)).slice(0, 8);
    for (const job of active) await refreshOne(job.id, false);
  }, 6500);
}
async function loadJobs() {
  if (!state.authenticated) return;
  try {
    const data = await api('/api/jobs');
    state.jobs = Array.isArray(data.jobs) ? data.jobs : [];
    renderLibrary();
    if (state.selectedId) {
      const selected = state.jobs.find(j => j.id === state.selectedId);
      if (selected) showPreview(selected);
    }
  } catch (e) { alertUser(e.message, true); }
}
function setConnectionLabel() {
  const btn = $('apiStatus'); btn.classList.remove('connected', 'disconnected');
  btn.classList.add(state.configured ? 'connected' : 'disconnected');
  $('apiStatusText').textContent = state.configured ? 'موتور آماده است' : 'نیاز به اتصال API';
  $('setupNotice').hidden = state.configured;
}
async function checkSession() {
  if (location.protocol === 'file:') {
    state.configured = false; state.authenticated = true; setConnectionLabel();
    alertUser('این پیش‌نمایش آفلاین است؛ برای تولید ویدیو سرور را اجرا کن.');
    return;
  }
  try {
    const info = await api('/api/session');
    state.authenticated = info.authenticated;
    state.configured = info.configured;
    setConnectionLabel();
    if (!info.authenticated) return showLogin();
    hideLogin();
    await loadJobs(); startPolling();
  } catch {
    state.configured = false; setConnectionLabel();
    alertUser('سرور در دسترس نیست؛ فعلاً فقط پیش‌نمایش سایت را می‌بینی.', true);
  }
}
async function createVideo(evt) {
  evt.preventDefault();
  if (state.loading) return;
  if (!state.authenticated) return showLogin();
  if (!state.configured) return showSetup();
  const prompt = $('prompt').value.trim();
  if (state.mode === 'text' && !prompt) return alertUser('توضیحات صحنه را بنویس.', true);
  if (state.mode === 'image' && !state.imageFile) return alertUser('یک عکس برای متحرک‌سازی انتخاب کن.', true);
  state.loading = true; $('generateBtn').disabled = true;
  const label = $('generateLabel').textContent;
  $('generateLabel').textContent = 'در حال ارسال پروژه...';
  try {
    let imageUrl = undefined;
    if (state.mode === 'image') {
      $('generateLabel').textContent = 'در حال بارگذاری عکس...';
      const response = await api('/api/upload', { method: 'POST', headers: { 'Content-Type': state.imageFile.type }, body: state.imageFile });
      imageUrl = response.imageUrl;
    }
    $('generateLabel').textContent = 'در حال ثبت درخواست ساخت...';
    const payload = { mode: state.mode, prompt, duration: Number($('duration').value), resolution: $('resolution').value, aspectRatio: $('aspectRatio').value, audio: $('audio').checked, ...(imageUrl ? { imageUrl } : {}) };
    const result = await api('/api/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    upsertJob(result.job); showPreview(result.job);
    alertUser('درخواست ساخت ثبت شد. وضعیت را می‌توانی در آرشیو ببینی.');
  } catch (e) { alertUser(e.message, true); }
  finally { state.loading = false; $('generateBtn').disabled = false; $('generateLabel').textContent = label; }
}
async function cancelSelected() {
  if (!state.selectedId) return;
  $('cancelBtn').disabled = true;
  try {
    const { job } = await api(`/api/jobs/${encodeURIComponent(state.selectedId)}/cancel`, { method: 'POST' });
    upsertJob(job); alertUser('درخواست لغو به سرویس ارسال شد.');
  } catch (e) { alertUser(e.message, true); }
  finally { $('cancelBtn').disabled = false; }
}

$('textMode').addEventListener('click', () => setMode('text'));
$('imageMode').addEventListener('click', () => setMode('image'));
$('prompt').addEventListener('input', updateCount);
$('generateForm').addEventListener('submit', createVideo);
$('imageInput').addEventListener('change', event => selectFile(event.target.files?.[0]));
const dz = $('dropzone');
dz.addEventListener('dragenter', e => { e.preventDefault(); dz.classList.add('dragging'); });
dz.addEventListener('dragover', e => { e.preventDefault(); dz.classList.add('dragging'); });
dz.addEventListener('dragleave', e => { e.preventDefault(); dz.classList.remove('dragging'); });
dz.addEventListener('drop', e => { e.preventDefault(); dz.classList.remove('dragging'); selectFile(e.dataTransfer?.files?.[0]); });
document.querySelectorAll('[data-preset]').forEach(btn => btn.addEventListener('click', () => usePreset(btn.dataset.preset)));
document.querySelectorAll('[data-filter]').forEach(btn => btn.addEventListener('click', () => {
  state.filter = btn.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('active', b === btn));
  renderLibrary();
}));
$('libraryItems').addEventListener('click', event => {
  const view = event.target.closest('[data-view]');
  const update = event.target.closest('[data-update]');
  if (view) {
    const job = state.jobs.find(j => j.id === view.dataset.view);
    if (job) { showPreview(job); $('studio').scrollIntoView({ behavior: 'smooth' }); }
  }
  if (update) refreshOne(update.dataset.update);
});
$('refreshLibrary').addEventListener('click', async () => { await loadJobs(); for (const job of state.jobs.filter(j => !terminal.has(j.status)).slice(0, 8)) await refreshOne(job.id); alertUser('آرشیو بروزرسانی شد.'); });
$('cancelBtn').addEventListener('click', cancelSelected);
$('apiStatus').addEventListener('click', showSetup);
$('setupBtn').addEventListener('click', showSetup);
$('closeSetup').addEventListener('click', hideSetup);
$('okSetup').addEventListener('click', hideSetup);
$('setupModal').addEventListener('click', e => { if (e.target === $('setupModal')) hideSetup(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideSetup(); });
$('loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  $('loginError').textContent = '';
  try {
    await api('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('password').value }) });
    await checkSession();
  } catch (err) { $('loginError').textContent = err.message; }
});
setMode('text'); showPreview(null); checkSession();
