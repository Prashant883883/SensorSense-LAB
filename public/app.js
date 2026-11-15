'use strict';

const $ = (id) => document.getElementById(id);
const ACTIVITY_ORDER = ['stationary', 'tilt', 'rotate', 'shake'];
const ACTIVITY_META = {
  stationary: {
    number: '01', kicker: 'EXPERIMENT 01 · BASELINE', title: 'Keep your phone still',
    description: 'Place your phone flat on a stable table. We will record a baseline so we can compare it with the other movements.',
    instructionTitle: 'What to do', instructionText: 'Place the phone screen-up on a flat surface and do not touch it until the countdown finishes.',
    action: 'Enable sensors & start', explanation: 'This baseline shows the readings your device reports when you are trying not to move it. Small changes can come from sensor noise, tiny vibrations, or the way the phone is resting.'
  },
  tilt: {
    number: '02', kicker: 'EXPERIMENT 02 · ORIENTATION', title: 'Tilt your phone slowly',
    description: 'Explore how the device orientation changes when you tilt the phone. The virtual phone should follow the physical phone.',
    instructionTitle: 'What to do', instructionText: 'Hold your phone safely and slowly tilt it left, right, forward and backward. Avoid sudden movements.',
    action: 'Enable sensors & start', explanation: 'Tilting changes the phone’s orientation relative to gravity. The orientation angles describe how the device is positioned; they are not movement speed.'
  },
  rotate: {
    number: '03', kicker: 'EXPERIMENT 03 · ROTATION', title: 'Rotate your phone',
    description: 'The gyroscope reports angular velocity: how quickly the phone is rotating around its axes.',
    instructionTitle: 'What to do', instructionText: 'Hold your phone securely and rotate it slowly, then pause. Keep the movement comfortable and controlled.',
    action: 'Enable sensors & start', explanation: 'Rotation speed rises while the phone is turning and falls when it stops. The gyroscope reports rotational speed, not the final angle.'
  },
  shake: {
    number: '04', kicker: 'EXPERIMENT 04 · ACCELERATION', title: 'Move your phone gently',
    description: 'Compare the changing acceleration signal with the stationary baseline. This helps reveal how motion appears in sensor data.',
    instructionTitle: 'What to do', instructionText: 'Hold the phone securely and move it gently up and down or side to side. Do not throw, drop or shake it forcefully.',
    action: 'Enable sensors & start', explanation: 'Movement creates changing acceleration readings. Stronger peaks mean a larger measured acceleration at that moment, but the readings do not directly tell us the phone’s speed or distance.'
  }
};

let session = null;
let selectedActivity = 'stationary';
let activeCapture = false;
let captureTimer = null;
let simulationInterval = null;
let uploadInterval = null;
let pendingSamples = [];
let uploadInProgress = false;
let uploadedSampleCount = 0;
let captureStart = 0;
let lastSampleAt = 0;
let samples = [];
let latest = {};
let completedActivities = new Set();
let currentSource = 'device';
let chartFrame = null;
let twinOrientation = { alpha: 0, beta: 0, gamma: 0 };
let currentOrientation = { alpha: null, beta: null, gamma: null };

const api = async (path, options = {}) => {
  const response = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
};

function setServerStatus(online, message) {
  $('serverDot').parentElement.classList.toggle('online', online);
  $('serverStatus').textContent = message;
}

async function checkServer() {
  try {
    await api('/api/health');
    setServerStatus(true, 'Server connected');
  } catch {
    setServerStatus(false, 'Server unavailable');
  }
}

function showCompletionNotice(title, message, state = 'success') {
  const notice = $('completionNotice');
  $('completionTitle').textContent = title;
  $('completionMessage').textContent = message;
  notice.classList.remove('hidden', 'notice-error');
  if (state === 'error') notice.classList.add('notice-error');
}

$('dismissCompletionNotice').addEventListener('click', () => {
  $('completionNotice').classList.add('hidden');
});

function switchView(viewId) {
  document.querySelectorAll('.view').forEach((view) => view.classList.toggle('active-view', view.id === viewId));
  document.querySelectorAll('.nav-link').forEach((button) => button.classList.toggle('active', button.dataset.view === viewId));
  if (viewId === 'researchView') loadResearchDashboard();
}

document.querySelectorAll('.nav-link').forEach((button) => {
  button.addEventListener('click', () => switchView(button.dataset.view));
});

$('joinForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('joinError').textContent = '';
  const participantLabel = $('participantLabel').value.trim();
  if (!participantLabel) { $('joinError').textContent = 'Please enter a name or alias.'; return; }
  if (!$('consentCheck').checked) { $('joinError').textContent = 'Please confirm that you understand the participation information.'; return; }
  try {
    const created = await api('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        participantLabel,
        deviceLabel: $('deviceLabel').value,
        userAgent: navigator.userAgent,
        consent: true
      })
    });
    session = created;
    $('sessionGreeting').textContent = `Welcome, ${created.participantLabel}`;
    $('sessionIdentifier').textContent = `SESSION ${created.sessionId.slice(0, 8).toUpperCase()}`;
    $('welcomePanel').classList.add('hidden');
    $('experimentPanel').classList.remove('hidden');
    updateActivity(selectedActivity);
    $('experimentPanel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    $('joinError').textContent = error.message;
  }
});

