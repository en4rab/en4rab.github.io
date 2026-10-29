/*
 * TraceViewer -- an interactive Proxmark3-style plot of a .pm3 `lf sniff` trace with the decoded
 * XT27A protocol overlaid on the signal.  Needs decoder.js (window.XT27).
 *
 *   <div data-trace-viewer data-src="trace.pm3"></div>
 *   <div data-trace-viewer data-traces="a.pm3|Label A, b.pm3|Label B" data-height="520"></div>
 *
 * or  new TraceViewer(element, { src, traces: [{url, label}], height }).
 *
 * Mouse:  drag = pan, wheel = zoom (click the graph first, or hold Ctrl), shift/horizontal wheel =
 *         pan, Alt+wheel = vertical zoom, double-click = zoom in (Shift: out), click = marker A,
 *         Shift-click / right-click = marker B, click a coloured box = select that message.
 * Script: el.traceViewer.goto(a, b) / .gotoMessage(i) / .act('fit' | 'all'); links with data-tv-target
 *         (see the bottom of this file) drive a viewer from the prose.
 * Keys (graph focused): arrows pan, + / - zoom, Home fit, End whole trace, [ and ] previous/next message, Esc deselect.
 *
 * Written by Claude, 2026.
 *
 * To the extent possible under law, the author has dedicated all copyright
 * and related and neighboring rights to this software to the public domain
 * worldwide. This software is distributed without any warranty.
 *
 * See <https://creativecommons.org/publicdomain/zero/1.0/>.
 *
 * SPDX-License-Identifier: CC0-1.0 
 */
