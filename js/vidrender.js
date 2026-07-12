/* =============================================================================
 * SKY PUSH — video export (replay editor 🎬 Render)
 * Frame-accurate OFFLINE rendering: steps the replay deterministically one
 * frame at a time (no realtime capture, no dropped frames), encodes with
 * WebCodecs (VP9) and muxes into a .webm via the vendored webm-muxer.
 * Settings: source (active clip / whole project), resolution up to 4K,
 * fps, bitrate up to 150 Mbps. Output downloads when done.
 * The main rAF loop must NOT drive the replay while `busy` (main.js checks).
 * ============================================================================= */
window.SKY = window.SKY || {};

SKY.VidRender = (function () {
  let ui = null;
  let src = 'clip', resW = 1920, fps = 60, mbps = 40;
  let cancelReq = false;

  const api = { busy: false };

  function $(id) { return document.getElementById(id); }

  function pill(group, attr, on) {
    group.querySelectorAll('.rp-pill').forEach(b =>
      b.classList.toggle('sel', b.dataset[attr] === String(on)));
  }

  function initUI() {
    ui = {
      ov: $('rp-renderov'), src: $('rr-src'), res: $('rr-res'), fps: $('rr-fps'),
      bit: $('rr-bit'), bitv: $('rr-bitv'), go: $('rr-go'), cancel: $('rr-cancel'),
      prog: $('rr-progress'), fill: $('rr-progfill'), txt: $('rr-progtxt'),
      note: $('rr-note'),
    };
    ui.src.addEventListener('click', (e) => {
      const b = e.target.closest('.rp-pill');
      if (b) { src = b.dataset.s; pill(ui.src, 's', src); }
    });
    ui.res.addEventListener('click', (e) => {
      const b = e.target.closest('.rp-pill');
      if (b) { resW = +b.dataset.r; pill(ui.res, 'r', resW); }
    });
    ui.fps.addEventListener('click', (e) => {
      const b = e.target.closest('.rp-pill');
      if (b) { fps = +b.dataset.f; pill(ui.fps, 'f', fps); }
    });
    ui.bit.addEventListener('input', () => {
      mbps = +ui.bit.value;
      ui.bitv.textContent = mbps + ' Mbps';
    });
    ui.go.addEventListener('click', () => { if (!api.busy) start(); });
    ui.cancel.addEventListener('click', () => {
      if (api.busy) { cancelReq = true; return; }
      ui.ov.classList.add('hidden');
    });
  }

  function setProgress(f, label) {
    ui.prog.classList.remove('hidden');
    ui.fill.style.width = (f * 100).toFixed(1) + '%';
    ui.txt.textContent = label;
  }

  async function start() {
    if (!window.VideoEncoder || !window.WebMMuxer) {
      ui.note.textContent = 'video export needs a Chromium browser with WebCodecs (Chrome 94+)';
      return;
    }
    const R = SKY.DBG.renderer, S = SKY.DBG.scene, C = SKY.DBG.camera;
    const info = SKY.Replay.exportInfo();
    const segs = (src === 'proj' && info.clips.length)
      ? info.clips
      : [{ i: info.activeClip, in: info.start, out: info.end }];
    const W = resW, H = Math.round(resW * 9 / 32) * 2;   // 16:9, even number
    const total = segs.reduce((s, g) => s + Math.max(1, Math.round((g.out - g.in) * fps)), 0);
    if (!total) return;

    api.busy = true;
    cancelReq = false;
    ui.go.classList.add('rp-disabled');
    ui.cancel.textContent = 'Stop';

    // render at the target resolution; CSS size stays fullscreen
    const prevPR = R.getPixelRatio();
    R.setPixelRatio(1);
    R.setSize(W, H, false);
    const prevAspect = C.aspect;
    C.aspect = W / H;
    C.updateProjectionMatrix();

    const muxer = new WebMMuxer.Muxer({
      target: new WebMMuxer.ArrayBufferTarget(),
      video: { codec: 'V_VP9', width: W, height: H, frameRate: fps },
    });
    const encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { console.error('encode error', e); cancelReq = true; },
    });
    encoder.configure({
      codec: 'vp09.00.10.08', width: W, height: H,
      bitrate: mbps * 1e6, framerate: fps,
    });

    let done = 0;
    try {
      for (const g of segs) {
        if (cancelReq) break;
        if (g.i >= 0) SKY.Replay.exportUseClip(g.i);
        SKY.Replay.exportSeek(g.in);
        const n = Math.max(1, Math.round((g.out - g.in) * fps));
        for (let k = 0; k < n; k++) {
          if (cancelReq) break;
          SKY.Replay.exportStep(1 / fps);
          if (!SKY.Replay.render(R, S, C)) R.render(S, C);
          const vf = new VideoFrame(R.domElement, {
            timestamp: Math.round(done * 1e6 / fps),
            duration: Math.round(1e6 / fps),
          });
          encoder.encode(vf, { keyFrame: done % (fps * 2) === 0 });
          vf.close();
          done++;
          // backpressure + keep the progress bar alive
          if (encoder.encodeQueueSize > 6) {
            while (encoder.encodeQueueSize > 2) await new Promise(r => setTimeout(r, 4));
          }
          if ((done & 3) === 0) {
            setProgress(done / total, `rendering ${done} / ${total}`);
            await new Promise(r => setTimeout(r, 0));
          }
        }
      }
      setProgress(1, 'finishing…');
      await encoder.flush();
      muxer.finalize();
      if (!cancelReq) {
        const blob = new Blob([muxer.target.buffer], { type: 'video/webm' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'skypush-' + H + 'p-' + Date.now() + '.webm';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 30000);
        setProgress(1, 'saved ✓ (' + (blob.size / 1e6).toFixed(1) + ' MB)');
      } else {
        setProgress(0, 'cancelled');
      }
    } catch (err) {
      console.error('render failed', err);
      setProgress(0, 'failed: ' + (err.message || err));
      try { encoder.close(); } catch (e2) {}
    }

    // restore the live renderer exactly as the settings had it
    R.setPixelRatio(prevPR);
    R.setSize(window.innerWidth, window.innerHeight);
    C.aspect = prevAspect;
    C.updateProjectionMatrix();
    SKY.Replay.exportDone();
    api.busy = false;
    ui.go.classList.remove('rp-disabled');
    ui.cancel.textContent = 'Close';
  }

  api.openDialog = function () {
    if (!ui) initUI();
    const info = SKY.Replay.exportInfo();
    // no clips defined -> "This clip" renders the whole timeline
    ui.note.textContent = window.VideoEncoder
      ? 'renders offline frame-by-frame — output is a .webm (VP9) download'
      : 'video export needs a Chromium browser with WebCodecs (Chrome 94+)';
    const projBtn = ui.src.querySelector('[data-s="proj"]');
    projBtn.classList.toggle('rp-disabled', !info.clips.length);
    if (!info.clips.length) { src = 'clip'; pill(ui.src, 's', 'clip'); }
    ui.prog.classList.add('hidden');
    ui.cancel.textContent = 'Cancel';
    ui.ov.classList.remove('hidden');
  };

  return api;
})();
