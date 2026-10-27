'use strict';
const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const cors = require('cors');
const helmet = require('helmet');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_BYTES = 500 * 1024 * 1024;
const TMP_DIR = path.join(os.tmpdir(), 'status-hd-uploads');
fs.mkdirSync(TMP_DIR, { recursive: true });
app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '*').split(',').map(x => x.trim()).filter(Boolean);
app.use(cors({ origin: (origin, cb) => {
  if (!origin || allowedOrigins.includes('*') || allowedOrigins.includes(origin)) return cb(null, true);
  return cb(new Error('Origin not allowed by CORS'));
}, methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'X-Hub-Signature-256'] }));
app.use(express.json({ limit: '100kb', verify: (req, _res, buf) => { req.rawBody = Buffer.from(buf); } }));

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const VERIFY_TOKEN = process.env.WHATSAPP_VERIFY_TOKEN || '';
const APP_SECRET = process.env.META_APP_SECRET || '';
const EXPECTED_PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const TABLE = 'status_hd_activation_requests';

function normalizePhone(value) { return String(value || '').replace(/\D/g, '').replace(/^00/, ''); }
function dbReady() { return Boolean(SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY); }
async function supabase(pathname, options = {}) {
  if (!dbReady()) throw new Error('Activation database is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.');
  const response = await fetch(`${SUPABASE_URL}/rest/v1/${pathname}`, {
    ...options,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`Database request failed (${response.status}): ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

app.get('/', (_req, res) => res.json({ status: 'ok', service: 'DJ WHISTER 256 Status HD Backend', version: '2.0.0', activation: 'whatsapp-webhook', videoCompression: true }));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Create a short-lived request. A number is not activated until the webhook sees
// the matching code sent from that same WhatsApp number.
app.post('/api/activation/request', async (req, res) => {
  try {
    const phone = normalizePhone(req.body && req.body.phone);
    const nonce = String(req.body && req.body.nonce || '').trim();
    if (phone.length < 9 || phone.length > 15) return res.status(400).json({ error: 'Enter a valid phone number with country code.' });
    if (!/^\d{6}$/.test(nonce)) return res.status(400).json({ error: 'Invalid activation code. Try again.' });
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    await supabase(`${TABLE}?on_conflict=phone,nonce`, {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({ phone, nonce, status: 'pending', expires_at: expiresAt, updated_at: new Date().toISOString() })
    });
    res.json({ ok: true, status: 'pending', expiresInSeconds: 600 });
  } catch (error) {
    console.error('Activation request:', error.message);
    res.status(503).json({ error: 'Activation service is not configured yet. Please try again later.' });
  }
});

app.get('/api/activation/status', async (req, res) => {
  try {
    const phone = normalizePhone(req.query.phone);
    const nonce = String(req.query.nonce || '').trim();
    if (phone.length < 9 || phone.length > 15 || !/^\d{6}$/.test(nonce)) return res.status(400).json({ error: 'Invalid activation lookup.' });
    const rows = await supabase(`${TABLE}?phone=eq.${encodeURIComponent(phone)}&nonce=eq.${encodeURIComponent(nonce)}&select=status,expires_at&limit=1`);
    const row = rows && rows[0];
    if (!row) return res.json({ status: 'not_found' });
    if (row.status !== 'activated' && new Date(row.expires_at).getTime() < Date.now()) return res.json({ status: 'expired' });
    res.json({ status: row.status });
  } catch (error) {
    console.error('Activation status:', error.message);
    res.status(503).json({ error: 'Activation status is temporarily unavailable.' });
  }
});

// Meta webhook subscription verification (GET) and incoming messages (POST).
app.get('/webhooks/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && VERIFY_TOKEN && token === VERIFY_TOKEN) return res.status(200).send(String(challenge || ''));
  return res.sendStatus(403);
});

app.post('/webhooks/whatsapp', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
  try {
    const raw = req.rawBody || (Buffer.isBuffer(req.body) ? req.body : Buffer.from('')); 
    const signature = req.get('x-hub-signature-256') || '';
    if (!APP_SECRET) return res.status(503).send('Webhook secret not configured');
    const expected = 'sha256=' + crypto.createHmac('sha256', APP_SECRET).update(raw).digest('hex');
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return res.sendStatus(401);
    const payload = JSON.parse(raw.toString('utf8'));
    if (payload.object !== 'whatsapp_business_account') return res.sendStatus(404);
    for (const entry of (payload.entry || [])) {
      for (const change of (entry.changes || [])) {
        if (change.field !== 'messages') continue;
        const value = change.value || {};
        const phoneId = String(value.metadata && value.metadata.phone_number_id || '');
        if (EXPECTED_PHONE_NUMBER_ID && phoneId !== EXPECTED_PHONE_NUMBER_ID) continue;
        for (const message of (value.messages || [])) {
          if (message.type !== 'text') continue;
          const from = normalizePhone(message.from);
          const body = String(message.text && message.text.body || '').trim();
          const match = body.match(/^ACTIVATE\s+STATUS\s+HD\s+(\d{6})$/i);
          if (!match || from.length < 9) continue;
          const nonce = match[1];
          const rows = await supabase(`${TABLE}?phone=eq.${encodeURIComponent(from)}&nonce=eq.${encodeURIComponent(nonce)}&status=eq.pending&expires_at=gt.${encodeURIComponent(new Date().toISOString())}&select=id&limit=1`);
          if (!rows || !rows[0]) continue;
          await supabase(`${TABLE}?id=eq.${encodeURIComponent(rows[0].id)}`, {
            method: 'PATCH',
            headers: { Prefer: 'return=minimal' },
            body: JSON.stringify({ status: 'activated', activated_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          });
          console.log(`Status HD activation confirmed for phone ending ${from.slice(-4)}`);
        }
      }
    }
    res.sendStatus(200);
  } catch (error) {
    console.error('WhatsApp webhook processing failed:', error.message);
    res.sendStatus(500);
  }
});

const storage = multer.diskStorage({ destination: (_req, _file, cb) => cb(null, TMP_DIR), filename: (_req, _file, cb) => cb(null, crypto.randomUUID() + '.upload') });
const upload = multer({ storage, limits: { fileSize: MAX_BYTES, files: 1 }, fileFilter: (_req, file, cb) => {
  if (!file.mimetype || !file.mimetype.startsWith('video/')) return cb(new Error('Upload a video file.'));
  cb(null, true);
} });
const unlink = file => file && fs.promises.unlink(file).catch(() => {});
app.post('/api/compress', (req, res) => {
  upload.single('video')(req, res, async err => {
    if (err) {
      const status = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ error: err.message || 'Upload failed.' });
    }
    if (!req.file) return res.status(400).json({ error: 'No video uploaded. Send the file in the "video" field.' });

    const input = req.file.path;
    const output = path.join(TMP_DIR, crypto.randomUUID() + '.mp4');
    let finished = false;
    const clean = async () => { await unlink(input); await unlink(output); };
    res.on('close', () => { if (!finished) clean(); });

    const resolution = String(req.body.resolution || '1080p').toLowerCase();
    const durationValue = String(req.body.duration || '60').toLowerCase();
    const profiles = {
      '1080p': { maxDimension: 1920, crf: 20, audio: '128k' },
      '720p':  { maxDimension: 1280, crf: 22, audio: '128k' },
      '480p':  { maxDimension: 854,  crf: 24, audio: '96k' }
    };
    if (!profiles[resolution]) {
      finished = true; await clean();
      return res.status(400).json({ error: 'Choose 1080p, 720p, or 480p.' });
    }
    let durationLimit = null;
    if (durationValue === '30') durationLimit = 30;
    else if (durationValue === '60') durationLimit = 60;
    else if (durationValue !== 'full') {
      finished = true; await clean();
      return res.status(400).json({ error: 'Choose 30, 60, or full duration.' });
    }

    try {
      const probe = await new Promise((resolve, reject) => ffmpeg.ffprobe(input, (error, data) => error ? reject(error) : resolve(data)));
      const sourceDuration = Number(probe?.format?.duration || 0);
      if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) {
        finished = true; await clean();
        return res.status(400).json({ error: 'Could not read this video. Please try a different video file.' });
      }
      // Keep the full-duration option bounded so a single request cannot monopolize the service.
      if (durationLimit === null && sourceDuration > 180) {
        finished = true; await clean();
        return res.status(413).json({ error: 'For full-duration compression, choose a video of 3 minutes or less. For WhatsApp Status, 30 or 60 seconds is recommended.' });
      }
      const profile = profiles[resolution];
      const outputOptions = [
        `-vf scale=w='min(${profile.maxDimension},iw)':h='min(${profile.maxDimension},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
        '-c:v libx264', '-preset veryfast', `-crf ${profile.crf}`,
        '-pix_fmt yuv420p', '-profile:v high', '-level 4.1',
        '-c:a aac', `-b:a ${profile.audio}`, '-ac 2', '-ar 48000',
        '-movflags +faststart', '-max_muxing_queue_size 1024',
        '-map_metadata -1'
      ];
      if (durationLimit) outputOptions.push(`-t ${durationLimit}`);

      ffmpeg(input)
        .outputOptions(outputOptions)
        .format('mp4')
        .on('error', async error => {
          console.error('FFmpeg compression failed:', error.message);
          if (!res.headersSent) res.status(500).json({ error: 'Video compression failed. Try a shorter video or a lower resolution.' });
          finished = true; await clean();
        })
        .on('end', async () => {
          try {
            if (res.destroyed) { finished = true; await clean(); return; }
            const stat = await fs.promises.stat(output);
            if (!stat.size) {
              finished = true; await clean();
              if (!res.headersSent) res.status(500).json({ error: 'The MP4 output was empty. Please try again.' });
              return;
            }
            res.setHeader('X-Video-Resolution', resolution);
            res.setHeader('X-Video-Format', 'mp4');
            res.setHeader('X-Video-Source-Duration-Seconds', String(sourceDuration));
            const suffix = durationLimit ? `${durationLimit}s` : 'full';
            res.download(output, `DJ_WHISTER_Status_HD_${resolution}_${suffix}.mp4`, async downloadError => {
              finished = true; await clean();
              if (downloadError && !res.headersSent) console.error('Download response failed:', downloadError.message);
            });
          } catch (error) {
            finished = true; await clean();
            if (!res.headersSent) res.status(500).json({ error: 'Could not prepare the compressed MP4 for download.' });
          }
        })
        .save(output);
    } catch (error) {
      console.error('Compression setup/probe failed:', error.message);
      finished = true; await clean();
      if (!res.headersSent) res.status(500).json({ error: 'Could not process this video. Please try another file.' });
    }
  });
});

