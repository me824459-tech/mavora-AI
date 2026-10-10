import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const IS_TEST = process.env.NODE_ENV === 'test';
const DATA = IS_TEST && process.env.TEST_DATA_DIR ? process.env.TEST_DATA_DIR : path.join(ROOT, 'data');
const JOBS_FILE = path.join(DATA, 'jobs.json');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][\w]*)\s*=\s*(.*)\s*$/);
    if (!match || Object.prototype.hasOwnProperty.call(process.env, match[1])) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}
loadEnv(path.join(ROOT, '.env'));

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const HF_KEY = process.env.HF_API_KEY || '';
const HF_BASE = (process.env.HF_API_BASE_URL || 'https://api.higgsfield.ai').replace(/\/$/, '');
const MAX_PER_HOUR = Number(process.env.MAX_GENERATIONS_PER_HOUR || 6);
if (!Number.isInteger(PORT) || PORT < 0 || PORT > 65535) throw new Error('Invalid PORT');
if (!Number.isInteger(MAX_PER_HOUR) || MAX_PER_HOUR < 1) throw new Error('Invalid MAX_GENERATIONS_PER_HOUR');
// Public access is allowed without APP_PASSWORD. Keep the API key server-side.
if (!HF_BASE.startsWith('https://') && !IS_TEST) throw new Error('HF_API_BASE_URL must use HTTPS');

let jobs = [];
try { jobs = JSON.parse(fs.readFileSync(JOBS_FILE, 'utf8')); if (!Array.isArray(jobs)) jobs = []; }
catch { jobs = []; }
let saveQueue = Promise.resolve();
function saveJobs() {
  // Serialize overlapping writes and replace atomically.
  saveQueue = saveQueue.catch(() => {}).then(async () => {
    await fsp.mkdir(DATA, { recursive: true });
    const tmp = JOBS_FILE + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(jobs.slice(0, 100), null, 2), { mode: 0o600 });
    await fsp.rename(tmp, JOBS_FILE);
  });
  return saveQueue;
}