function updateActivity(activity) {
  if (!ACTIVITY_META[activity] || activeCapture) return;
  selectedActivity = activity;
  const meta = ACTIVITY_META[activity];
  $('activityKicker').textContent = meta.kicker;
  $('activityTitle').textContent = meta.title;
  $('activityDescription').textContent = meta.description;
  $('instructionTitle').textContent = meta.instructionTitle;
  $('instructionText').textContent = meta.instructionText;
  $('startCaptureButton').innerHTML = `${meta.action} <span>→</span>`;
  document.querySelectorAll('.activity-choice').forEach((button) => {
    button.classList.toggle('selected', button.dataset.activity === activity);
    const done = completedActivities.has(button.dataset.activity);
    button.querySelector('i').textContent = done ? '✓' : '›';
    button.querySelector('i').style.color = done ? 'var(--green)' : '';
  });
  samples = [];
  latest = {};
  currentOrientation = { alpha: null, beta: null, gamma: null };
  $('resultPanel').classList.add('hidden');
  $('chartEmpty').classList.remove('hidden');
  $('sampleCounter').textContent = '0 samples';
  $('rawSampleCount').textContent = '0';
  $('accMagnitude').textContent = '—';
  $('rotationMagnitude').textContent = '—';
  $('accMeaning').textContent = 'Start an experiment to see how much acceleration is being measured.';
  $('rotationMeaning').textContent = 'The gyroscope detects how quickly the phone rotates.';
  $('accMeter').style.width = '0%';
  $('rotationMeter').style.width = '0%';
  $('orientationRoll').textContent = '—';
  $('orientationPitch').textContent = '—';
  $('twinScreenValue').textContent = 'READY';
  $('twinCaption').textContent = 'Waiting for orientation data';
  $('captureStatus').textContent = 'Not recording';
  $('completionNotice').classList.add('hidden');
  drawChart();
}

document.querySelectorAll('.activity-choice').forEach((button) => {
  button.addEventListener('click', () => updateActivity(button.dataset.activity));
});

function finite(value) { return typeof value === 'number' && Number.isFinite(value); }
function vectorMagnitude(x, y, z) {
  if (![x, y, z].every(finite)) return null;
  return Math.sqrt(x * x + y * y + z * z);
}

function eventTimestampISO(event) {
  // DeviceMotionEvent.timeStamp is a high-resolution timestamp relative to
  // the page time origin in modern browsers. Preserve that event time instead
  // of stamping the later JavaScript processing time.
  const stamp = event && event.timeStamp;
  if (finite(stamp)) {
    const epochMs = stamp > 1e12 ? stamp : performance.timeOrigin + stamp;
    if (Number.isFinite(epochMs)) return new Date(epochMs).toISOString();
  }
  return new Date().toISOString();
}

function createSample(event, source = 'device') {
  const accelG = event?.accelerationIncludingGravity || null;
  const accel = event?.acceleration || null;
  const rotation = event?.rotationRate || null;
  const orientation = currentOrientation;
  const axg = finite(accelG?.x) ? accelG.x : null;
  const ayg = finite(accelG?.y) ? accelG.y : null;
  const azg = finite(accelG?.z) ? accelG.z : null;
  // DeviceMotionEvent.acceleration is the gravity-removed linear acceleration.
  // Do not silently substitute accelerationIncludingGravity here: that would
  // mix two different physical quantities under one label.
  const ax = finite(accel?.x) ? accel.x : null;
  const ay = finite(accel?.y) ? accel.y : null;
  const az = finite(accel?.z) ? accel.z : null;
  const accelerationMagnitude = vectorMagnitude(ax, ay, az);
  const accelerationIncludingGravityMagnitude = vectorMagnitude(axg, ayg, azg);
  const rotationAlpha = finite(rotation?.alpha) ? rotation.alpha : null;
  const rotationBeta = finite(rotation?.beta) ? rotation.beta : null;
  const rotationGamma = finite(rotation?.gamma) ? rotation.gamma : null;
  const rotationRateMagnitude = vectorMagnitude(rotationAlpha, rotationBeta, rotationGamma);
  return {
    timestamp: eventTimestampISO(event), source,
    axg, ayg, azg, ax, ay, az,
    accelerationMagnitude, accelerationIncludingGravityMagnitude,
    rotationAlpha, rotationBeta, rotationGamma, rotationRateMagnitude,
    alpha: finite(orientation.alpha) ? orientation.alpha : null,
    beta: finite(orientation.beta) ? orientation.beta : null,
    gamma: finite(orientation.gamma) ? orientation.gamma : null
  };
}