(function (root) {
  'use strict';

  const KIND = {
    READER: { dir: 'R→T', name: 'Reader → Tag', rgb: '78,161,255', fill: '#4ea1ff', ink: '#041a33' },
    TAG:    { dir: 'T→R', name: 'Tag → Reader', rgb: '255,176,74', fill: '#ffb04a', ink: '#2e1a00' },
    FIELD:  { dir: 'FLD',      name: 'Field reset',       rgb: '255,107,107', fill: '#ff6b6b', ink: '#330808' },
  };
  const TRACE_GREEN = '#66ff66', PM3_GREY = '#3c3c3c', T0_US = 8;
  const MONO = '11px ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", monospace';
  const SANS = '600 11px system-ui, -apple-system, "Segoe UI", sans-serif';
  const LANE_H = 68, AXIS_H = 30, STATUS_H = 40;
  const MIN_SPP = 1 / 48;

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const nextFrame = () => new Promise(r => setTimeout(r, 20));

  function niceStep(raw) {
    const p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }
  function fmtTime(samples) {
    const us = samples * T0_US;
    if (Math.abs(us) >= 1000) return +(us / 1000).toFixed(3) + ' ms';
    return +us.toFixed(1) + ' µs';
  }
  const fmtInt = n => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

  class TraceViewer {
    constructor(el, opts) {
      el.traceViewer = this;
      this.el = el;
      this.opts = opts || {};
      this.height = this.opts.height || 520;
      this.sig = null; this.msgs = []; this.n = 0; this.name = '';
      this.start = 0; this.spp = 1; this.yzoom = 1;
      this.show = { READER: true, TAG: true, FIELD: true };
      this.showBits = true;
      this.markA = null; this.markB = null;
      this.sel = -1; this.hover = -1; this.mouse = null;
      this.drag = null; this.raf = 0; this.envCache = null;
      this.buildDom();
      this.bind();
      this.resize();
      new ResizeObserver(() => this.resize()).observe(this.stage);
      const first = (this.opts.traces && this.opts.traces[0]) || (this.opts.src && { url: this.opts.src });
      if (first) this.loadUrl(first.url, first.label);
      else this.draw();
    }

    // ------------------------------------------------------------------ DOM
    buildDom() {
      const el = this.el;
      el.classList.add('tv');
      const traces = this.opts.traces || [];
      el.innerHTML = `
        <div class="tv-toolbar">
          <label class="tv-btn tv-open">Open .pm3…<input type="file" accept=".pm3,.txt,.gz" hidden></label>
          ${traces.length > 1 ? `<select class="tv-select" aria-label="Trace">${traces.map((t, i) =>
              `<option value="${i}">${esc(t.label || t.url)}</option>`).join('')}</select>` : ''}
          <span class="tv-group">
            <button class="tv-btn" data-act="zoomout" title="Zoom out (-)">−</button>
            <button class="tv-btn" data-act="zoomin" title="Zoom in (+)">+</button>
            <button class="tv-btn" data-act="fit" title="Frame the decoded activity (Home)">Fit</button>
            <button class="tv-btn" data-act="all" title="Show the whole recording, including the idle tail">All</button>
          </span>
          <span class="tv-group">
            <button class="tv-btn" data-act="prev" title="Previous message ([)">◀ Msg</button>
            <button class="tv-btn" data-act="next" title="Next message (])">Msg ▶</button>
          </span>
          <span class="tv-group">
            <button class="tv-btn" data-act="yout" title="Vertical zoom out (Alt+wheel)">Y−</button>
            <button class="tv-btn" data-act="yin" title="Vertical zoom in (Alt+wheel)">Y+</button>
            <button class="tv-btn" data-act="yfit" title="Fit the vertical scale to the visible signal">Y fit</button>
          </span>
          <span class="tv-group tv-legend">
            <button class="tv-chip" data-kind="READER" aria-pressed="true"><i style="background:${KIND.READER.fill}"></i>Reader → Tag</button>
            <button class="tv-chip" data-kind="TAG" aria-pressed="true"><i style="background:${KIND.TAG.fill}"></i>Tag → Reader</button>
            <button class="tv-chip" data-kind="FIELD" aria-pressed="true"><i style="background:${KIND.FIELD.fill}"></i>Field reset</button>
            <label class="tv-chip tv-check"><input type="checkbox" data-act="bits" checked>Bits</label>
          </span>
        </div>
        <div class="tv-stage" style="height:${this.height}px">
          <canvas class="tv-main" tabindex="0" aria-label="Trace graph: drag to pan, scroll to zoom"></canvas>
          <div class="tv-tip" hidden></div>
          <div class="tv-hint">Click the graph, then scroll to zoom · drag to pan</div>
          <div class="tv-busy" hidden></div>
        </div>
        <canvas class="tv-overview" aria-label="Trace overview"></canvas>
        <div class="tv-detail"><span class="tv-muted">Click a coloured box on the graph (or a row below) to see what that part of the signal means.</span></div>
        <div class="tv-list" tabindex="0"></div>`;
      const q = s => el.querySelector(s);
      this.stage = q('.tv-stage'); this.cv = q('.tv-main'); this.ov = q('.tv-overview');
      this.tip = q('.tv-tip'); this.hint = q('.tv-hint'); this.busy = q('.tv-busy');
      this.detail = q('.tv-detail'); this.list = q('.tv-list'); this.select = q('.tv-select');
      this.ctx = this.cv.getContext('2d'); this.octx = this.ov.getContext('2d');
    }

    bind() {
      const el = this.el, cv = this.cv;
      el.querySelector('input[type=file]').addEventListener('change', e => {
        if (e.target.files[0]) this.loadFile(e.target.files[0]);
        e.target.value = '';
      });
      if (this.select) this.select.addEventListener('change', () => {
        const t = this.opts.traces[+this.select.value];
        this.loadUrl(t.url, t.label);
      });
      el.querySelector('.tv-toolbar').addEventListener('click', e => {
        const b = e.target.closest('[data-act],[data-kind]');
        if (!b) return;
        if (b.dataset.kind) {
          this.show[b.dataset.kind] = !this.show[b.dataset.kind];
          b.setAttribute('aria-pressed', this.show[b.dataset.kind]);
          this.applyListFilter(); this.draw();
        } else if (b.dataset.act !== 'bits') this.act(b.dataset.act);
      });
      el.querySelector('[data-act=bits]').addEventListener('change', e => { this.showBits = e.target.checked; this.draw(); });

      for (const t of ['dragenter', 'dragover']) el.addEventListener(t, e => { e.preventDefault(); el.classList.add('tv-drag'); });
      for (const t of ['dragleave', 'drop']) el.addEventListener(t, e => { e.preventDefault(); el.classList.remove('tv-drag'); });
      el.addEventListener('drop', e => { if (e.dataTransfer.files[0]) this.loadFile(e.dataTransfer.files[0]); });

      cv.addEventListener('pointerdown', e => this.onDown(e));
      cv.addEventListener('pointermove', e => this.onMove(e));
      cv.addEventListener('pointerup', e => this.onUp(e));
      cv.addEventListener('pointercancel', () => { this.drag = null; });
      cv.addEventListener('pointerleave', () => { this.mouse = null; this.hover = -1; this.tip.hidden = true; this.draw(); });
      cv.addEventListener('contextmenu', e => {
        e.preventDefault();
        const p = this.pos(e);
        if (this.sig && p.x >= this.GUT) { this.markB = clamp(Math.round(this.sampleAt(p.x)), 0, this.n - 1); this.draw(); }
      });
      cv.addEventListener('dblclick', e => {
        if (!this.sig) return;
        const p = this.pos(e);
        if (p.x >= this.GUT) this.zoomAt(p.x, e.shiftKey ? 2 : 0.5);
      });
      cv.addEventListener('wheel', e => this.onWheel(e), { passive: false });
      cv.addEventListener('keydown', e => this.onKey(e));
      cv.addEventListener('focus', () => { this.hint.classList.add('tv-hint-off'); });

      // overview
      let od = null;
      const ovSample = e => (e.clientX - this.ov.getBoundingClientRect().left) / this.ov.clientWidth * this.overviewEnd();
      this.ov.addEventListener('pointerdown', e => {
        if (!this.sig) return;
        this.ov.setPointerCapture(e.pointerId);
        const s = ovSample(e), span = this.PW * this.spp;
        od = s >= this.start && s <= this.start + span ? s - this.start : span / 2;
        this.start = s - od; this.clampView(); this.draw();
      });
      this.ov.addEventListener('pointermove', e => {
        if (od === null) return;
        this.start = ovSample(e) - od; this.clampView(); this.draw();
      });
      this.ov.addEventListener('pointerup', () => { od = null; });
      this.ov.addEventListener('pointercancel', () => { od = null; });

      this.list.addEventListener('click', e => {
        const tr = e.target.closest('tr[data-i]');
        if (tr) { this.select_(+tr.dataset.i); this.zoomToMessage(+tr.dataset.i); }
      });
      this.list.addEventListener('mouseover', e => {
        const tr = e.target.closest('tr[data-i]');
        const i = tr ? +tr.dataset.i : -1;
        if (i !== this.hover) { this.hover = i; this.draw(); }
      });
      this.list.addEventListener('mouseleave', () => { this.hover = -1; this.draw(); });
    }

    // ------------------------------------------------------------------ loading
    setBusy(text) {
      this.busy.hidden = !text;
      this.busy.textContent = text || '';
    }

    async loadUrl(url, label) {
      this.setBusy('Loading ' + (label || url) + '…');
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const text = await bytesToText(await res.arrayBuffer());
        await this.loadText(text, label || url.split('/').pop());
      } catch (err) {
        const file = location.protocol === 'file:';
        this.setBusy(file
          ? 'A page opened from disk cannot fetch trace files. Use “Open .pm3…”, drop a file here, or serve this folder (python -m http.server).'
          : 'Could not load ' + url + ' (' + err.message + '). Use “Open .pm3…” or drop a file here.');
      }
    }

    async loadFile(file) {
      this.setBusy('Reading ' + file.name + '…');
      try {
        const text = await bytesToText(await file.arrayBuffer());
        await this.loadText(text, file.name);
      } catch (err) { this.setBusy('Could not read ' + file.name + ': ' + err.message); }
    }

    async loadText(text, name) {
      this.setBusy('Decoding ' + name + '…');
      await nextFrame();
      const sig = XT27.parsePm3(text);
      if (sig.length < 100) { this.setBusy(name + ' does not look like a .pm3 trace (expected one integer per line).'); return; }
      const t0 = performance.now();
      const msgs = XT27.decodeTrace(sig);
      this.setTrace(name, sig, msgs);
      this.decodeMs = performance.now() - t0;
      this.setBusy('');
    }

    setTrace(name, sig, msgs) {
      this.name = name; this.sig = sig; this.msgs = msgs; this.n = sig.length;
      this.markA = this.markB = null; this.sel = -1; this.hover = -1; this.yzoom = 1;
      this.envCache = null;
      this.active = this.activeRange();
      this.buildList();
      this.renderDetail(-1);
      this.act('fit');
      this.el.dispatchEvent(new CustomEvent('tracechange', { detail: { name, samples: sig.length, messages: msgs.length } }));
    }

    // Extent of the decoded activity (a capture is mostly idle tail), padded a little.
    activeRange() {
      if (!this.msgs.length) return [0, this.n];
      let a = Infinity, b = -Infinity;
      for (const m of this.msgs) { a = Math.min(a, m.a); b = Math.max(b, m.b); }
      const pad = Math.max(200, (b - a) * 0.03);
      return [Math.max(0, a - pad), Math.min(this.n, b + pad)];
    }

    // Upper end of the overview: the active region, or further if the main view has moved past it.
    overviewEnd() {
      return Math.min(this.n, Math.max(this.active[1], this.start + this.PW * this.spp));
    }

    // ------------------------------------------------------------------ geometry
    resize() {
      const w = Math.max(280, Math.floor(this.stage.clientWidth)), h = this.height;
      const dpr = window.devicePixelRatio || 1;
      this.W = w; this.H = h; this.dpr = dpr;
      this.GUT = w < 560 ? 44 : 58;
      this.PW = w - this.GUT;
      this.sigTop = LANE_H; this.sigBot = h - STATUS_H - AXIS_H;
      for (const [c, ww, hh] of [[this.cv, w, h], [this.ov, w, 54]]) {
        c.width = Math.round(ww * dpr); c.height = Math.round(hh * dpr);
        c.style.height = hh + 'px';
      }
      this.envCache = null;
      if (this.sig) this.clampView();
      this.draw();
    }

    sampleAt(px) { return this.start + (px - this.GUT) * this.spp; }
    sx(s) { return this.GUT + (s - this.start) / this.spp; }
    yHalf() { return 150 / this.yzoom; }
    sy(v) {
      const h = this.yHalf();
      return this.sigTop + (h - v) / (2 * h) * (this.sigBot - this.sigTop);
    }

    clampView() {
      const maxSpp = Math.max(MIN_SPP, this.n / this.PW);
      this.spp = clamp(this.spp, MIN_SPP, maxSpp);
      this.start = clamp(this.start, 0, Math.max(0, this.n - this.PW * this.spp));
    }

    zoomAt(px, factor) { // factor < 1 zooms in
      const s = this.sampleAt(px);
      this.spp *= factor; this.clampView();
      this.start = s - (px - this.GUT) * this.spp; this.clampView();
      this.draw();
    }

    zoomToMessage(i) {
      const m = this.msgs[i];
      if (!m) return;
      const pad = Math.max((m.b - m.a) * 0.3, 150);
      this.spp = (m.b - m.a + 2 * pad) / this.PW;
      this.start = m.a - pad;
      this.clampView(); this.draw();
    }

    visibleMsgs() {
      return this.msgs.map((m, i) => i).filter(i => this.show[this.msgs[i].kind]);
    }

    // Public: show samples [a, b] (T0), optionally selecting message `sel`.
    goto(a, b, sel) {
      if (!this.sig) return;
      this.spp = (b - a) / this.PW; this.start = a; this.clampView();
      if (sel !== undefined) this.select_(sel); else this.draw();
    }

    gotoMessage(i) { this.select_(i); this.zoomToMessage(i); }

    stepMessage(dir) {
      const vis = this.visibleMsgs();
      if (!vis.length) return;
      const centre = this.start + this.PW * this.spp / 2;
      let target;
      if (this.sel >= 0 && vis.includes(this.sel)) target = vis[clamp(vis.indexOf(this.sel) + dir, 0, vis.length - 1)];
      else if (dir > 0) target = vis.find(i => this.msgs[i].a > centre) ?? vis[vis.length - 1];
      else target = [...vis].reverse().find(i => this.msgs[i].b < centre) ?? vis[0];
      this.select_(target); this.zoomToMessage(target);
    }

    act(a) {
      if (!this.sig && a !== 'noop') return;
      const cx = this.GUT + this.PW / 2;
      switch (a) {
        case 'fit': {
          const [a, b] = this.active;
          this.spp = (b - a) / this.PW; this.start = a; this.clampView(); this.draw(); break;
        }
        case 'all': this.spp = this.n / this.PW; this.start = 0; this.clampView(); this.draw(); break;
        case 'zoomin': this.zoomAt(cx, 0.5); break;
        case 'zoomout': this.zoomAt(cx, 2); break;
        case 'prev': this.stepMessage(-1); break;
        case 'next': this.stepMessage(1); break;
        case 'yin': this.yzoom = Math.min(20, this.yzoom * 1.5); this.draw(); break;
        case 'yout': this.yzoom = Math.max(0.5, this.yzoom / 1.5); this.draw(); break;
        case 'yfit': {
          const i0 = Math.max(0, Math.floor(this.start)), i1 = Math.min(this.n, Math.ceil(this.start + this.PW * this.spp));
          let m = 1;
          for (let i = i0; i < i1; i++) m = Math.max(m, Math.abs(this.sig[i]));
          this.yzoom = clamp(150 / (m * 1.12), 0.5, 20); this.draw(); break;
        }
      }
    }

    // ------------------------------------------------------------------ input
    pos(e) { const r = this.cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

    msgAt(s, y, tolPx) {
      const tol = (tolPx || 0) * this.spp;
      let best = -1, bl = Infinity;
      for (let i = 0; i < this.msgs.length; i++) {
        const m = this.msgs[i];
        if (!this.show[m.kind] || s < m.a - tol || s > m.b + tol) continue;
        const len = m.b - m.a;
        if (len < bl) { bl = len; best = i; }
      }
      return best;
    }

    onDown(e) {
      if (!this.sig || e.button !== 0) return;
      const p = this.pos(e);
      if (p.x < this.GUT) return;
      this.cv.focus({ preventScroll: true });
      this.cv.setPointerCapture(e.pointerId);
      this.drag = { x: p.x, y: p.y, start: this.start, moved: false, shift: e.shiftKey };
    }

    onMove(e) {
      const p = this.pos(e);
      this.mouse = p;
      if (this.drag) {
        const dx = p.x - this.drag.x;
        if (Math.abs(dx) > 3) this.drag.moved = true;
        if (this.drag.moved) { this.start = this.drag.start - dx * this.spp; this.clampView(); this.tip.hidden = true; }
      } else this.updateHover(p);
      this.draw();
    }

    onUp(e) {
      const d = this.drag;
      this.drag = null;
      if (!d || d.moved) return;
      const s = this.sampleAt(d.x), i = this.msgAt(s, d.y, 3);
      if (d.y >= LANE_H || i < 0) {
        const k = clamp(Math.round(s), 0, this.n - 1);
        if (d.shift) this.markB = k; else this.markA = k;
      }
      if (i >= 0) this.select_(i);
      this.draw();
    }

    updateHover(p) {
      if (!this.sig || p.x < this.GUT || p.y > this.sigBot + AXIS_H) { this.tip.hidden = true; this.hover = -1; return; }
      const s = this.sampleAt(p.x), i = this.msgAt(s, p.y, 3);
      this.hover = i;
      const idx = clamp(Math.round(s), 0, this.n - 1);
      let html = '';
      if (i >= 0) {
        const m = this.msgs[i], k = KIND[m.kind];
        html += `<div class="tv-tip-h" style="color:${k.fill}">${k.dir} · ${esc(m.short)}</div>`;
        if (m.kind !== 'FIELD') html += `<div class="tv-tip-hex">${esc(m.hex)}  <span>(${m.bits.length} bits, ${m.coding})</span></div>`;
        html += `<div class="tv-tip-note">${esc(m.note)}</div>`;
      }
      html += `<div class="tv-tip-s">sample ${fmtInt(idx)} · ${fmtTime(idx)} · value ${this.sig[idx]}</div>`;
      this.tip.innerHTML = html;
      this.tip.hidden = false;
      const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
      let x = p.x + 16, y = p.y + 18;
      if (x + tw > this.W - 4) x = p.x - tw - 12;
      if (y + th > this.H - 4) y = Math.max(4, p.y - th - 12);
      this.tip.style.transform = `translate(${Math.max(4, x)}px,${y}px)`;
    }

    onWheel(e) {
      if (!this.sig) return;
      const active = document.activeElement === this.cv;
      if (!(e.ctrlKey || e.metaKey || active)) return; // let the page scroll until the graph is focused
      e.preventDefault();
      const p = this.pos(e), unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      const dy = e.deltaY * unit, dx = e.deltaX * unit;
      if (e.altKey) { this.yzoom = clamp(this.yzoom * Math.exp(-dy * 0.002), 0.5, 20); this.draw(); }
      else if (e.shiftKey || Math.abs(dx) > Math.abs(dy)) {
        this.start += (dx || dy) * this.spp; this.clampView(); this.draw();
      } else this.zoomAt(Math.max(p.x, this.GUT), Math.exp(dy * (e.ctrlKey ? 0.01 : 0.0025)));
    }

    onKey(e) {
      if (!this.sig) return;
      const span = this.PW * this.spp;
      const k = e.key;
      if (k === 'ArrowLeft' || k === 'ArrowRight') { this.start += (k === 'ArrowLeft' ? -1 : 1) * span * (e.shiftKey ? 0.9 : 0.2); this.clampView(); this.draw(); }
      else if (k === '+' || k === '=') this.act('zoomin');
      else if (k === '-' || k === '_') this.act('zoomout');
      else if (k === 'Home') this.act('fit');
      else if (k === 'End') this.act('all');
      else if (k === '[') this.act('prev');
      else if (k === ']') this.act('next');
      else if (k === 'Escape') { this.select_(-1); this.markA = this.markB = null; this.draw(); }
      else return;
      e.preventDefault();
    }

    // ------------------------------------------------------------------ list + detail
    buildList() {
      let prevEnd = null, rows = '';
      this.msgs.forEach((m, i) => {
        const k = KIND[m.kind];
        const gap = prevEnd === null ? '' : '+' + (m.start - prevEnd);
        prevEnd = m.end;
        const dec = m.decrypt ? `<div class="tv-dec">ct ${m.decrypt.ct} → pt <b>${m.decrypt.pt}</b> · ${esc(m.decrypt.cmd)}</div>` : '';
        const note = m.note.split('\n')[0];
        rows += `<tr data-i="${i}" data-kind="${m.kind}"><td class="tv-n">${i + 1}</td>`
          + `<td class="tv-t">${fmtInt(m.start)}<small>${fmtTime(m.start)}</small></td>`
          + `<td class="tv-g">${gap}</td>`
          + `<td><span class="tv-dir" style="background:${k.fill};color:${k.ink}">${k.dir}</span></td>`
          + `<td class="tv-b">${m.kind === 'FIELD' ? '' : m.bits.length}</td>`
          + `<td class="tv-hexc">${esc(m.hex)}</td>`
          + `<td class="tv-mean">${esc(note)}${dec}</td></tr>`;
      });
      this.list.innerHTML = `<table><thead><tr><th>#</th><th>Start (T0)</th><th>Gap</th><th>Dir</th><th>Bits</th><th>Data</th><th>Meaning</th></tr></thead><tbody>${rows}</tbody></table>`;
      this.applyListFilter();
    }

    applyListFilter() {
      this.list.querySelectorAll('tr[data-kind]').forEach(tr => { tr.hidden = !this.show[tr.dataset.kind]; });
    }

    select_(i) {
      this.sel = i;
      this.list.querySelectorAll('tr.tv-sel').forEach(tr => tr.classList.remove('tv-sel'));
      if (i >= 0) {
        const tr = this.list.querySelector(`tr[data-i="${i}"]`);
        if (tr) {
          tr.classList.add('tv-sel');
          const top = tr.offsetTop, h = this.list.clientHeight;
          if (top < this.list.scrollTop + 28 || top + tr.offsetHeight > this.list.scrollTop + h) this.list.scrollTop = top - h / 2;
        }
      }
      this.renderDetail(i);
      this.draw();
    }

    renderDetail(i) {
      const m = this.msgs[i];
      if (!m) {
        this.detail.innerHTML = this.sig
          ? `<span class="tv-muted">${this.msgs.length} messages decoded from ${fmtInt(this.n)} samples (${fmtTime(this.n)}). Click a coloured box on the graph, or a row below.</span>`
          : '<span class="tv-muted">No trace loaded.</span>';
        return;
      }
      const k = KIND[m.kind];
      let bits = '';
      if (m.kind !== 'FIELD') {
        const groups = m.bits.match(/.{1,8}/g) || [];
        bits = (m.sof ? '<span class="tv-dim">11111</span> ' : '')
          + groups.map(g => esc(g).replace(/\?/g, '<b class="tv-q">?</b>')).join(' ');
      }
      const lines = m.note.split('\n');
      this.detail.innerHTML = `
        <div class="tv-d-head"><span class="tv-dir" style="background:${k.fill};color:${k.ink}">${k.dir}</span>
          <strong>${k.name}</strong>
          <span class="tv-muted">message ${i + 1} of ${this.msgs.length} · samples ${fmtInt(m.a)}–${fmtInt(m.b)} (${fmtTime(m.b - m.a)})${m.kind !== 'FIELD' ? ` · ${m.bits.length} bits · ${m.coding}` : ''}</span></div>
        ${m.kind !== 'FIELD' ? `<div class="tv-d-row"><span>Data</span><code>${esc(m.hex)}</code></div><div class="tv-d-row"><span>Bits</span><code>${bits}</code></div>` : ''}
        <div class="tv-d-row"><span>Meaning</span><div>${lines.map(l => `<div class="${/^(DECRYPT|\*\*\*)/.test(l) ? 'tv-d-dec' : ''}">${esc(l)}</div>`).join('')}</div></div>`;
    }

    // ------------------------------------------------------------------ drawing
    draw() {
      if (this.raf) return;
      this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(); this.paintOverview(); });
    }

    paint() {
      const ctx = this.ctx, W = this.W, H = this.H, GUT = this.GUT, PW = this.PW;
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = PM3_GREY; ctx.fillRect(0, 0, GUT, H - STATUS_H);
      ctx.fillRect(0, H - STATUS_H, W, STATUS_H);
      if (!this.sig) {
        ctx.fillStyle = TRACE_GREEN; ctx.font = '14px system-ui, sans-serif'; ctx.textAlign = 'center';
        ctx.fillText('Drop a .pm3 trace here, or use “Open .pm3…”', GUT + PW / 2, H / 2);
        ctx.textAlign = 'left';
        return;
      }
      const s0 = this.start, s1 = this.start + PW * this.spp, cellPx = 1 / this.spp;
      const vis = [];
      for (let i = 0; i < this.msgs.length; i++) {
        const m = this.msgs[i];
        if (this.show[m.kind] && m.b >= s0 && m.a <= s1) vis.push(i);
      }

      ctx.save();
      ctx.beginPath(); ctx.rect(GUT, 0, PW, H - STATUS_H); ctx.clip();

      // decoded bands behind the signal
      for (const i of vis) {
        const m = this.msgs[i], k = KIND[m.kind];
        const x0 = this.sx(m.a), w = Math.max(2, this.sx(m.b) - x0);
        ctx.fillStyle = `rgba(${k.rgb},${i === this.hover || i === this.sel ? 0.26 : 0.12})`;
        ctx.fillRect(x0, this.sigTop, w, this.sigBot - this.sigTop);
        ctx.fillStyle = `rgba(${k.rgb},0.55)`;
        ctx.fillRect(x0, this.sigTop, 1, this.sigBot - this.sigTop);
        ctx.fillRect(x0 + w - 1, this.sigTop, 1, this.sigBot - this.sigTop);
      }
      // bit-cell boundaries through the signal
      if (this.showBits) {
        ctx.lineWidth = 1;
        for (const i of vis) {
          const m = this.msgs[i];
          if (m.kind === 'FIELD' || cellPx * 8 < 7) continue;
          ctx.strokeStyle = `rgba(${KIND[m.kind].rgb},0.28)`;
          ctx.beginPath();
          for (const c of m.cells) {
            const x = Math.round(this.sx(c)) + 0.5;
            if (x < GUT || x > W) continue;
            ctx.moveTo(x, this.sigTop); ctx.lineTo(x, this.sigBot);
          }
          ctx.stroke();
        }
      }
      // zero line
      ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1;
      const y0 = Math.round(this.sy(0)) + 0.5;
      ctx.beginPath(); ctx.moveTo(GUT, y0); ctx.lineTo(W, y0); ctx.stroke();

      this.paintSignal();

      // markers
      this.paintMarker(this.markA, '#ffffff');
      this.paintMarker(this.markB, '#5fe0ff');
      if (this.mouse && !this.drag && this.mouse.x >= GUT) {
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.beginPath(); ctx.moveTo(Math.round(this.mouse.x) + 0.5, this.sigTop); ctx.lineTo(Math.round(this.mouse.x) + 0.5, this.sigBot); ctx.stroke();
      }
      this.paintLane(vis);
      ctx.restore();

      this.paintYAxis();
      this.paintTimeAxis();
      this.paintStatus();
    }

    paintSignal() {
      const ctx = this.ctx, sig = this.sig, n = this.n, st = this.start, spp = this.spp, GUT = this.GUT, PW = this.PW;
      ctx.save();
      ctx.beginPath(); ctx.rect(GUT, this.sigTop, PW, this.sigBot - this.sigTop); ctx.clip();
      ctx.strokeStyle = TRACE_GREEN; ctx.fillStyle = TRACE_GREEN; ctx.lineWidth = 1;
      ctx.beginPath();
      if (spp <= 1) {
        const i0 = Math.max(0, Math.floor(st) - 1), i1 = Math.min(n - 1, Math.ceil(st + PW * spp) + 1);
        for (let i = i0; i <= i1; i++) {
          const x = GUT + (i - st) / spp, y = this.sy(sig[i]);
          if (i === i0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
        if (spp <= 1 / 6) {
          for (let i = i0; i <= i1; i++) ctx.fillRect(GUT + (i - st) / spp - 1.5, this.sy(sig[i]) - 1.5, 3, 3);
        }
      } else {
        for (let col = 0; col < PW; col++) {
          const a = Math.max(0, Math.floor(st + col * spp) - 1);
          let b = Math.min(n, Math.max(a + 2, Math.floor(st + (col + 1) * spp)));
          if (a >= n) break;
          let mn = sig[a], mx = mn;
          for (let i = a + 1; i < b; i++) { const v = sig[i]; if (v < mn) mn = v; else if (v > mx) mx = v; }
          const x = GUT + col + 0.5;
          let ya = this.sy(mx), yb = this.sy(mn);
          if (yb - ya < 1) yb = ya + 1;
          ctx.moveTo(x, ya); ctx.lineTo(x, yb);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    paintMarker(s, color) {
      if (s === null) return;
      const x = Math.round(this.sx(s)) + 0.5;
      if (x < this.GUT || x > this.W) return;
      const ctx = this.ctx;
      ctx.strokeStyle = color; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, this.sigTop); ctx.lineTo(x, this.sigBot); ctx.stroke();
    }

    paintLane(vis) {
      const ctx = this.ctx, cellPx = 1 / this.spp, sofColor = '#8e9aab';
      ctx.fillStyle = '#0b0f14'; ctx.fillRect(this.GUT, 0, this.PW, LANE_H);
      ctx.fillStyle = '#26303b'; ctx.fillRect(this.GUT, LANE_H - 1, this.PW, 1);
      for (const i of vis) {
        const m = this.msgs[i], k = KIND[m.kind], hot = i === this.hover || i === this.sel;
        const x0 = this.sx(m.a), x1 = this.sx(m.b), w = Math.max(3, x1 - x0);
        // row A: label box
        ctx.fillStyle = k.fill; ctx.globalAlpha = hot ? 1 : 0.92;
        ctx.fillRect(x0, 4, w - (w > 5 ? 1 : 0), 21);
        ctx.globalAlpha = 1;
        if (w > 28) {
          ctx.save();
          ctx.beginPath(); ctx.rect(x0, 4, w - 2, 21); ctx.clip();
          ctx.fillStyle = k.ink; ctx.font = SANS; ctx.textBaseline = 'middle';
          ctx.fillText(`${k.dir}  ${m.short}`, Math.max(x0, this.GUT) + 5, 15);
          ctx.restore();
        }
        if (m.kind === 'FIELD') {
          if (hot) this.outline(x0, 4, w, LANE_H - 8);
          continue;
        }
        // row B: data
        ctx.fillStyle = `rgba(${k.rgb},0.16)`; ctx.fillRect(x0, 27, w, 15);
        if (w > 50) {
          ctx.save();
          ctx.beginPath(); ctx.rect(x0, 27, w - 2, 15); ctx.clip();
          ctx.fillStyle = '#e8eef5'; ctx.font = MONO; ctx.textBaseline = 'middle';
          const txt = m.decrypt ? `ct ${m.hex}  →  pt 0x${m.decrypt.pt}` : m.hex;
          ctx.fillText(txt, Math.max(x0, this.GUT) + 5, 35);
          ctx.restore();
        }
        // row C: bit cells
        if (this.showBits && cellPx * 8 >= 5) {
          const raw = m.rawBits;
          ctx.textBaseline = 'middle'; ctx.textAlign = 'center'; ctx.font = MONO;
          for (let c = 0; c < raw.length; c++) {
            const xa = this.sx(m.cells[c]), xb = this.sx(m.cells[c + 1]);
            if (xb < this.GUT || xa > this.W) continue;
            const isSof = c < m.sof, bit = raw[c];
            ctx.fillStyle = `rgba(${k.rgb},${c % 2 ? 0.2 : 0.3})`;
            ctx.fillRect(xa, 44, xb - xa - 1, 20);
            if (xb - xa >= 9) {
              ctx.fillStyle = bit === '?' ? '#ff6b6b' : isSof ? sofColor : '#f3f7fb';
              ctx.fillText(bit, (xa + xb) / 2, 54.5);
            }
          }
          ctx.textAlign = 'left';
        } else {
          ctx.fillStyle = `rgba(${k.rgb},0.3)`; ctx.fillRect(x0, 44, w, 20);
        }
        if (hot) this.outline(x0, 4, w, LANE_H - 8);
      }
    }

    outline(x, y, w, h) {
      this.ctx.strokeStyle = '#fff'; this.ctx.lineWidth = 1.5;
      this.ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    }

    paintYAxis() {
      const ctx = this.ctx, GUT = this.GUT, half = this.yHalf();
      const step = niceStep(2 * half / 9);
      ctx.save();
      ctx.beginPath(); ctx.rect(0, this.sigTop - 8, GUT, this.sigBot - this.sigTop + 16); ctx.clip();
      ctx.font = MONO; ctx.fillStyle = TRACE_GREEN; ctx.strokeStyle = TRACE_GREEN; ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
      for (let v = Math.ceil(-half / step) * step; v <= half + 1e-9; v += step) {
        if (Math.abs(v) < step / 2) continue;
        const y = Math.round(this.sy(v)) + 0.5;
        ctx.beginPath(); ctx.moveTo(GUT - 8, y); ctx.lineTo(GUT, y); ctx.stroke();
        ctx.fillText(String(+v.toFixed(2)), GUT - 11, y);
      }
      ctx.restore();
      ctx.textAlign = 'left';
      ctx.fillStyle = '#9aa7b4'; ctx.font = SANS; ctx.textBaseline = 'middle';
      ctx.fillText('ADC', 6, 34);
    }

    paintTimeAxis() {
      const ctx = this.ctx, top = this.sigBot, GUT = this.GUT;
      ctx.fillStyle = '#151a20'; ctx.fillRect(GUT, top, this.PW, AXIS_H);
      ctx.fillStyle = '#2b3440'; ctx.fillRect(GUT, top, this.PW, 1);
      const step = niceStep(this.spp * 120), s0 = this.start, s1 = this.start + this.PW * this.spp;
      ctx.save();
      ctx.beginPath(); ctx.rect(GUT, top, this.PW, AXIS_H); ctx.clip();
      ctx.font = MONO; ctx.textBaseline = 'top'; ctx.textAlign = 'left';
      for (let s = Math.ceil(s0 / step) * step; s <= s1; s += step) {
        const x = Math.round(this.sx(s)) + 0.5;
        ctx.strokeStyle = '#6a7684'; ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, top + 5); ctx.stroke();
        ctx.fillStyle = '#c3cdd8'; ctx.fillText(fmtInt(s), x + 3, top + 3);
        ctx.fillStyle = '#7d8b99'; ctx.fillText(fmtTime(s), x + 3, top + 15);
      }
      ctx.restore();
    }

    paintStatus() {
      const ctx = this.ctx, sig = this.sig, n = this.n, H = this.H;
      const i0 = Math.max(0, Math.floor(this.start)), i1 = Math.min(n, Math.ceil(this.start + this.PW * this.spp));
      let mn = 127, mx = -128, sum = 0;
      for (let i = i0; i < i1; i++) { const v = sig[i]; if (v < mn) mn = v; if (v > mx) mx = v; sum += v; }
      const mean = i1 > i0 ? Math.round(sum / (i1 - i0)) : 0;
      const mk = (name, s) => s === null ? '' : `${name}={Pos=${s} Val=${sig[s]}}`;
      let dt = '';
      if (this.markA !== null && this.markB !== null) {
        const d = this.markB - this.markA;
        dt = `  dt=${d} T0 (${fmtTime(Math.abs(d))})`;
      }
      ctx.font = MONO; ctx.fillStyle = TRACE_GREEN; ctx.textBaseline = 'alphabetic';
      ctx.fillText(`@${i0}..${i1}  zoom=${(1 / this.spp).toFixed(3)}  ${fmtTime(i1 - i0)} in view${dt}`, 10, H - STATUS_H + 15);
      ctx.fillText(`max=${mx}  min=${mn}  mean=${mean}  n=${i1 - i0}/${n}   ${mk('MarkerA', this.markA)}  ${mk('MarkerB', this.markB)}`, 10, H - STATUS_H + 32);
      ctx.fillStyle = '#9aa7b4'; ctx.textAlign = 'right';
      ctx.fillText(this.name, this.W - 10, H - STATUS_H + 15);
      ctx.textAlign = 'left';
    }

    paintOverview() {
      const c = this.octx, W = this.W, H = 54;
      c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      c.fillStyle = '#000'; c.fillRect(0, 0, W, H);
      if (!this.sig) return;
      const end = this.overviewEnd();
      if (!this.envCache || this.envCache.w !== W || this.envCache.end !== end) {
        const env = new Float32Array(W * 2), per = end / W;
        for (let x = 0; x < W; x++) {
          const a = Math.floor(x * per), b = Math.max(a + 1, Math.min(this.n, Math.floor((x + 1) * per)));
          let mn = 127, mx = -128;
          for (let i = a; i < b; i++) { const v = this.sig[i]; if (v < mn) mn = v; if (v > mx) mx = v; }
          env[2 * x] = mn; env[2 * x + 1] = mx;
        }
        this.envCache = { w: W, end, env };
      }
      const e = this.envCache.env, y = v => 14 + (127 - v) / 255 * (H - 18);
      c.strokeStyle = 'rgba(102,255,102,0.75)'; c.lineWidth = 1; c.beginPath();
      for (let x = 0; x < W; x++) { c.moveTo(x + 0.5, y(e[2 * x + 1])); c.lineTo(x + 0.5, Math.max(y(e[2 * x]), y(e[2 * x + 1]) + 1)); }
      c.stroke();
      for (const m of this.msgs) {
        if (!this.show[m.kind] || m.a > end) continue;
        c.fillStyle = KIND[m.kind].fill;
        c.fillRect(Math.floor(m.a / end * W), 2, Math.max(1, Math.ceil((m.b - m.a) / end * W)), 7);
      }
      const vx = this.start / end * W, vw = Math.max(3, this.PW * this.spp / end * W);
      c.fillStyle = 'rgba(255,255,255,0.14)'; c.fillRect(vx, 0, vw, H);
      c.strokeStyle = '#fff'; c.strokeRect(vx + 0.5, 0.5, vw - 1, H - 1);
    }
  }

  // Gunzip only if the bytes start with the gzip magic (1f 8b), whatever the name or Content-Encoding says:
  // a server that adds "Content-Encoding: gzip" has already had the body decompressed by fetch().
  async function bytesToText(buf) {
    const b = new Uint8Array(buf, 0, Math.min(2, buf.byteLength));
    if (b.length === 2 && b[0] === 0x1f && b[1] === 0x8b) {
      return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
    }
    return new TextDecoder().decode(buf);
  }

  TraceViewer.mountAll = function (scope) {
    return Array.from((scope || document).querySelectorAll('[data-trace-viewer]')).map(el => {
      const traces = (el.dataset.traces || '').split(',').map(s => s.trim()).filter(Boolean).map(s => {
        const [url, label] = s.split('|');
        return { url, label: label || url.split('/').pop() };
      });
      return new TraceViewer(el, {
        src: el.dataset.src, traces: traces.length ? traces : null,
        height: el.dataset.height ? +el.dataset.height : undefined,
      });
    });
  };

  // Prose links:  <a href="#fig1" data-tv-target="#fig1" data-tv-range="7400,8100">the 4R command</a>
  //               <a href="#fig1" data-tv-target="#fig1" data-tv-msg="7">message 7</a>   (1-based)
  if (typeof document !== 'undefined') {
    document.addEventListener('click', e => {
      const a = e.target.closest('[data-tv-target]');
      const host = a && document.querySelector(a.dataset.tvTarget);
      const tv = host && host.traceViewer;
      if (!tv) return;
      e.preventDefault();
      host.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (a.dataset.tvMsg) tv.gotoMessage(+a.dataset.tvMsg - 1);
      else if (a.dataset.tvRange) { const [x, y] = a.dataset.tvRange.split(',').map(Number); tv.goto(x, y); }
      else if (a.dataset.tvView === 'all') tv.act('all');
      else tv.act('fit');
    });
  }

  root.TraceViewer = TraceViewer;
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => TraceViewer.mountAll());
    else TraceViewer.mountAll();
  }
})(window);