function send(res, code, data, headers = {}) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store', ...headers,
  });
  res.end(JSON.stringify(data));
}
function fail(res, code, message) { send(res, code, { error: message }); }
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // Same-origin regular requests may omit Origin.
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
function cookieValue(req, name) {
  const match = (req.headers.cookie || '').split(';').map(x => x.trim()).find(x => x.startsWith(name + '='));
  return match ? match.slice(name.length + 1) : '';
}
const sessions = new Map();
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const failedLogins = new Map();
function authenticated(req) {
  if (!APP_PASSWORD) return true;
  const sid = cookieValue(req, 'mavora_sid');
  if (!sid) return false;
  const expire = sessions.get(sid);
  if (!expire) return false;
  if (expire < Date.now()) { sessions.delete(sid); return false; }
  return true;
}
function equalSecret(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
function parseJson(req, maxBytes = 100_000) {
  return collectBytes(req, maxBytes).then(buffer => {
    try { return JSON.parse(buffer.toString('utf8')); }
    catch { throw Object.assign(new Error('فرمت اطلاعات نامعتبر است.'), { statusCode: 400 }); }
  });
}
async function collectBytes(req, maxBytes) {
  const pieces = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) throw Object.assign(new Error('حجم فایل یا درخواست بیش از حد مجاز است.'), { statusCode: 413 });
    pieces.push(chunk);
  }
  return Buffer.concat(pieces);
}
function isWebUrl(raw) {
  try { const u = new URL(raw); return u.protocol === 'https:' && !!u.hostname; }
  catch { return false; }
}
function cleanJob(job) {
  return {
    id: job.id, status: job.status, mode: job.mode, prompt: job.prompt,
    duration: job.duration, resolution: job.resolution, aspectRatio: job.aspectRatio,
    imageUrl: job.imageUrl || null, videoUrl: job.videoUrl || null,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
    error: job.error || null,
  };
}
async function provider(method, route, body) {
  if (!HF_KEY) throw Object.assign(new Error('کلید API تنظیم نشده است. فایل .env را کامل کن.'), { statusCode: 503 });
  let response;
  try {
    response = await fetch(`${HF_BASE}${route}`, {
      method,
      headers: { Authorization: `Key ${HF_KEY}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
      redirect: 'error',
    });
  } catch {
    throw Object.assign(new Error('ارتباط با سرور Higgsfield برقرار نشد؛ اینترنت و سرویس را بررسی کن.'), { statusCode: 502 });
  }
  const raw = await response.text();
  let payload = {};
  try { payload = raw ? JSON.parse(raw) : {}; } catch { /* upstream non-JSON */ }
  if (!response.ok) {
    const upstreamMsg = payload?.detail?.message || payload?.detail || payload?.error?.message || payload?.message;
    const summary = typeof upstreamMsg === 'string' ? upstreamMsg.slice(0, 350) : 'پاسخ سرویس ناموفق بود.';
    throw Object.assign(new Error(`خطای سرویس (${response.status}): ${summary}`), { statusCode: response.status === 429 ? 429 : 502 });
  }
  return payload;
}
async function uploadReference(req) {
  const mime = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(mime)) {
    throw Object.assign(new Error('فقط فایل JPG، PNG یا WebP قابل قبول است.'), { statusCode: 400 });
  }
  const bytes = await collectBytes(req, 10 * 1024 * 1024);
  if (bytes.length < 20) throw Object.assign(new Error('فایل تصویر خالی یا نامعتبر است.'), { statusCode: 400 });
  const valid = (mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')))
    || (mime === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8)
    || (mime === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP');
  if (!valid) throw Object.assign(new Error('محتوای فایل با نوع تصویر مطابقت ندارد.'), { statusCode: 400 });
  const signed = await provider('POST', '/files/generate-upload-url', { content_type: mime });
  if (!isWebUrl(signed.upload_url) || !isWebUrl(signed.public_url) || typeof signed.upload_headers !== 'object' || !signed.upload_headers) {
    throw Object.assign(new Error('پاسخ آپلود Higgsfield کامل نبود.'), { statusCode: 502 });
  }
  let put;
  try {
    put = await fetch(signed.upload_url, {
      method: 'PUT', headers: signed.upload_headers, body: bytes,
      signal: AbortSignal.timeout(60000), redirect: 'error',
    });
  } catch { throw Object.assign(new Error('آپلود تصویر به فضای ذخیره‌سازی انجام نشد.'), { statusCode: 502 }); }
  if (!put.ok) throw Object.assign(new Error(`آپلود تصویر ناموفق بود (${put.status}).`), { statusCode: 502 });
  return signed.public_url;
}
async function startGeneration(body) {
  const mode = body.mode === 'image' ? 'image' : body.mode === 'text' ? 'text' : null;
  if (!mode) throw Object.assign(new Error('نوع ساخت ویدیو نامعتبر است.'), { statusCode: 400 });
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
  if (prompt.length > 2500 || (mode === 'text' && !prompt)) {
    throw Object.assign(new Error('توضیحات ویدیو را وارد کن (حداکثر ۲۵۰۰ نویسه).'), { statusCode: 400 });
  }
  const duration = Number(body.duration || 5);
  const resolution = body.resolution || '720p';
  const aspectRatio = body.aspectRatio || '16:9';
  if (![5, 8, 10, 15].includes(duration)) throw Object.assign(new Error('زمان ویدیو معتبر نیست.'), { statusCode: 400 });
  if (!['480p', '720p', '1080p', '4k'].includes(resolution)) throw Object.assign(new Error('کیفیت ویدیو معتبر نیست.'), { statusCode: 400 });
  if (!['16:9', '9:16', '1:1', '4:3', '3:4'].includes(aspectRatio)) throw Object.assign(new Error('نسبت تصویر معتبر نیست.'), { statusCode: 400 });
  const audio = body.audio === true;
  const model = `bytedance/seedance-2.0/${mode === 'text' ? 'text-to-video' : 'image-to-video'}`;
  const payload = { duration, resolution, generate_audio: audio };
  if (prompt) payload.prompt = prompt;
  if (mode === 'text') payload.aspect_ratio = aspectRatio;
  else {
    if (!isWebUrl(body.imageUrl)) throw Object.assign(new Error('ابتدا عکس را بارگذاری کن.'), { statusCode: 400 });
    payload.image_url = body.imageUrl;
  }
  const now = Date.now();
  const recently = jobs.filter(job => now - new Date(job.createdAt).getTime() < 60 * 60 * 1000).length;
  if (recently >= MAX_PER_HOUR) throw Object.assign(new Error(`برای جلوگیری از هزینه ناخواسته، حداکثر ${MAX_PER_HOUR} درخواست در ساعت مجاز است.`), { statusCode: 429 });
  const result = await provider('POST', `/${model}`, payload);
  if (typeof result.request_id !== 'string' || !/^[a-zA-Z0-9-]{8,100}$/.test(result.request_id)) {
    throw Object.assign(new Error('سرویس شناسه درخواست معتبری برنگرداند.'), { statusCode: 502 });
  }
  const job = {
    id: result.request_id, status: result.status || 'queued', mode,
    prompt, duration, resolution, aspectRatio: mode === 'text' ? aspectRatio : null,
    imageUrl: mode === 'image' ? body.imageUrl : null,
    videoUrl: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), error: null,
  };
  jobs.unshift(job);
  jobs = jobs.slice(0, 100);
  await saveJobs();
  return job;
}
async function refreshJob(job) {
  if (['failed', 'canceled', 'nsfw'].includes(job.status) || (job.status === 'completed' && job.videoUrl)) return job;
  const result = await provider('GET', `/requests/${encodeURIComponent(job.id)}/status`);
  job.status = typeof result.status === 'string' ? result.status : job.status;
  job.updatedAt = new Date().toISOString();
  if (job.status === 'completed' && isWebUrl(result.video?.url)) job.videoUrl = result.video.url;
  if (job.status === 'failed' || job.status === 'nsfw') job.error = typeof result.error === 'string' ? result.error.slice(0, 300) : null;
  await saveJobs();
  return job;
}

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon' };
async function staticFile(req, res, pathname) {
  let requestPath;
  try { requestPath = decodeURIComponent(pathname); } catch { fail(res, 400, 'Invalid path'); return; }
  const filePath = path.resolve(PUBLIC, '.' + (requestPath === '/' ? '/index.html' : requestPath));
  if (!filePath.startsWith(PUBLIC + path.sep)) { fail(res, 403, 'Forbidden'); return; }
  let stat;
  try { stat = await fsp.stat(filePath); } catch { fail(res, 404, 'Not found'); return; }
  if (!stat.isFile()) { fail(res, 404, 'Not found'); return; }
  const ext = path.extname(filePath);
  if (!MIME[ext]) { fail(res, 404, 'Not found'); return; }
  res.writeHead(200, { 'Content-Type': `${MIME[ext]}; charset=utf-8`, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
  fs.createReadStream(filePath).pipe(res);
}

export const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; img-src 'self' https: data: blob:; media-src 'self' https: blob:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method !== 'GET' && !checkOrigin(req)) return fail(res, 403, 'درخواست از یک مبدأ دیگر مجاز نیست.');
    if (u.pathname === '/api/session' && req.method === 'GET') {
      return send(res, 200, { authenticated: authenticated(req), configured: authenticated(req) && !!HF_KEY, appName: 'MAVORA AI' });
    }
    if (u.pathname === '/api/login' && req.method === 'POST') {
      if (!APP_PASSWORD) return send(res, 200, { ok: true });
      const ip = req.socket.remoteAddress || 'unknown';
      const attempts = (failedLogins.get(ip) || []).filter(t => Date.now() - t < LOGIN_WINDOW_MS);
      if (attempts.length >= 8) return fail(res, 429, 'تلاش‌های زیاد؛ کمی بعد دوباره امتحان کن.');
      const body = await parseJson(req, 5000);
      if (!equalSecret(String(body.password || ''), APP_PASSWORD)) {
        attempts.push(Date.now()); failedLogins.set(ip, attempts);
        return fail(res, 401, 'رمز ورود اشتباه است.');
      }
      failedLogins.delete(ip);
      const sid = crypto.randomBytes(32).toString('hex');
      sessions.set(sid, Date.now() + 7 * 24 * 3600000);
      const secure = req.socket.encrypted || req.headers['x-forwarded-proto'] === 'https';
      return send(res, 200, { ok: true }, { 'Set-Cookie': `mavora_sid=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure ? '; Secure' : ''}` });
    }
    if (u.pathname === '/api/logout' && req.method === 'POST') {
      sessions.delete(cookieValue(req, 'mavora_sid'));
      return send(res, 200, { ok: true }, { 'Set-Cookie': 'mavora_sid=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
    }
    if (u.pathname.startsWith('/api/')) {
      if (!authenticated(req)) return fail(res, 401, 'ابتدا وارد حساب مدیر شو.');
      if (u.pathname === '/api/jobs' && req.method === 'GET') return send(res, 200, { jobs: jobs.map(cleanJob) });
      if (u.pathname === '/api/upload' && req.method === 'POST') {
        if (!HF_KEY) return fail(res, 503, 'کلید API هنوز تنظیم نشده است.');
        const imageUrl = await uploadReference(req);
        return send(res, 200, { imageUrl });
      }
      if (u.pathname === '/api/generate' && req.method === 'POST') {
        const body = await parseJson(req);
        const job = await startGeneration(body);
        return send(res, 202, { job: cleanJob(job) });
      }
      const match = u.pathname.match(/^\/api\/jobs\/([\w-]+)(\/cancel)?$/);
      if (match) {
        const job = jobs.find(j => j.id === match[1]);
        if (!job) return fail(res, 404, 'ویدیو پیدا نشد.');
        if (req.method === 'GET' && !match[2]) return send(res, 200, { job: cleanJob(await refreshJob(job)) });
        if (req.method === 'POST' && match[2]) {
          if (job.status !== 'queued') return fail(res, 409, 'فقط درخواست در صف قابل لغو است.');
          await provider('POST', `/requests/${encodeURIComponent(job.id)}/cancel`);
          const updated = await refreshJob(job);
          return send(res, 200, { job: cleanJob(updated) });
        }
      }
      return fail(res, 404, 'مسیر API پیدا نشد.');
    }
    if (req.method !== 'GET') return fail(res, 405, 'Method not allowed');
    return await staticFile(req, res, u.pathname);
  } catch (e) {
    const statusCode = e.statusCode || 500;
    if (statusCode === 500) console.error('Server error:', e?.message);
    return fail(res, statusCode, statusCode === 500 ? 'خطای داخلی سرور رخ داد.' : e.message);
  }
});

if (process.env.NO_LISTEN !== '1') {
  server.listen(PORT, HOST, () => console.log(`MAVORA AI ready at http://${HOST}:${server.address().port} | Higgsfield API: ${HF_KEY ? 'configured' : 'not configured'}`));
}