async function flushPendingSamples() {
  if (uploadInProgress || !session || !pendingSamples.length) return;
  const batch = pendingSamples.splice(0, 25);
  uploadInProgress = true;
  try {
    const result = await api('/api/samples', {
      method: 'POST',
      body: JSON.stringify({ sessionId: session.sessionId, activity: selectedActivity, source: currentSource, samples: batch })
    });
    uploadedSampleCount += result.saved;
    $('captureStatus').textContent = `Recording · ${uploadedSampleCount} samples transmitted and saved`;
  } catch (error) {
    pendingSamples = batch.concat(pendingSamples);
    $('sensorHelp').textContent = `Live upload temporarily failed: ${error.message}. The app will retry automatically.`;
  } finally {
    uploadInProgress = false;
  }
}

function queueSample(sample) {
  samples.push(sample);
  pendingSamples.push(sample);
  latest = sample;
  updateLiveDisplay(sample);
}

function onMotion(event) {
  if (!activeCapture) return;
  const now = performance.now();
  if (now - lastSampleAt < 90) return;
  lastSampleAt = now;
  const sample = createSample(event, 'device');
  if (sample.accelerationMagnitude !== null || sample.rotationRateMagnitude !== null || finite(sample.beta)) {
    queueSample(sample);
  }
}

function onOrientation(event) {
  if (!finite(event.alpha) && !finite(event.beta) && !finite(event.gamma)) return;
  currentOrientation = { alpha: event.alpha, beta: event.beta, gamma: event.gamma };
  twinOrientation = { ...currentOrientation };
  renderTwin(twinOrientation);
  // Orientation is stored as the latest available orientation and attached to
  // the next DeviceMotion sample. This avoids mixing two independent event
  // streams into one irregular, double-counted sample sequence.
}

function renderTwin(orientation) {
  const alpha = finite(orientation.alpha) ? orientation.alpha : 0;
  const beta = finite(orientation.beta) ? orientation.beta : 0;
  const gamma = finite(orientation.gamma) ? orientation.gamma : 0;
  $('twinPhone').style.transform = `rotateX(${Math.max(-80, Math.min(80, beta))}deg) rotateY(${Math.max(-80, Math.min(80, gamma))}deg) rotateZ(${alpha}deg)`;
  $('orientationRoll').textContent = finite(gamma) ? `${gamma.toFixed(1)}°` : '—';
  $('orientationPitch').textContent = finite(beta) ? `${beta.toFixed(1)}°` : '—';
  $('twinCaption').textContent = 'Virtual phone follows the browser orientation reading';
}

function updateLiveDisplay(sample) {
  $('sampleCounter').textContent = `${samples.length} samples`;
  $('rawSampleCount').textContent = String(samples.length);
  if (finite(sample.accelerationMagnitude)) {
    $('accMagnitude').textContent = sample.accelerationMagnitude.toFixed(2);
    $('accMeaning').textContent = 'Gravity-removed linear acceleration from the phone browser sensor event.';
    $('accMeter').style.width = `${Math.min(100, sample.accelerationMagnitude / 20 * 100)}%`;
  }
  if (finite(sample.rotationRateMagnitude)) {
    $('rotationMagnitude').textContent = sample.rotationRateMagnitude.toFixed(1);
    $('rotationMeaning').textContent = sample.rotationRateMagnitude < 4
      ? 'The phone is rotating slowly or is almost still.'
      : sample.rotationRateMagnitude < 35
        ? 'The phone is rotating. Watch how the value changes when you pause.'
        : 'A relatively fast rotation is being reported. Move gently and safely.';
    $('rotationMeter').style.width = `${Math.min(100, sample.rotationRateMagnitude / 180 * 100)}%`;
  }
  if (finite(sample.alpha) || finite(sample.beta) || finite(sample.gamma)) {
    renderTwin({ alpha: sample.alpha, beta: sample.beta, gamma: sample.gamma });
  }
  $('twinScreenValue').textContent = finite(sample.accelerationMagnitude) ? sample.accelerationMagnitude.toFixed(1) : 'LIVE';
  $('chartEmpty').classList.add('hidden');
  drawChart();
}

async function askSensorPermission() {
  const permissionTypes = [window.DeviceOrientationEvent, window.DeviceMotionEvent];
  for (const EventType of permissionTypes) {
    if (typeof EventType?.requestPermission === 'function') {
      const result = await EventType.requestPermission();
      if (result !== 'granted') throw new Error('Motion sensor permission was not granted. You can try the simulated demo instead.');
    }
  }
  if (!('DeviceMotionEvent' in window) && !('DeviceOrientationEvent' in window)) {
    throw new Error('This browser does not provide smartphone motion or orientation events. Try the simulated demo or use a supported smartphone browser.');
  }
}

async function startDeviceCapture() {
  if (!session || activeCapture) return;
  $('sensorHelp').textContent = 'Requesting permission and waiting for sensor readings…';
  try {
    await askSensorPermission();
    await beginCapture('device');
  } catch (error) {
    $('sensorHelp').textContent = error.message;
    $('captureStatus').textContent = 'Could not start sensors';
  }
}