// Trim oversized uploads to a safe <=20 MB file by keeping only the beginning.
// The original input is deleted from temporary storage after processing.
app.post('/api/trim-to-size', (req, res) => {
  upload.single('video')(req, res, async err => {
    if (err) {
      const status = err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE' ? 413 : 400;
      return res.status(status).json({ error: err.message || 'Upload failed.' });
    }
    if (!req.file) return res.status(400).json({ error: 'No video uploaded.' });
    const input = req.file.path;
    const output = path.join(TMP_DIR, crypto.randomUUID() + '.mp4');
    const targetBytes = 19 * 1024 * 1024; // leave margin under Supabase's 20 MB limit
    let finished = false;
    const clean = async () => { await unlink(input); await unlink(output); };
    res.on('close', () => { if (!finished) clean(); });
    try {
      const probe = await new Promise((resolve, reject) => ffmpeg.ffprobe(input, (error, data) => error ? reject(error) : resolve(data)));
      const duration = Number(probe?.format?.duration || 0);
      if (!Number.isFinite(duration) || duration <= 0) { finished = true; await clean(); return res.status(400).json({ error: 'Could not read the video duration. Try an MP4 video.' }); }
      const inputBytes = Number(req.file.size || 0);
      if (inputBytes <= 20 * 1024 * 1024) {
        finished = true;
        return res.download(input, req.file.originalname || 'video.mp4', async () => { await clean(); });
      }
      const originalKbps = Math.max(500, Math.floor((inputBytes * 8 / duration) / 1000));
      const videoKbps = Math.max(350, Math.min(8000, originalKbps - 96));
      let clipDuration = Math.max(1, Math.min(duration, duration * targetBytes / inputBytes * 0.94));
      let attempt = 0;
      const encode = () => new Promise((resolve, reject) => {
        try {
          if (fs.existsSync(output)) fs.unlinkSync(output);
          ffmpeg(input)
            .outputOptions(['-t ' + clipDuration.toFixed(3), '-vf scale=w=\'min(1280,iw)\':h=\'min(720,ih)\':force_original_aspect_ratio=decrease:force_divisible_by=2', '-c:v libx264', '-preset veryfast', '-b:v ' + videoKbps + 'k', '-maxrate ' + videoKbps + 'k', '-bufsize ' + (videoKbps * 2) + 'k', '-pix_fmt yuv420p', '-c:a aac', '-b:a 96k', '-movflags +faststart', '-max_muxing_queue_size 1024'])
            .format('mp4').on('error', reject).on('end', resolve).save(output);
        } catch (e) { reject(e); }
      });
      while (attempt < 6) {
        await encode();
        const stat = await fs.promises.stat(output);
        if (stat.size <= targetBytes) break;
        clipDuration = Math.max(1, clipDuration * Math.min(0.82, targetBytes / stat.size * 0.92));
        attempt++;
      }
      const finalStat = await fs.promises.stat(output);
      if (finalStat.size > 20 * 1024 * 1024) { finished = true; await clean(); return res.status(413).json({ error: 'This video is too large to trim safely in one pass. Please choose a shorter video.' }); }
      if (res.destroyed) { finished = true; await clean(); return; }
      res.setHeader('X-Original-Size', String(inputBytes));
      res.setHeader('X-Trimmed-Size', String(finalStat.size));
      res.setHeader('X-Trimmed-Duration-Seconds', String(clipDuration));
      res.download(output, 'dj-whister-trimmed.mp4', async downloadError => {
        finished = true; await clean();
        if (downloadError && !res.headersSent) console.error('Trim response failed:', downloadError.message);
      });
    } catch (error) {
      console.error('Automatic trim failed:', error.message);
      finished = true; await clean();
      if (!res.headersSent) res.status(500).json({ error: 'Automatic trimming failed. Try a shorter MP4 video.' });
    }
  });
});

app.use((err, _req, res, _next) => { console.error(err.message); if (!res.headersSent) res.status(500).json({ error: 'Unexpected server error.' }); });
app.listen(PORT, () => console.log(`Status HD backend listening on ${PORT}`));
