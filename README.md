# SensorSense Lab — Version 3

A standalone classroom web application for collecting smartphone motion-sensor readings, explaining the measurements in student-friendly language, and comparing results across four activities.

## What is included

- Student session registration with a name or alias and an explicit participation consent checkbox.
- Four guided activities: stationary baseline, tilt, rotation, and gentle movement.
- Browser-based DeviceMotion and DeviceOrientation collection.
- A CSS 3D phone representation that follows available orientation readings.
- Live acceleration and rotation metrics, a live chart, and plain-language interpretations.
- A clearly labelled simulation mode for laptops or presentation fallback. Simulated samples are stored separately and excluded from real-device research statistics.
- Research dashboard with aggregate activity comparisons, linear-acceleration statistics, and a filterable time-series explorer.
- Clear separation between total acceleration (which may include gravity) and linear acceleration (when the browser supplies it).
- Rotation-rate statistics and plain-language interpretations for each activity.
- CSV export of sensor samples. The CSV intentionally excludes participant names.
- Local JSON Lines storage using Node.js built-in modules; no npm packages are required.

## Requirements

- Node.js 18 or newer.
- A modern browser.
- For real smartphone sensors: use HTTPS when accessing the site from another device. Some browsers restrict motion/orientation access on insecure origins. Safari on iOS may show a permission prompt after the student presses the start button.

## Run locally

1. Extract the project ZIP.
2. Open the `sensorsense-lab` folder in a terminal.
3. Run:

   ```bash
   npm start
   ```

4. Open `http://localhost:3000` in your browser.
5. Use a smartphone on the same network for real sensor testing only after serving the site over HTTPS. `localhost` on the computer is not the same as the phone's localhost.

No `npm install` is necessary because the server uses Node.js built-in modules only.

## Where is the data stored?

The server writes data to:

- `data/sessions.jsonl` — participant labels, consent timestamp, device label, and session metadata.
- `data/samples.jsonl` — sensor samples linked to a session ID. The sample file does not contain participant names.

The data folder is created automatically at first launch. Back it up before deleting or resetting data. Do not publish this folder in a public Git repository.

## Privacy and classroom use

This is a teaching prototype, not a reviewed research study. A recognisable participant name makes a session identifiable; students may use an alias. The current consent text explains what is stored. The local research dashboard is not protected by a login, so do not expose this server to the public internet as-is. Before collecting data from a real class, agree with the lecturer on the purpose, consent wording, retention period, access controls, and whether identifiable labels are necessary. Consider making the participant label optional or replacing it with a random code for a more privacy-preserving deployment.

## Sensor interpretation notes

- Accelerometer data may be exposed as acceleration including gravity or acceleration with gravity removed. The dashboard keeps these measures separate and does not treat missing values as zero.
- A still phone can show an acceleration magnitude near 9.8 m/s² when gravity is included. This is not evidence that the phone is moving.
- Gyroscope rotation-rate values are angular velocity (degrees per second), not orientation angles.
- Browser/device sensor availability, sampling frequency, axis conventions, and permissions vary. Compare results with these limitations in mind.
- The live phone representation uses browser orientation events as an educational visualisation. It is not a precision motion-capture system.

## Current architecture

```text
Smartphone browser
  ├─ DeviceMotion / DeviceOrientation events
  ├─ Student explanations + live charts + virtual phone
  └─ HTTP JSON API
        └─ Node.js server
             ├─ data/sessions.jsonl
             ├─ data/samples.jsonl
             ├─ aggregate research summary
             └─ CSV export
```

This first standalone project uses local file storage so it can be demonstrated without setting up a cloud database. A later stage can replace or extend storage with InfluxDB and connect Grafana or a Digital Twin platform.

## Version 2 research dashboard

The Research Dashboard now includes activity-level linear acceleration statistics and a time-series explorer. Use the activity filter to inspect saved device samples. The chart shows linear acceleration and rotation-rate magnitude on independently scaled traces; compare the shape and timing of each trace, not their vertical heights. If the browser did not provide acceleration without gravity, linear-acceleration metrics are shown as unavailable.


## Version 3 research analytics improvements

- Separate accelerometer and gyroscope time-series charts, each with its own physical unit and axis traces.
- Axis-level linear acceleration (X/Y/Z) and angular velocity (alpha/beta/gamma) visualisation.
- Activity-aware plain-language interpretation, including a dedicated explanation for the combined "all activities" view.
- Data-quality indicators: median sample interval, linear-acceleration coverage, rotation-rate coverage, and observed time span.
- Downloadable JSON analysis summary for the selected activity.
- Missing sensor values remain unavailable rather than being treated as zero.

The charts are descriptive visualisations. Device coordinate conventions and browser sensor availability differ, so use controlled activity instructions and compare like-for-like conditions.


## Version 4 — live sensor transmission

During an active experiment, the browser now sends sensor readings to the Node.js backend in small batches (up to 25 readings, approximately once per second). The server appends each batch to `data/samples.jsonl`; the final remaining batch is flushed when the experiment ends. The browser shows the number of samples confirmed by the server. If an upload temporarily fails, the batch is queued for retry while the experiment remains active.

This is near-real-time batched transmission, not a persistent WebSocket stream. Local JSON Lines storage remains the source of truth. For classroom use, protect the research dashboard and avoid exposing the development server publicly without authentication and suitable network security.


### Research chart display
The research time-series charts display the original sensor readings as faint lines and overlay a more prominent centered 7-sample moving average. This smoothing is visual only; raw readings in JSONL storage and CSV exports are unchanged.


## Sensor measurement interpretation and limitations

- `ax`, `ay`, `az` are the browser-provided gravity-removed linear acceleration components in m/s². The app does not substitute gravity-included values when these are unavailable; the linear-acceleration magnitude remains `null` unless all three components are supplied.
- `axg`, `ayg`, `azg` are the browser-provided acceleration-including-gravity components in m/s². Their magnitude is stored separately as `accelerationIncludingGravityMagnitude`.
- `rotationAlpha`, `rotationBeta`, and `rotationGamma` are the browser-provided rotation-rate components in degrees per second. They are not orientation angles.
- `alpha`, `beta`, and `gamma` are orientation angles in degrees, not angular velocity.
- DeviceMotion samples use the event timestamp when the browser supplies one. Orientation events update the latest orientation and are attached to the next motion sample, rather than being counted as separate motion samples.
- The browser exposes operating-system/browser sensor values, not necessarily unprocessed hardware registers. Hardware calibration, filtering, sensor fusion, axis conventions, event frequency, and permission support vary by device and browser. Therefore this project cannot claim laboratory-grade or perfectly exact physical measurements.
- Raw values are stored and exported unchanged. Moving averages are applied only when drawing the research charts.
- For a valid experiment, use a supported phone/browser in a secure context (HTTPS or localhost), grant motion/orientation permissions, keep the device orientation consistent where instructed, and report missing sensor fields rather than replacing them with zeros.
