/* Hand-gesture scrolling. Nothing loads and the camera stays off until the
   visitor presses the hand button. Frames are processed in the browser only
   and no video is shown on the page. */
(function () {
  'use strict';
  var btn = document.getElementById('handBtn');
  if (!btn) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { btn.hidden = true; return; }

  var VER = '1.2.3';
  var CFG = {
    lib: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + VER + '/vision_bundle.mjs',
    wasm: 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@' + VER + '/wasm',
    model: 'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task'
  };
  // Movement is measured in hand lengths from where the hand first appeared,
  // so it behaves the same close to the screen and a couple of metres away.
  var DEAD = 0.45;       // neutral zone, in hand lengths
  var REACH = 1.6;       // extra movement that gives full speed
  var MAX = 2000;        // px per second at full speed
  var ASPECT = 4 / 3;

  var on = false, busy = false, stream = null, lm = null, video, panel, statusEl, arrowEl, toast;
  var target = 0, vel = 0, ySm = null, sSm = null, anchor = null, settle = 0;
  var lastSeen = 0, lastFrame = 0, lastTick = 0, loopId = 0, wasMoving = false;
  var wide = function () { return window.innerWidth > 860; };

  var css = '#handBtn{width:34px;height:30px;padding:0;display:grid;place-items:center}#handBtn svg{width:17px;height:17px}' +
    '#handBtn[aria-pressed=true]{border-color:var(--gold);color:var(--gold)}#handBtn.busy{opacity:.6;pointer-events:none}' +
    '#handBtn.nudge{border-color:var(--gold);color:var(--gold);animation:handNudge 1s ease-in-out 5}' +
    '@keyframes handNudge{50%{transform:scale(1.22);box-shadow:0 0 0 6px color-mix(in srgb,var(--gold) 25%,transparent)}}' +
    '@media (max-width:860px){#handBtn,#handToast{display:none!important}}' +
    '#handPanel,#handToast{position:fixed;right:18px;bottom:52px;z-index:120;max-width:280px;background:var(--solid);border:1px solid var(--line);border-radius:14px;font-family:var(--mono);font-size:.74rem;color:var(--ink);box-shadow:0 18px 50px -20px #000;animation:handIn .3s ease-out}' +
    '@keyframes handIn{from{opacity:0;transform:translateY(12px)}}' +
    '#handPanel{display:grid;grid-template-columns:auto 1fr auto;gap:2px 10px;align-items:center;padding:10px 10px 10px 14px}#handPanel[hidden]{display:none}' +
    '#handPanel .ha{font-size:1.35rem;line-height:1;color:var(--gold);width:1em;text-align:center}' +
    '#handPanel p{margin:0}#handPanel small{grid-column:1/-1;color:var(--soft);font-size:.64rem}' +
    '#handPanel button{width:24px;height:24px;border-radius:50%;border:1px solid var(--line);background:0 0;color:var(--ink);font-size:.9rem;line-height:1;padding:0}' +
    '#handPanel video{position:absolute;width:2px;height:2px;opacity:0;pointer-events:none}' +
    '#handToast{padding:10px 14px}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function speak(text) {
    try {
      if (!window.speechSynthesis) return;
      speechSynthesis.cancel();
      var u = new SpeechSynthesisUtterance(text); u.lang = 'en-US'; u.rate = 1; u.pitch = 1;
      speechSynthesis.speak(u);
    } catch (e) { }
  }
  function build() {
    panel = document.createElement('div'); panel.id = 'handPanel'; panel.hidden = true;
    panel.setAttribute('role', 'status'); panel.setAttribute('aria-live', 'polite');
    panel.innerHTML = '<video playsinline muted></video><span class="ha" aria-hidden="true"></span><p></p>' +
      '<button type="button" aria-label="Turn off hand control">&times;</button>' +
      '<small>Open hand: move up or down to scroll. Fist: pause. Camera frames stay in your browser.</small>';
    document.body.appendChild(panel);
    video = panel.querySelector('video'); statusEl = panel.querySelector('p'); arrowEl = panel.querySelector('.ha');
    panel.querySelector('button').addEventListener('click', stop);
  }
  function say(t) { if (statusEl && statusEl.textContent !== t) statusEl.textContent = t; }

  var d = function (a, b) { return Math.hypot((a.x - b.x) * ASPECT, a.y - b.y); };
  // 21 landmarks -> palm height in the frame, hand length, open / fist
  function read(p) {
    var w = p[0], ext = 0;
    [[8, 6], [12, 10], [16, 14], [20, 18]].forEach(function (f) { if (d(p[f[0]], w) > d(p[f[1]], w) * 1.12) ext++; });
    return { y: (p[0].y + p[5].y + p[9].y + p[13].y + p[17].y) / 5, size: Math.max(d(p[0], p[9]), 0.02), fist: ext <= 1 };
  }
  function reset() { ySm = sSm = anchor = null; target = 0; }
  // called for every camera frame, with the landmarks of one hand or null
  function feed(p, now) {
    if (!p) { reset(); if (now - lastSeen > 500) { say('Hold up an open hand'); arrowEl.textContent = ''; } return; }
    lastSeen = now;
    var h = read(p);
    if (h.fist) { reset(); say('Paused. Open your hand to scroll'); arrowEl.textContent = '■'; return; }
    ySm = ySm === null ? h.y : ySm + (h.y - ySm) * 0.35;
    sSm = sSm === null ? h.size : sSm + (h.size - sSm) * 0.2;
    if (anchor === null) { anchor = ySm; settle = now + 350; }
    if (now < settle) { anchor = ySm; target = 0; }
    else {
      var off = (ySm - anchor) / sSm, a = Math.abs(off) - DEAD;
      target = a <= 0 ? 0 : (off < 0 ? -1 : 1) * Math.pow(Math.min(a / REACH, 1), 1.5) * MAX;
    }
    arrowEl.textContent = target > 0 ? '↓' : target < 0 ? '↑' : '•';
    say(target > 0 ? 'Scrolling down' : target < 0 ? 'Scrolling up' : 'Ready. Move your hand up or down');
  }
  function tick(now) {
    if (!on) return;
    loopId = requestAnimationFrame(tick);
    var dt = Math.min((now - lastTick) / 1000, 0.1); lastTick = now;
    if (document.hidden) return;
    if (video.readyState >= 2 && now - lastFrame > 30 && lm) {
      lastFrame = now;
      var res = null; try { res = lm.detectForVideo(video, now); } catch (e) { }
      feed(res && res.landmarks && res.landmarks[0] || null, now);
    }
    vel += (target - vel) * Math.min(1, dt * 7);
    var moving = Math.abs(vel) > 6;
    if (moving) {
      if (!wasMoving) window.dispatchEvent(new Event('wheel'));   // hands the page back from "Play the film"
      window.scrollTo({ top: window.scrollY + vel * dt, behavior: 'instant' });
    }
    wasMoving = moving;
  }

  function load() {
    if (lm) return Promise.resolve();
    return import(CFG.lib).then(function (m) {
      return m.FilesetResolver.forVisionTasks(CFG.wasm).then(function (fs) {
        var make = function (delegate) {
          return m.HandLandmarker.createFromOptions(fs, {
            baseOptions: { modelAssetPath: CFG.model, delegate: delegate }, runningMode: 'VIDEO', numHands: 1,
            minHandDetectionConfidence: 0.4, minHandPresenceConfidence: 0.4, minTrackingConfidence: 0.4
          });
        };
        return make('GPU').catch(function () { return make('CPU'); });
      });
    }).then(function (x) { lm = x; });
  }
  function start() {
    if (on || busy) return;
    busy = true; btn.classList.add('busy'); btn.classList.remove('nudge'); hideToast();
    if (!panel) build();
    panel.hidden = false; arrowEl.textContent = ''; say('Starting…');
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }, audio: false })
      .then(function (s) {
        stream = s; video.srcObject = s; say('Loading hand tracking…');
        var set = s.getVideoTracks()[0].getSettings(); if (set.width && set.height) ASPECT = set.width / set.height;
        return Promise.all([video.play(), load()]);
      })
      .then(function () {
        busy = false; btn.classList.remove('busy'); on = true; btn.setAttribute('aria-pressed', 'true');
        say('Hold up an open hand'); lastTick = performance.now(); loopId = requestAnimationFrame(tick);
        speak('Hand control is on. Hold up an open hand, then move it up or down to scroll. Make a fist to pause.');
      })
      .catch(function (e) {
        busy = false; btn.classList.remove('busy');
        say(e && (e.name === 'NotAllowedError' || e.name === 'NotFoundError') ? 'Camera not available. Allow access and try again.' : 'Hand tracking could not load. Try again.');
        release(); setTimeout(function () { if (!on && !busy) panel.hidden = true; }, 4500);
      });
  }
  function release() {
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (video) video.srcObject = null;
  }
  function stop() {
    on = false; vel = 0; reset(); cancelAnimationFrame(loopId);
    release(); if (panel) panel.hidden = true; btn.setAttribute('aria-pressed', 'false');
    try { window.speechSynthesis && speechSynthesis.cancel(); } catch (e) { }
  }
  btn.addEventListener('click', function () { on ? stop() : start(); });
  window.addEventListener('pagehide', stop);

  // Spoken invite. Browsers only allow speech after the visitor's first click
  // or key press, so it plays then, once per visit.
  function hideToast() { if (toast) { toast.remove(); toast = null; } }
  function invite(ev) {
    window.removeEventListener('pointerdown', invite, true); window.removeEventListener('keydown', invite, true);
    if (!wide() || on || busy || (ev.target && ev.target.closest && ev.target.closest('#handBtn'))) return;
    try { if (sessionStorage.getItem('jd-hand-invite')) return; sessionStorage.setItem('jd-hand-invite', '1'); } catch (e) { }
    speak('Tip. You can scroll this page with your hand, from a distance, like a sensor. Click the hand icon at the top to try it.');
    btn.classList.add('nudge');
    toast = document.createElement('div'); toast.id = 'handToast'; toast.setAttribute('role', 'status');
    toast.textContent = 'Tip: scroll this page with your hand, from a distance. Click the hand icon at the top.';
    document.body.appendChild(toast);
    setTimeout(hideToast, 8000);
  }
  window.addEventListener('pointerdown', invite, true); window.addEventListener('keydown', invite, true);
})();
