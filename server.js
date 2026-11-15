'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { URL } = require('node:url');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.jsonl');
const SAMPLES_FILE = path.join(DATA_DIR, 'samples.jsonl');
const PORT = Number(process.env.PORT || 3000);

fs.mkdirSync(DATA_DIR, { recursive: true });
for (const file of [SESSIONS_FILE, SAMPLES_FILE]) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, '', { mode: 0o600 });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(JSON.stringify(payload));
}

function readJsonLines(file) {
  try {
    const content = fs.readFileSync(file, 'utf8');
    return content.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    console.error(`Could not read ${path.basename(file)}:`, error.message);
    return [];
  }
}

function appendJsonLine(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('Request body must be valid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

function isFiniteOrNull(value) {
  return value === null || value === undefined || Number.isFinite(Number(value));
}

function safeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function mean(values) {
  const valid = values.filter(Number.isFinite);
  return valid.length ? valid.reduce((sum, n) => sum + n, 0) / valid.length : null;
}

function stddev(values) {
  const valid = values.filter(Number.isFinite);
  if (valid.length < 2) return null;
  const avg = mean(valid);
  return Math.sqrt(valid.reduce((sum, n) => sum + ((n - avg) ** 2), 0) / valid.length);
}

function summarize(samples) {
  const acceleration = samples.map((s) => safeNumber(s.accelerationMagnitude)).filter(Number.isFinite);
  const linearAcceleration = samples.map((s) => {
    const values = [safeNumber(s.ax), safeNumber(s.ay), safeNumber(s.az)];
    return values.every(Number.isFinite) ? Math.hypot(...values) : null;
  }).filter(Number.isFinite);
  const rotation = samples.map((s) => safeNumber(s.rotationRateMagnitude)).filter(Number.isFinite);
  const axisMean = (key) => mean(samples.map((s) => safeNumber(s[key])).filter(Number.isFinite));
  return {
    samples: samples.length,
    meanAccelerationMagnitude: mean(acceleration),
    accelerationVariation: stddev(acceleration),
    peakAccelerationMagnitude: acceleration.length ? Math.max(...acceleration) : null,
    meanLinearAcceleration: mean(linearAcceleration),
    linearAccelerationVariation: stddev(linearAcceleration),
    meanRotationRate: mean(rotation),
    peakRotationRate: rotation.length ? Math.max(...rotation) : null,
    meanRotationAlpha: axisMean('rotationAlpha'),
    meanRotationBeta: axisMean('rotationBeta'),
    meanRotationGamma: axisMean('rotationGamma'),
    validLinearAccelerationSamples: linearAcceleration.length,
    validRotationSamples: rotation.length
  };
}

function getResearchSummary() {
  const sessionEvents = readJsonLines(SESSIONS_FILE);
  const sessions = sessionEvents.filter((entry) => !entry.event);
  const completedIds = new Set(sessionEvents.filter((entry) => entry.event === 'completed').map((entry) => entry.sessionId));
  const samples = readJsonLines(SAMPLES_FILE);
  const activities = ['stationary', 'tilt', 'rotate', 'shake'];
  const byActivity = {};
  for (const activity of activities) {
    const subset = samples.filter((sample) => sample.activity === activity && sample.source === 'device');
    byActivity[activity] = summarize(subset);
  }
  return {
    generatedAt: new Date().toISOString(),
    participantSessions: sessions.length,
    totalSamples: samples.filter((sample) => sample.source === 'device').length,
    simulationSamples: samples.filter((sample) => sample.source === 'simulation').length,
    completedSessions: sessions.filter((session) => completedIds.has(session.sessionId)).length,
    byActivity
  };
}

function csvEscape(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function makeCsv() {
  const samples = readJsonLines(SAMPLES_FILE);
  const headers = [
    'sample_id', 'session_id', 'activity', 'source', 'timestamp',
    'acceleration_x_including_gravity_m_s2', 'acceleration_y_including_gravity_m_s2', 'acceleration_z_including_gravity_m_s2',
    'acceleration_x_without_gravity_m_s2', 'acceleration_y_without_gravity_m_s2', 'acceleration_z_without_gravity_m_s2',
    'acceleration_magnitude_m_s2', 'rotation_rate_alpha_deg_s', 'rotation_rate_beta_deg_s', 'rotation_rate_gamma_deg_s',
    'rotation_rate_magnitude_deg_s', 'orientation_alpha_deg', 'orientation_beta_deg', 'orientation_gamma_deg'
  ];
  const keys = [
    'sampleId', 'sessionId', 'activity', 'source', 'timestamp',
    'axg', 'ayg', 'azg', 'ax', 'ay', 'az', 'accelerationMagnitude',
    'rotationAlpha', 'rotationBeta', 'rotationGamma', 'rotationRateMagnitude',
    'alpha', 'beta', 'gamma'
  ];
  return [headers.join(','), ...samples.map((sample) => keys.map((key) => csvEscape(sample[key])).join(','))].join('\r\n');
}

async function handleApi(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, { ok: true, service: 'SensorSense Lab', storage: 'local JSON Lines files' });
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions') {
    try {
      const body = await readBody(req, 20_000);
      const participantLabel = String(body.participantLabel || '').trim().slice(0, 60);
      if (!participantLabel) return json(res, 400, { error: 'Enter a participant name or alias.' });
      if (body.consent !== true) return json(res, 400, { error: 'Participation consent is required.' });
      const session = {
        sessionId: crypto.randomUUID(),
        participantLabel,
        consentVersion: '2026-11-15-v1',
        consentedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        deviceLabel: String(body.deviceLabel || 'Not specified').slice(0, 40),
        userAgent: String(body.userAgent || '').slice(0, 300),
        completedAt: null
      };
      appendJsonLine(SESSIONS_FILE, session);
      return json(res, 201, { sessionId: session.sessionId, participantLabel: session.participantLabel });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/samples') {
    try {
      const body = await readBody(req);
      const sessionId = String(body.sessionId || '');
      const allowedActivities = new Set(['stationary', 'tilt', 'rotate', 'shake']);
      const source = body.source === 'simulation' ? 'simulation' : 'device';
      if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) return json(res, 400, { error: 'Invalid session.' });
      if (!allowedActivities.has(body.activity)) return json(res, 400, { error: 'Unknown experiment activity.' });
      if (!Array.isArray(body.samples) || body.samples.length < 1 || body.samples.length > 1200) {
        return json(res, 400, { error: 'A batch must contain between 1 and 1,200 samples.' });
      }
      const sessions = readJsonLines(SESSIONS_FILE);
      if (!sessions.some((session) => session.sessionId === sessionId)) return json(res, 404, { error: 'Session not found.' });
      const timestampNow = Date.now();
      const records = body.samples.map((item) => {
        const record = {
          sampleId: crypto.randomUUID(), sessionId, activity: body.activity, source,
          timestamp: Number.isFinite(Date.parse(item.timestamp)) ? new Date(item.timestamp).toISOString() : new Date(timestampNow).toISOString(),
          axg: safeNumber(item.axg), ayg: safeNumber(item.ayg), azg: safeNumber(item.azg),
          ax: safeNumber(item.ax), ay: safeNumber(item.ay), az: safeNumber(item.az),
          accelerationMagnitude: safeNumber(item.accelerationMagnitude),
          accelerationIncludingGravityMagnitude: safeNumber(item.accelerationIncludingGravityMagnitude),
          rotationAlpha: safeNumber(item.rotationAlpha), rotationBeta: safeNumber(item.rotationBeta), rotationGamma: safeNumber(item.rotationGamma),
          rotationRateMagnitude: safeNumber(item.rotationRateMagnitude),
          alpha: safeNumber(item.alpha), beta: safeNumber(item.beta), gamma: safeNumber(item.gamma)
        };
        return record;
      });
      for (const record of records) appendJsonLine(SAMPLES_FILE, record);
      return json(res, 201, { saved: records.length, source });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/sessions/complete') {
    try {
      const body = await readBody(req, 10_000);
      const sessions = readJsonLines(SESSIONS_FILE);
      const session = sessions.find((entry) => entry.sessionId === body.sessionId);
      if (!session) return json(res, 404, { error: 'Session not found.' });
      // JSONL is append-only; completion is represented by a separate event.
      appendJsonLine(SESSIONS_FILE, { event: 'completed', sessionId: session.sessionId, completedAt: new Date().toISOString() });
      return json(res, 200, { ok: true });
    } catch (error) {
      return json(res, 400, { error: error.message });
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/research/summary') {
    const summary = getResearchSummary();
    return json(res, 200, summary);
  }

  if (req.method === 'GET' && url.pathname === '/api/research/series') {
    const allowed = new Set(['all', 'stationary', 'tilt', 'rotate', 'shake']);
    const activity = url.searchParams.get('activity') || 'all';
    if (!allowed.has(activity)) return json(res, 400, { error: 'Unknown activity filter.' });
    const limit = Math.min(1200, Math.max(50, Number(url.searchParams.get('limit')) || 600));
    const samples = readJsonLines(SAMPLES_FILE)
      .filter((sample) => sample.source === 'device' && (activity === 'all' || sample.activity === activity))
      .slice(-limit)
      .map((sample) => ({
        timestamp: sample.timestamp, activity: sample.activity,
        ax: sample.ax, ay: sample.ay, az: sample.az,
        axg: sample.axg, ayg: sample.ayg, azg: sample.azg,
        accelerationMagnitude: sample.accelerationMagnitude,
        linearAccelerationMagnitude: [sample.ax, sample.ay, sample.az].every((v) => Number.isFinite(v)) ? Math.hypot(sample.ax, sample.ay, sample.az) : null,
        rotationAlpha: sample.rotationAlpha, rotationBeta: sample.rotationBeta, rotationGamma: sample.rotationGamma,
        rotationRateMagnitude: sample.rotationRateMagnitude
      }));
    return json(res, 200, { activity, count: samples.length, samples });
  }

  if (req.method === 'GET' && url.pathname === '/api/research/export.csv') {
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="sensorsense-samples.csv"',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    return res.end(makeCsv());
  }

  return json(res, 404, { error: 'API endpoint not found.' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);

  const requestedPath = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
  const filePath = path.resolve(PUBLIC_DIR, `.${requestedPath}`);
  if (!filePath.startsWith(PUBLIC_DIR + path.sep) && filePath !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(filePath, (error, content) => {
    if (error) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin'
    });
    res.end(content);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SensorSense Lab running at http://localhost:${PORT}`);
  console.log(`Data files: ${DATA_DIR}`);
});