function buildSimulationSample(index, activity, startTime) {
  const t = index / 10;
  const noise = (amount) => (Math.random() - .5) * amount;
  let ax = noise(.12), ay = noise(.12), az = noise(.12);
  let axg = noise(.12), ayg = noise(.12), azg = 9.81 + noise(.12);
  let beta = noise(.5), gamma = noise(.5), alpha = noise(.5);
  let rotA = noise(1), rotB = noise(1), rotG = noise(1);
  if (activity === 'tilt') {
    beta = Math.sin(t * 1.7) * 24 + noise(1.5);
    gamma = Math.cos(t * 1.25) * 19 + noise(1.5);
    axg = Math.sin(t * 1.7) * 3.6 + noise(.18);
    azg = Math.cos(t * 1.7) * 8.6 + noise(.18);
    rotA = noise(2); rotB = Math.cos(t * 1.7) * 35 + noise(3); rotG = -Math.sin(t * 1.25) * 27 + noise(3);
  } else if (activity === 'rotate') {
    alpha = (t * 48) % 360;
    rotA = 4 + Math.sin(t * 2) * 3 + noise(2);
    rotB = 12 + Math.cos(t * 2.4) * 4 + noise(2);
    rotG = 28 + noise(4);
    beta = 8 + Math.sin(t) * 3; gamma = 5 + Math.cos(t) * 3;
  } else if (activity === 'shake') {
    ax = Math.sin(t * 13) * 3.2 + noise(.8);
    ay = Math.cos(t * 11) * 2.4 + noise(.8);
    az = Math.sin(t * 16) * 2.8 + noise(.8);
    axg = ax + noise(.3); ayg = ay + noise(.3); azg = 9.81 + az + noise(.3);
    rotA = Math.sin(t * 12) * 35 + noise(5); rotB = Math.cos(t * 9) * 24 + noise(5); rotG = Math.sin(t * 15) * 27 + noise(5);
    beta = Math.sin(t * 8) * 12; gamma = Math.cos(t * 7) * 12;
  }
  const accMagnitude = vectorMagnitude(ax, ay, az);
  const rotMagnitude = vectorMagnitude(rotA, rotB, rotG);
  return {
    timestamp: new Date(startTime + index * 100).toISOString(), source: 'simulation',
    axg, ayg, azg, ax, ay, az,
    accelerationMagnitude: accMagnitude,
    rotationAlpha: rotA, rotationBeta: rotB, rotationGamma: rotG,
    rotationRateMagnitude: rotMagnitude,
    alpha, beta, gamma
  };
}

async function beginCapture(source) {
  if (activeCapture) return;
  activeCapture = true;
  currentSource = source;
  samples = [];
  pendingSamples = [];
  uploadedSampleCount = 0;
  uploadInProgress = false;
  lastSampleAt = 0;
  captureStart = Date.now();
  $('resultPanel').classList.add('hidden');
  $('completionNotice').classList.add('hidden');
  $('startCaptureButton').classList.add('hidden');
  $('simulateButton').classList.add('hidden');
  $('stopCaptureButton').classList.remove('hidden');
  $('captureStatus').textContent = source === 'device' ? 'Recording device sensors' : 'Running simulated demo';
  $('captureStatus').style.color = source === 'device' ? 'var(--green)' : 'var(--orange)';
  $('sensorHelp').textContent = source === 'device'
    ? 'Recording real browser sensor events. Keep following the activity instructions until the timer finishes.'
    : 'This is generated demonstration data, not a real measurement from your device. It will be labelled as simulation in the research data.';

  if (source === 'device') {
    window.addEventListener('devicemotion', onMotion, { passive: true });
    window.addEventListener('deviceorientation', onOrientation, { passive: true });
  } else {
    const simulatedStart = Date.now();
    let index = 0;
    simulationInterval = setInterval(() => {
      if (!activeCapture) return;
      const sample = buildSimulationSample(index++, selectedActivity, simulatedStart);
      queueSample(sample);
      twinOrientation = { alpha: sample.alpha, beta: sample.beta, gamma: sample.gamma };
      renderTwin(twinOrientation);
      updateLiveDisplay(sample);
    }, 100);
  }
  uploadInterval = setInterval(() => flushPendingSamples(), 1000);
  $('captureStatus').textContent += ' · live upload enabled · 12s';
  captureTimer = setTimeout(() => finishCapture(), 12_000);
}

function stopListeners() {
  window.removeEventListener('devicemotion', onMotion);
  window.removeEventListener('deviceorientation', onOrientation);
  if (captureTimer) clearTimeout(captureTimer);
  if (simulationInterval) clearInterval(simulationInterval);
  if (uploadInterval) clearInterval(uploadInterval);
  captureTimer = null;
  simulationInterval = null;
  uploadInterval = null;
}

$('startCaptureButton').addEventListener('click', startDeviceCapture);
$('simulateButton').addEventListener('click', () => beginCapture('simulation'));
$('stopCaptureButton').addEventListener('click', finishCapture);

async function finishCapture() {
  if (!activeCapture) return;
  activeCapture = false;
  stopListeners();
  $('stopCaptureButton').classList.add('hidden');
  $('startCaptureButton').classList.remove('hidden');
  $('simulateButton').classList.remove('hidden');
  $('captureStatus').textContent = 'Saving experiment…';
  $('captureStatus').style.color = 'var(--muted)';

  if (!samples.length) {
    $('captureStatus').textContent = 'No readings received';
    $('sensorHelp').textContent = 'No sensor readings arrived during this attempt. Check browser permission and try again, or use the simulation for a presentation.';
    showCompletionNotice('Experiment ended — no data received', 'No sensor readings were collected. Check sensor permission and try this experiment again.', 'error');
    return;
  }
  // Flush any readings collected since the last periodic upload.
  while (pendingSamples.length || uploadInProgress) {
    if (!uploadInProgress) await flushPendingSamples();
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (uploadedSampleCount === 0) {
    $('captureStatus').textContent = 'Could not save data';
    $('sensorHelp').textContent = 'No sensor batches were confirmed by the server. Check your connection and try again.';
    showCompletionNotice('Experiment ended — data not saved', 'The server did not confirm that the readings were saved. Check your connection and retry.', 'error');
    return;
  }
  $('captureStatus').textContent = `${uploadedSampleCount} ${currentSource === 'device' ? 'device' : 'simulated'} samples transmitted live and saved`;
  $('captureStatus').style.color = currentSource === 'device' ? 'var(--green)' : 'var(--orange)';
  completedActivities.add(selectedActivity);
  updateProgress();
  const activityNumber = ACTIVITY_META[selectedActivity].number;
  const allDone = completedActivities.size === ACTIVITY_ORDER.length;
  showCompletionNotice(
    allDone ? 'All experiments completed!' : `Experiment ${activityNumber} completed!`,
    `${uploadedSampleCount} ${currentSource === 'device' ? 'sensor' : 'simulated'} readings collected and saved. ${allDone ? 'You have finished all four experiments.' : 'You can now continue to the next experiment.'}`
  );
  showActivityResult(samples, currentSource);
}

function avg(values) {
  const valid = values.filter(finite);
  return valid.length ? valid.reduce((total, value) => total + value, 0) / valid.length : null;
}
function standardDeviation(values) {
  const valid = values.filter(finite);
  if (valid.length < 2) return null;
  const average = avg(valid);
  return Math.sqrt(valid.reduce((total, value) => total + ((value - average) ** 2), 0) / valid.length);
}
function format(value, suffix = '') { return finite(value) ? `${value.toFixed(2)}${suffix}` : 'Not reported'; }

function showActivityResult(data, source) {
  const acceleration = data.map((item) => item.accelerationMagnitude).filter(finite);
  const rotation = data.map((item) => item.rotationRateMagnitude).filter(finite);
  const averageAcceleration = avg(acceleration);
  const variation = standardDeviation(acceleration);
  const peakRotation = rotation.length ? Math.max(...rotation) : null;
  $('resultSamples').textContent = String(data.length);
  $('resultAcceleration').textContent = format(averageAcceleration, ' m/s²');
  $('resultRotation').textContent = format(peakRotation, ' °/s');
  const meta = ACTIVITY_META[selectedActivity];
  let interpretation = meta.explanation;
  if (selectedActivity === 'stationary' && finite(variation)) interpretation += ` In this run, the acceleration magnitude varied by about ${variation.toFixed(2)} m/s² (standard deviation).`;
  if (selectedActivity === 'shake' && finite(variation)) interpretation += ` The measured acceleration variation was ${variation.toFixed(2)} m/s².`;
  if (selectedActivity === 'rotate' && finite(peakRotation)) interpretation += ` The highest reported rotation-rate magnitude in this run was ${peakRotation.toFixed(1)} °/s.`;
  if (source === 'simulation') interpretation += ' Remember: this result is simulated and should not be included as a real participant measurement.';
  $('resultInterpretation').textContent = interpretation;
  $('resultPanel').classList.remove('hidden');
  $('resultPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function updateProgress() {
  const count = completedActivities.size;
  $('progressText').textContent = `${count} of 4`;
  $('progressFill').style.width = `${count / 4 * 100}%`;
  document.querySelectorAll('.activity-choice').forEach((button) => {
    const done = completedActivities.has(button.dataset.activity);
    button.querySelector('i').textContent = done ? '✓' : '›';
    button.querySelector('i').style.color = done ? 'var(--green)' : '';
  });
}

$('nextActivityButton').addEventListener('click', () => {
  const currentIndex = ACTIVITY_ORDER.indexOf(selectedActivity);
  const next = ACTIVITY_ORDER.slice(currentIndex + 1).find((activity) => !completedActivities.has(activity));
  if (next) {
    updateActivity(next);
    $('activityTitle').scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (completedActivities.size === 4) {
    $('nextActivityButton').textContent = 'All experiments completed ✓';
    $('nextActivityButton').disabled = true;
    finishSession();
  } else {
    const firstIncomplete = ACTIVITY_ORDER.find((activity) => !completedActivities.has(activity));
    if (firstIncomplete) updateActivity(firstIncomplete);
  }
});

async function finishSession() {
  try { await api('/api/sessions/complete', { method: 'POST', body: JSON.stringify({ sessionId: session.sessionId }) }); }
  catch (error) { console.warn('Could not mark session complete:', error.message); }
}

$('endSessionButton').addEventListener('click', async () => {
  if (activeCapture) await finishCapture();
  await finishSession();
  session = null;
  completedActivities = new Set();
  $('experimentPanel').classList.add('hidden');
  $('welcomePanel').classList.remove('hidden');
  $('joinForm').reset();
  $('progressText').textContent = '0 of 4';
  $('progressFill').style.width = '0%';
  $('nextActivityButton').disabled = false;
  $('nextActivityButton').textContent = 'Continue to next experiment →';
  switchView('studentView');
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

function drawChart() {
  const canvas = $('liveChart');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(300, Math.floor(rect.width * (window.devicePixelRatio || 1)));
  const height = Math.max(130, Math.floor(rect.height * (window.devicePixelRatio || 1)));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const context = canvas.getContext('2d');
  context.clearRect(0, 0, width, height);
  const pad = { left: 35, right: 12, top: 12, bottom: 24 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;
  context.strokeStyle = 'rgba(129,157,185,.16)';
  context.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + chartH * i / 4;
    context.beginPath(); context.moveTo(pad.left, y); context.lineTo(width - pad.right, y); context.stroke();
  }
  context.fillStyle = '#7890a8'; context.font = `${Math.max(9, 10 * (window.devicePixelRatio || 1))}px DM Mono`;
  context.fillText('HIGH', 3, pad.top + 4); context.fillText('LOW', 5, pad.top + chartH);
  const visible = samples.slice(-120);
  if (visible.length < 2) return;
  const acceleration = visible.map((item) => item.accelerationMagnitude);
  const rotation = visible.map((item) => item.rotationRateMagnitude);
  const maxAcc = Math.max(10, ...acceleration.filter(finite));
  const maxRot = Math.max(30, ...rotation.filter(finite));
  const drawLine = (values, maxValue, color) => {
    context.beginPath(); let started = false;
    values.forEach((value, index) => {
      if (!finite(value)) return;
      const x = pad.left + chartW * index / (values.length - 1);
      const y = pad.top + chartH - (Math.min(value, maxValue) / maxValue) * chartH;
      if (!started) { context.moveTo(x, y); started = true; } else context.lineTo(x, y);
    });
    context.strokeStyle = color; context.lineWidth = 2 * (window.devicePixelRatio || 1); context.lineJoin = 'round'; context.stroke();
  };
  drawLine(acceleration, maxAcc, '#58d8c8');
  drawLine(rotation, maxRot, '#ffbd70');
}
window.addEventListener('resize', drawChart);

let researchSeries = [];
function numericMean(values) { const valid = values.filter(finite); return valid.length ? valid.reduce((a,b)=>a+b,0)/valid.length : null; }
function numericStd(values) { const valid=values.filter(finite); if(valid.length<2)return null; const m=numericMean(valid); return Math.sqrt(valid.reduce((a,b)=>a+(b-m)**2,0)/valid.length); }
function drawAxisChart(canvasId, emptyId, series, axisKeys, colors, unit) {
  const canvas=$(canvasId), empty=$(emptyId);
  if (!canvas) return;
  const rect=canvas.getBoundingClientRect();
  const hasValues=axisKeys.some(key=>series.some(row=>finite(row[key])));
  empty.classList.toggle('hidden', hasValues);
  if (!hasValues) { canvas.style.display='none'; return; }
  canvas.style.display='block';
  const dpr=window.devicePixelRatio||1;
  const width=Math.max(300,Math.floor(rect.width*dpr));
  const height=Math.max(190,Math.floor(rect.height*dpr));
  if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
  const ctx=canvas.getContext('2d');ctx.clearRect(0,0,width,height);
  const pad={left:48,right:14,top:14,bottom:30}, plotW=width-pad.left-pad.right, plotH=height-pad.top-pad.bottom;
  const all=axisKeys.flatMap(key=>series.map(row=>row[key]).filter(finite));
  const maxAbs=Math.max(0.01,...all.map(Math.abs))*1.12;
  ctx.font=`${10*dpr}px DM Mono`;ctx.fillStyle='#8197ad';ctx.strokeStyle='rgba(129,157,185,.18)';ctx.lineWidth=1;
  for(let i=0;i<=4;i++){
    const y=pad.top+plotH*i/4;
    ctx.beginPath();ctx.moveTo(pad.left,y);ctx.lineTo(width-pad.right,y);ctx.stroke();
    const value=(maxAbs-(2*maxAbs*i/4));
    const decimals = maxAbs < 0.1 ? 3 : maxAbs < 1 ? 2 : 1;
    ctx.fillText(value.toFixed(decimals),3*dpr,y+3*dpr);
  }
  // Draw the untouched measurements faintly, then overlay a centered 7-sample
  // moving average for readability. Smoothing is display-only: stored/exported
  // sensor records are never modified.
  const movingAverage = (key, index) => {
    const start=Math.max(0,index-3), end=Math.min(series.length-1,index+3);
    const values=series.slice(start,end+1).map(row=>row[key]).filter(finite);
    return values.length ? values.reduce((sum,value)=>sum+value,0)/values.length : null;
  };
  axisKeys.forEach((key,index)=>{
    const drawSeries=(valueAt,lineWidth,alpha)=>{
      ctx.beginPath();let started=false;
      series.forEach((row,i)=>{
        const value=valueAt(row,i); if(!finite(value)){started=false;return;}
        const x=pad.left+plotW*i/Math.max(1,series.length-1);
        const y=pad.top+plotH/2-(value/(2*maxAbs))*plotH;
        if(!started){ctx.moveTo(x,y);started=true;}else ctx.lineTo(x,y);
      });
      ctx.strokeStyle=colors[index];ctx.globalAlpha=alpha;ctx.lineWidth=lineWidth*dpr;ctx.lineJoin='round';ctx.lineCap='round';ctx.stroke();ctx.globalAlpha=1;
    };
    drawSeries(row=>row[key],0.9,0.34);
    drawSeries((row,i)=>movingAverage(key,i),2.5,1);
  });
  ctx.fillStyle='#8197ad';
  const firstTime=Date.parse(series[0]?.timestamp), lastTime=Date.parse(series.at(-1)?.timestamp);
  const durationSeconds=Number.isFinite(firstTime)&&Number.isFinite(lastTime)?Math.max(0,(lastTime-firstTime)/1000):null;
  ctx.fillText('Start',pad.left,height-7*dpr);
  ctx.fillText(`${series.length} records${durationSeconds!==null?` · ${durationSeconds.toFixed(1)} s`:''} · ${unit}`,Math.max(pad.left,width-190*dpr),height-7*dpr);
}
function median(values){
  const a=values.filter(finite).sort((x,y)=>x-y);
  if(!a.length)return null;
  const m=Math.floor(a.length/2);
  return a.length%2?a[m]:(a[m-1]+a[m])/2;
}
function updateSeriesInterpretation() {
  const activity=$('seriesActivity').value;
  const labels={all:'all activities',stationary:'the stationary activity',tilt:'the tilt activity',rotate:'the rotation activity',shake:'the movement activity'};
  const linear=researchSeries.map(x=>x.linearAccelerationMagnitude).filter(finite);
  const rotation=researchSeries.map(x=>x.rotationRateMagnitude).filter(finite);
  const avgLinear=numericMean(linear), stdLinear=numericStd(linear), avgRotation=numericMean(rotation);
  const linearAxisCount=researchSeries.filter(x=>[x.ax,x.ay,x.az].every(finite)).length;
  const rotationAxisCount=researchSeries.filter(x=>[x.rotationAlpha,x.rotationBeta,x.rotationGamma].every(finite)).length;
  const stamps=researchSeries.map(x=>Date.parse(x.timestamp)).filter(Number.isFinite).sort((a,b)=>a-b);
  const intervals=stamps.slice(1).map((v,i)=>v-stamps[i]).filter(v=>v>0&&v<60000);
  $('seriesCount').textContent=researchSeries.length.toLocaleString();
  $('seriesLinearMean').textContent=format(avgLinear,' m/s²');
  $('seriesLinearStd').textContent=format(stdLinear,' m/s²');
  $('seriesRotationMean').textContent=format(avgRotation,' °/s');
  $('qualityInterval').textContent=format(median(intervals),' ms');
  $('qualityLinearCoverage').textContent=researchSeries.length?`${(100*linearAxisCount/researchSeries.length).toFixed(1)}%`:'—';
  $('qualityRotationCoverage').textContent=researchSeries.length?`${(100*rotationAxisCount/researchSeries.length).toFixed(1)}%`:'—';
  $('qualityDuration').textContent=stamps.length>1?`${((stamps.at(-1)-stamps[0])/1000).toFixed(1)} s`:'—';
  drawAxisChart('accelerationChart','accelerationChartEmpty',researchSeries,['ax','ay','az'],['#58d8c8','#ffbd70','#8ca8ff'],'m/s²');
  drawAxisChart('rotationChart','rotationChartEmpty',researchSeries,['rotationAlpha','rotationBeta','rotationGamma'],['#58d8c8','#ffbd70','#8ca8ff'],'°/s');
  let explanation='';
  if(!researchSeries.length) explanation='There are no real-device records for this selection yet. Complete the activity on a smartphone and refresh the dashboard.';
  else if(!linear.length && !rotation.length) explanation=`The selected records contain ${researchSeries.length} samples, but the browser did not provide complete linear-acceleration or rotation-rate vectors. This can depend on the phone, browser and permission settings.`;
  else {
    const parts=[];
    if(linear.length) {
      if(activity==='stationary') parts.push(`For ${labels[activity]}, the mean linear-acceleration magnitude was ${avgLinear.toFixed(2)} m/s². A relatively small value is consistent with a phone resting with little movement.`);
      else if(activity==='tilt') parts.push(`For ${labels[activity]}, the mean linear-acceleration magnitude was ${avgLinear.toFixed(2)} m/s². Tilting changes the phone's orientation relative to gravity; short bursts can occur while repositioning it.`);
      else if(activity==='rotate') parts.push(`For ${labels[activity]}, the mean linear-acceleration magnitude was ${avgLinear.toFixed(2)} m/s². Linear movement should be considered separately from rotation.`);
      else if(activity==='shake') parts.push(`For ${labels[activity]}, the mean linear-acceleration magnitude was ${avgLinear.toFixed(2)} m/s². The variation (${format(stdLinear,' m/s²')}) describes how spread out the measured movement values were.`);
      else parts.push(`Across ${labels[activity]}, the mean linear-acceleration magnitude was ${avgLinear.toFixed(2)} m/s², with a standard deviation of ${format(stdLinear,' m/s²')}. Compare each activity separately because combining conditions can hide their differences.`);
    } else parts.push('Linear-acceleration values are unavailable for these records, so movement intensity cannot be calculated from the gravity-removed axes.');
    if(rotation.length) parts.push(`The mean rotation-rate magnitude was ${avgRotation.toFixed(2)} °/s. This is angular velocity (how quickly the phone turns), not its orientation angle.`);
    explanation=parts.join(' ');
  }
  $('researchInterpretation').innerHTML=`<strong>What these measurements suggest</strong><p>${escapeHtml(explanation)} These are descriptive summaries of the selected records, not a diagnosis of device quality.</p>`;
}
async function loadResearchSeries() {
  try {
    const activity=$('seriesActivity').value;
    const data=await api(`/api/research/series?activity=${encodeURIComponent(activity)}&limit=1200`);
    researchSeries=data.samples||[];
    updateSeriesInterpretation();
  } catch(error) {
    $('researchInterpretation').innerHTML=`<strong>Could not load measurements</strong><p>${escapeHtml(error.message)}</p>`;
    $('accelerationChartEmpty').classList.remove('hidden');
    $('rotationChartEmpty').classList.remove('hidden');
  }
}
async function loadResearchDashboard() {
  try {
    const data = await api('/api/research/summary');
    $('statParticipants').textContent = data.participantSessions;
    $('statSamples').textContent = data.totalSamples;
    $('statCompleted').textContent = data.completedSessions;
    $('statSimulation').textContent = data.simulationSamples;
    const names = { stationary: 'Stay still', tilt: 'Tilt', rotate: 'Rotate', shake: 'Move / shake' };
    const rows = Object.entries(data.byActivity).map(([activity, stats]) => {
      return `<tr><td>${names[activity]}</td><td>${stats.samples}</td><td>${format(stats.meanAccelerationMagnitude, ' m/s²')}</td><td>${format(stats.meanLinearAcceleration, ' m/s²')}</td><td>${format(stats.linearAccelerationVariation, ' m/s²')}</td><td>${format(stats.meanRotationRate, ' °/s')}</td><td>${format(stats.peakRotationRate, ' °/s')}</td></tr>`;
    }).join('');
    $('researchTable').innerHTML = rows || '<tr><td colspan="7" class="empty-cell">No research data yet. Complete a phone experiment first.</td></tr>';
    await loadResearchSeries();
  } catch (error) {
    $('researchTable').innerHTML = `<tr><td colspan="7" class="empty-cell">Could not load research data: ${escapeHtml(error.message)}</td></tr>`;
  }
}
$('seriesActivity').addEventListener('change', loadResearchSeries);
window.addEventListener('resize', updateSeriesInterpretation);
function escapeHtml(value) { return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]); }
$('refreshResearchButton').addEventListener('click', loadResearchDashboard);
$('exportButton').addEventListener('click', () => { window.location.href = '/api/research/export.csv'; });
$('exportReportButton').addEventListener('click', () => {
  const report={generatedAt:new Date().toISOString(),activity:$('seriesActivity').value,recordCount:researchSeries.length,
    summary:{meanLinearAcceleration:numericMean(researchSeries.map(x=>x.linearAccelerationMagnitude).filter(finite)),
      linearAccelerationStdDev:numericStd(researchSeries.map(x=>x.linearAccelerationMagnitude).filter(finite)),
      meanRotationRate:numericMean(researchSeries.map(x=>x.rotationRateMagnitude).filter(finite))},
    quality:{linearAccelerationCoverage:researchSeries.length?researchSeries.filter(x=>[x.ax,x.ay,x.az].every(finite)).length/researchSeries.length:null,
      rotationRateCoverage:researchSeries.length?researchSeries.filter(x=>[x.rotationAlpha,x.rotationBeta,x.rotationGamma].every(finite)).length/researchSeries.length:null},
    note:'Descriptive summary of selected real-device records. Not a diagnosis or device-quality assessment.'};
  const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'});
  const link=document.createElement('a');link.href=URL.createObjectURL(blob);link.download='sensorsense-analysis-report.json';link.click();URL.revokeObjectURL(link.href);
});

checkServer();
setInterval(checkServer, 15000);
updateActivity('stationary');
