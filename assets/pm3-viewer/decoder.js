/*
 * XT27A protocol trace decoder -- JavaScript port of tools/decode_trace.py.
 *
 * Turns a Proxmark3 `lf sniff` trace (.pm3: one signed sample per line, 1 sample = 1 T0 = 8 us at
 * 125 kHz) into a time-ordered list of reader->tag (HITAG2 BPLM), tag->reader (Manchester/biphase)
 * and field-reset messages, annotated with known protocol information, with the XT27A
 * LFSR session cipher undone after the handshake.
 *
 * It is a line-for-line port: constants, thresholds and annotation text match the Python so the two
 * can be diffed message by message. Additions for the viewer: every message carries `cells` (the
 * sample position of each bit-cell boundary, so the graph can draw the bits where they sit in the
 * signal), `short` (a one-line label) and, inside the keyed region, `decrypt`.
 *
 * Works as a plain <script> (window.XT27) and under Node (module.exports).
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

  // ---------------------------------------------------------------------------
  // Timing constants, all in T0 (= samples)
  // ---------------------------------------------------------------------------
  const C = {
    READER_LOW: -90,          // field-off samples clamp near -127; tag replies never get near this
    READER_MIN_LOW_RUN: 2,    // a field-off pulse is several T0 long; shorter dips are noise
    BPLM_0: [14, 24],         // datasheet 18..22 T0
    BPLM_1: [25, 38],         // datasheet 26..32 T0
    READER_EOF: 40,           // no field-off pulse for this long ends the reader frame
    READER_BOUNCE: 10,        // field-return edges closer than this are one pulse that bounced
    FIELD_OFF_MIN: 64,        // a field-off run this long is a field reset, not a BPLM pulse
    FIELD_ON_JUMP: 80,        // field return after a reset: one-sample jump of at least this
    READER_GUARD: [40, 100],  // excluded around a reader frame; tag answers >= ~190 T0 after it
    TAG_FLOOR: 5.0,           // min tag swing; idle ripple in quiet traces is ~+-2
    TAG_MIN_SPAN: 96,         // shortest active stretch worth decoding (3 bits)
    TAG_BRIDGE: 64,           // merge active stretches split by a short dropout
    TAG_MID_WIN: 129,         // ~4 bits: window for tracking a reply's drifting mid-level
    TAG_MAX_GAP: 80,          // HITAG_T_EOF: a transition gap this long ends a tag frame
    TAG_MIN_EDGES: 10,
    TAG_HALF_TOL: 0.35,       // how far (in half-bits) a gap may stray from 1 or 2 halves
    TAG_DESPIKE: 6,           // transition pairs closer than this are ringing glitches
    TAG_MIN_BITS: 8,          // shorter decoded "frames" are noise
    SOF: '11111',             // HITAG2 Manchester start of frame
    REPLY_WINDOW: [150, 400], // a tag reply starts ~193 T0 after the command's last edge
  };

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------
  function parsePm3(text) {
    const n = text.length;
    const out = new Float64Array((n >> 1) + 2);
    let count = 0, val = 0, neg = false, have = false;
    for (let i = 0; i < n; i++) {
      const c = text.charCodeAt(i);
      if (c >= 48 && c <= 57) { val = val * 10 + (c - 48); have = true; }
      else if (c === 45) neg = true;
      else if (c === 10 || c === 13) {
        if (have) out[count++] = neg ? -val : val;
        val = 0; neg = false; have = false;
      }
    }
    if (have) out[count++] = neg ? -val : val;
    return out.slice(0, count);
  }

  // ---------------------------------------------------------------------------
  // numpy-equivalent helpers
  // ---------------------------------------------------------------------------
  function prefix(x) {
    const p = new Float64Array(x.length + 1);
    for (let i = 0; i < x.length; i++) p[i + 1] = p[i] + x[i];
    return p;
  }

  // np.convolve(x, ones(w)/w, 'same'), w odd (zero padded)
  function movavg(x, w) {
    const n = x.length, h = w >> 1, p = prefix(x), out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = (p[Math.min(n, i + h + 1)] - p[Math.max(0, i - h)]) / w;
    return out;
  }

  // moving average with edge padding so the ends of a span aren't pulled toward 0
  function movavgEdge(x, w) {
    const n = x.length, h = w >> 1, p = prefix(x), out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      const lo = i - h, hi = i + h;
      let s = p[Math.min(hi, n - 1) + 1] - p[Math.max(lo, 0)];
      if (lo < 0) s += -lo * x[0];
      if (hi > n - 1) s += (hi - (n - 1)) * x[n - 1];
      out[i] = s / w;
    }
    return out;
  }

  // sliding max over an edge-padded window of w
  function movmax(x, w) {
    const n = x.length, h = w >> 1, m = n + 2 * h;
    const xp = new Float64Array(m);
    for (let i = 0; i < m; i++) xp[i] = x[Math.min(n - 1, Math.max(0, i - h))];
    const out = new Float64Array(n), dq = new Int32Array(m);
    let head = 0, tail = 0;
    for (let i = 0; i < m; i++) {
      while (tail > head && xp[dq[tail - 1]] <= xp[i]) tail--;
      dq[tail++] = i;
      if (dq[head] <= i - w) head++;
      if (i >= w - 1 && i - (w - 1) < n) out[i - (w - 1)] = xp[dq[head]];
    }
    return out;
  }

  function percentile(arr, q) {
    const s = Float64Array.from(arr).sort();
    const idx = (q / 100) * (s.length - 1), lo = Math.floor(idx), hi = Math.ceil(idx);
    return s[lo] + (s[hi] - s[lo]) * (idx - lo);
  }

  function pyRound(x) { // Python's round(): halves go to the even neighbour
    const f = Math.floor(x), d = x - f;
    if (d < 0.5) return f;
    if (d > 0.5) return f + 1;
    return f % 2 === 0 ? f : f + 1;
  }

  // ---------------------------------------------------------------------------
  // Reader -> tag (BPLM)
  // ---------------------------------------------------------------------------
  function findReaderFrames(sig, low) {
    const edges = [];
    let run = 0;
    for (let i = 0; i < sig.length; i++) {
      if (sig[i] <= low) run++;
      else {
        if (run >= C.READER_MIN_LOW_RUN && run < C.FIELD_OFF_MIN) {
          if (edges.length && i - edges[edges.length - 1] < C.READER_BOUNCE) edges[edges.length - 1] = i;
          else edges.push(i);
        }
        run = 0;
      }
    }
    const frames = [];
    let cur = [];
    for (const e of edges) {
      if (cur.length && e - cur[cur.length - 1] > C.READER_EOF) { frames.push(cur); cur = []; }
      cur.push(e);
    }
    if (cur.length) frames.push(cur);

    const msgs = [];
    for (const f of frames) {
      if (f.length < 2) continue;
      let bits = '';
      for (let k = 1; k < f.length; k++) {
        const g = f[k] - f[k - 1];
        bits += g >= C.BPLM_0[0] && g <= C.BPLM_0[1] ? '0' : g >= C.BPLM_1[0] && g <= C.BPLM_1[1] ? '1' : '?';
      }
      msgs.push({
        kind: 'READER', start: f[0], end: f[f.length - 1], positions: f, cells: f,
        bits, rawBits: bits, coding: 'BPLM', violations: count(bits, '?'), sof: 0,
      });
    }
    return msgs;
  }

  // Reader field resets: a field-off run >= FIELD_OFF_MIN T0, measured up to the field-return jump.
  function findFieldEvents(sig, low) {
    const events = [], n = sig.length;
    let i = 0;
    while (i < n) {
      if (sig[i] > low) { i++; continue; }
      let j = i;
      while (j < n && sig[j] <= low) j++;
      if (j - i >= C.FIELD_OFF_MIN) {
        let on = null;
        const lim = Math.min(n, j + 250000);
        for (let t = j; t + 1 < lim; t++) {
          if (sig[t + 1] - sig[t] >= C.FIELD_ON_JUMP && sig[t + 1] > 0) { on = t + 1; break; }
        }
        events.push({
          kind: 'FIELD', start: i, end: on !== null ? on : j, fieldOn: on, bits: '', rawBits: '',
          coding: 'FLD', violations: 0, sof: 0, positions: [i], cells: [],
        });
      }
      i = j;
    }
    return events;
  }

  // ---------------------------------------------------------------------------
  // Tag -> reader (Manchester / biphase)
  // ---------------------------------------------------------------------------
  function activeSpans(seg, floor) {
    const n = seg.length;
    const w = Math.min(257, n - (1 - (n % 2)));
    const avg = movavg(seg, w);
    const ax = new Float64Array(n);
    for (let i = 0; i < n; i++) ax[i] = Math.abs(seg[i] - avg[i]);
    const mm = movmax(ax, 65);
    const spans = [];
    let i = 0;
    while (i < n) {
      if (!(mm[i] > floor)) { i++; continue; }
      let j = i;
      while (j < n && mm[j] > floor) j++;
      if (spans.length && i - spans[spans.length - 1][1] < C.TAG_BRIDGE) spans[spans.length - 1][1] = j;
      else spans.push([i, j]);
      i = j;
    }
    return spans.filter(([a, b]) => b - a >= C.TAG_MIN_SPAN);
  }

  // Level transitions [[pos, level_after]] in sig[lo:hi], with a drifting per-reply mid-level.
  function tagTransitions(sig, lo, hi, floor) {
    const seg = sig.subarray(lo, hi);
    if (seg.length < C.TAG_MIN_SPAN) return [];
    const out = [];
    for (const [i, j] of activeSpans(seg, floor)) {
      const span = seg.subarray(i, j), n = span.length;
      const w = Math.min(C.TAG_MID_WIN, n - (1 - (n % 2)));
      const avg = movavgEdge(span, w);
      const x = new Float64Array(n), ax = new Float64Array(n);
      for (let k = 0; k < n; k++) { x[k] = span[k] - avg[k]; ax[k] = Math.abs(x[k]); }
      const base = Math.max(floor * 0.6, 0.3 * percentile(ax, 90));
      const mm = movmax(ax, w);
      let state = null;
      for (let k = 0; k < n; k++) {
        const hyst = Math.max(base, 0.4 * mm[k]);
        if (state !== 1 && x[k] > hyst) { state = 1; out.push([lo + i + k, 1]); }
        else if (state !== 0 && x[k] < -hyst) { state = 0; out.push([lo + i + k, 0]); }
      }
    }
    return out;
  }

  function despike(trans) {
    const out = trans.slice();
    let k = 1;
    while (k < out.length) {
      if (out[k][0] - out[k - 1][0] < C.TAG_DESPIKE) { out.splice(k - 1, 2); k = Math.max(1, k - 1); }
      else k++;
    }
    return out;
  }

  // Each gap as 1 or 2 half-bits, or 0 if it fits neither.
  function halfCounts(trans, half) {
    const out = [], ng = trans.length - 1;
    for (let k = 0; k < ng; k++) {
      const r = (trans[k + 1][0] - trans[k][0]) / half;
      let n = pyRound(r);
      if (k === ng - 1 && r >= 0.6) n = Math.min(2, Math.max(1, n));
      else if ((n !== 1 && n !== 2) || Math.abs(r - n) > C.TAG_HALF_TOL) n = 0;
      out.push(n);
    }
    return out;
  }

  function decodeManchester(trans, half) {
    const ns = halfCounts(trans, half), halves = [], times = [];
    let viol = 0;
    for (let k = 0; k < ns.length; k++) {
      let n = ns[k];
      if (n === 0) { viol++; n = 1; }
      const t0 = trans[k][0], gap = trans[k + 1][0] - t0;
      for (let j = 0; j < n; j++) { halves.push(trans[k][1]); times.push(t0 + (j * gap) / n); }
    }
    const last = trans[trans.length - 1];
    halves.push(last[1]); times.push(last[0]); times.push(last[0] + half);
    const first = halves[0]; // a reply opens with the first half of a SOF '1'
    let bits = '', k = 0;
    const cells = [];
    for (; k < halves.length - 1; k += 2) {
      cells.push(times[k]);
      if (halves[k] === halves[k + 1]) { bits += '?'; viol++; }
      else bits += halves[k] === first ? '1' : '0';
    }
    cells.push(times[k]);
    return { bits, viol, cells };
  }

  function decodeBiphase(trans, half) {
    const ns = halfCounts(trans, half), cells = [];
    let bits = '', viol = 0, k = 0;
    while (k < ns.length) {
      cells.push(trans[k][0]);
      if (ns[k] === 2) { bits += '1'; k += 1; }
      else if (ns[k] === 1 && k + 1 < ns.length && ns[k + 1] === 1) { bits += '0'; k += 2; }
      else { bits += '?'; viol++; k += 1; }
    }
    cells.push(trans[k][0]);
    return { bits, viol, cells };
  }

  function decodeTagFrame(transIn) {
    const start = transIn[0][0], end = transIn[transIn.length - 1][0];
    const trans = despike(transIn);
    if (trans.length < 4) return null;
    const cands = [['MC', decodeManchester, 16], ['BP', decodeBiphase, 16],
                   ['MC', decodeManchester, 32], ['BP', decodeBiphase, 32]];
    let best = null;
    cands.forEach(([name, fn, half], pref) => {
      const r = fn(trans, half);
      const trimmed = r.bits.replace(/\?+$/, ''); // the modulation decays after the last bit
      const q = count(trimmed, '?');
      if (best === null || q < best.q || (q === best.q && pref < best.pref)) {
        best = { q, pref, bits: trimmed, coding: name + half * 2, tail: r.bits.length - trimmed.length,
                 cells: r.cells.slice(0, trimmed.length + 1) };
      }
    });
    const sof = best.coding === 'MC32' && best.bits.startsWith(C.SOF) ? C.SOF.length : 0;
    return {
      kind: 'TAG', start, end, positions: trans.map(t => t[0]), cells: best.cells,
      bits: best.bits.slice(sof), rawBits: best.bits, coding: best.coding,
      violations: count(best.bits, '?'), sof, tailTrimmed: best.tail,
    };
  }

  function isNoise(m) {
    return m.kind === 'TAG' && (m.rawBits.length < C.TAG_MIN_BITS || 2 * m.violations >= m.rawBits.length);
  }

  // A short, pure field-off pulse train that is not a BPLM command (PCF7991 reader housekeeping).
  function isReaderHousekeeping(m) {
    return m.kind === 'READER' && m.bits.length < 8 && !m.bits.includes('0');
  }

  function findTagFrames(sig, readerMsgs, lo, hi, floor) {
    const n = sig.length, mask = new Uint8Array(n);
    mask.fill(1, 0, lo);
    mask.fill(1, Math.min(hi, n), n);
    for (const m of readerMsgs) {
      mask.fill(1, Math.max(0, m.start - C.READER_GUARD[0]), Math.min(n, m.end + C.READER_GUARD[1]));
    }
    const msgs = [];
    let i = 0;
    while (i < n) {
      if (mask[i]) { i++; continue; }
      let j = i;
      while (j < n && !mask[j]) j++;
      let group = [];
      const flush = () => {
        if (group.length >= C.TAG_MIN_EDGES) {
          const m = decodeTagFrame(group);
          if (m !== null) msgs.push(m);
        }
        group = [];
      };
      for (const t of tagTransitions(sig, i, j, floor)) {
        if (group.length && t[0] - group[group.length - 1][0] > C.TAG_MAX_GAP) flush();
        group.push(t);
      }
      flush();
      i = j;
    }
    return msgs;
  }

  function decodeTrace(sig, opts) {
    opts = opts || {};
    const start = opts.start || 0, end = opts.end == null ? sig.length : opts.end;
    const low = opts.readerLow == null ? C.READER_LOW : opts.readerLow;
    const floor = opts.tagFloor == null ? C.TAG_FLOOR : opts.tagFloor;
    const reader = findReaderFrames(sig, low).filter(m => m.end >= start && m.start < end);
    let tag = opts.quietTag ? [] : findTagFrames(sig, reader, start, end, floor);
    if (!opts.showNoise) tag = tag.filter(m => !isNoise(m));
    const field = findFieldEvents(sig, low).filter(m => start <= m.start && m.start < end);
    let msgs = reader.concat(tag, field).sort((a, b) => a.start - b.start);
    if (!opts.showNoise) msgs = msgs.filter(m => !isReaderHousekeeping(m));
    annotateAll(msgs);
    decryptPass(msgs);
    msgs.forEach(finishMessage);
    return msgs;
  }

  // ---------------------------------------------------------------------------
  // Bit-string helpers
  // ---------------------------------------------------------------------------
  function count(s, ch) { let n = 0; for (let i = 0; i < s.length; i++) if (s[i] === ch) n++; return n; }

  function bitsToBig(bits) {
    const clean = bits.replace(/\?/g, '0');
    return clean ? BigInt('0b' + clean) : 0n;
  }

  function bitsToBytes(bits) { // whole leading bytes; '?' is read as 0
    const clean = bits.replace(/\?/g, '0'), by = [];
    for (let i = 0; i + 8 <= clean.length; i += 8) by.push(parseInt(clean.slice(i, i + 8), 2));
    return by;
  }

  const hex = (v, digits) => v.toString(16).toUpperCase().padStart(digits || 1, '0');
  const bytesHex = by => by.map(b => hex(b, 2)).join('');
  const bytesStr = by => String.fromCharCode(...by);

  function bitsToHex(bits) { // hex of the whole-byte prefix, leftover bits appended as '+bbb'
    const by = bitsToBytes(bits), rest = bits.slice(by.length * 8);
    return bytesHex(by) + (rest ? '+' + rest : '');
  }

  function crc8(by, poly) { // CRC-8, poly 0x07, init 0 (hitager's Utils.cs Crc8)
    poly = poly == null ? 0x07 : poly;
    let crc = 0;
    for (const b of by) {
      crc ^= b;
      for (let i = 0; i < 8; i++) crc = (crc & 0x80) ? ((crc << 1) ^ poly) & 0xFF : (crc << 1) & 0xFF;
    }
    return crc;
  }

  // ---------------------------------------------------------------------------
  // XT27A session-cipher decryption
  // ---------------------------------------------------------------------------
  const XT27_TAPS = [...'1010000000010001'].map(Number);
  const XT27_OPS = ['ctl', 'sel', 'WRITE', 'READ'];
  const XT27_ID_PAGES = [0x33, 0x34, 0x35, 0x36];

  const rev16 = x => parseInt((x & 0xFFFF).toString(2).padStart(16, '0').split('').reverse().join(''), 2);
  const xt27Seed = reply => (rev16(reply) ^ 0xE12E) & 0xFFFF;

  function xt27Keystream(seed, n) {
    let s = [...seed.toString(2).padStart(16, '0')].map(Number);
    const out = s.slice();
    while (out.length < n) {
      let nb = 0;
      for (let i = 0; i < 16; i++) nb ^= XT27_TAPS[i] & s[i];
      out.push(nb);
      s.shift(); s.push(nb);
    }
    return out.slice(0, n);
  }

  function xt27CmdNote(kind, nbits, pt) {
    if (nbits === 16) {
      const p = Number(pt);
      if (((p >> 8) ^ (p & 0xFF)) === 0xFF) {
        const op = p >> 8;
        return `${XT27_OPS[op >> 6]} ${(op >> 6) === 1 ? 'bank' : 'page'} 0x${hex(op & 0x3F, 2)}` + (kind === 'TAG' ? ' (echo)' : '');
      }
    }
    if (nbits === 32) {
      const p = Number(pt), b = [(p >>> 24) & 255, (p >>> 16) & 255, (p >>> 8) & 255, p & 255];
      const asc = b.map(c => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('');
      const txt = b.some(c => c >= 32 && c < 127) && b.some(c => c) ? `  "${asc}"` : '';
      return `data 0x${hex(p, 8)}${txt}`;
    }
    return `0x${hex(pt, Math.max(1, nbits >> 2))}`;
  }

  function decryptPass(msgs) {
    let ks = null, curSeed = null, pos = 0, armed = null, idbytes = {}, pendingRead = null, prev7372 = false;
    for (const m of msgs) {
      const kind = m.kind;
      if (kind === 'FIELD') { ks = curSeed = null; armed = pendingRead = null; idbytes = {}; prev7372 = false; continue; }
      const bits = m.bits.replace(/\?/g, '0');
      if (kind === 'TAG' && m.coding === 'MC32' && bits.length >= 16
          && (prev7372 || (parseInt(bits.slice(0, 16), 2) >> 4) === 0x6B3)) {
        armed = parseInt(bits.slice(0, 16), 2) & 0xFFFF; // FULL 16-bit reply; seed = bitrev16(reply) ^ 0xE12E
        prev7372 = false;
        continue;
      }
      prev7372 = kind === 'READER' && bits.length >= 16 && parseInt(bits.slice(0, 16), 2) === 0x7372;
      let fourR = false;
      if (kind === 'READER' && armed !== null) {
        curSeed = xt27Seed(armed);
        if (bits.length >= 16) { // safety net: the first command is always a valid 'sel' frame
          const ct0 = parseInt(bits.slice(0, 16), 2), pt = ct0 ^ curSeed;
          const validSel = (((pt >> 8) ^ (pt & 0xFF)) === 0xFF) && (pt >> 14) === 1;
          if (!validSel) curSeed = ct0 ^ 0x41BE;
        }
        ks = xt27Keystream(curSeed, 8192);
        pos = 0; armed = null; idbytes = {}; pendingRead = null; fourR = true;
      }
      if (ks === null) continue;

      const nEff = (bits.length >> 4) << 4; // true frames are 16/32 bits; drop trailing noise
      if (nEff === 0) continue;
      if (pos + nEff > ks.length) ks = xt27Keystream(curSeed, pos + nEff + 2048);
      const ct = BigInt('0b' + bits.slice(0, nEff));
      const k = BigInt('0b' + ks.slice(pos, pos + nEff).join(''));
      const pt = ct ^ k;
      pos += nEff;

      if (!fourR) {
        m.note = `${nEff}-bit encrypted ${nEff === 16 ? 'command' : 'data'}`;
        if (m.violations) m.note += `  [${m.violations} decode violation(s), marked '?']`;
      }
      const digits = nEff >> 2, cmd = xt27CmdNote(kind, nEff, pt);
      m.note += `\nDECRYPT  ct 0x${hex(ct, digits)}  pt 0x${hex(pt, digits)}  ${cmd}`;
      m.decrypt = { ct: hex(ct, digits), pt: hex(pt, digits), cmd, bits: nEff };

      const p16 = Number(pt & 0xFFFFn);
      if (kind === 'READER' && nEff === 16 && (((p16 >> 8) ^ (p16 & 0xFF)) === 0xFF) && (p16 >> 14) === 3) {
        pendingRead = (p16 >> 8) & 0x3F;
      } else if (kind === 'TAG' && nEff === 32 && pendingRead !== null) {
        if (XT27_ID_PAGES.includes(pendingRead)) {
          const p = Number(pt);
          idbytes[pendingRead] = [(p >>> 24) & 255, (p >>> 16) & 255, (p >>> 8) & 255, p & 255];
          if (XT27_ID_PAGES.every(a => a in idbytes)) {
            const full = XT27_ID_PAGES.map(a => bytesHex(idbytes[a])).join('');
            m.note += `\n*** 16-byte chip ID: ${full} ***`;
            m.chipId = full;
            idbytes = {};
          }
        }
        pendingRead = null;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Annotation
  // ---------------------------------------------------------------------------
  const VENDOR_MAGIC = new Set(['XHORSE', 'LISTN ', 'XMICRO']);
  const XT_FAMILY_RE = /XT\d\d[A-Z]?/;
  const xtFamily = s => { const m = XT_FAMILY_RE.exec(s); return m ? m[0] : null; };

  const KNOWN_16BIT = {
    0x072F: 'AUTH query #1 (hitager authcmd2)',
    0x7372: "AUTH query #2 (hitager authcmd3) -- the tag's reply is hitager's timing-sync value",
  };
  const BRUTE_CMD_16 = { 0x263A: '#1', 0xA81C: '#2' };
  const BRUTE_CMD_32 = { 0x018E5995: '#3' };
  const UNLOCK_MAGIC = '0F0F0200';

  function annotatePostListn(by) {
    if (!by.some(b => b)) return '128 zero bits -- the same in every trace (fixed filler/preamble after LISTN)';
    return `128-bit value 0x${bytesHex(by)} -- NOT all zeros, unlike every trace seen so far`;
  }

  function annotate(by, nbits, bits, prev) { // READER message
    const val = bitsToBig(bits), v = Number(val), bs = bytesStr(by);
    if (nbits < 8 && !bits.includes('0')) {
      return `${nbits} field-off pulse(s) at ~32/64 T0, no '0' bit -- PCF7991 reader housekeeping `
           + 'between TX and the tag-read window, not a command';
    }
    if (nbits === 48 && VENDOR_MAGIC.has(bs)) return `ASCII "${bs}" -- vendor magic string`;
    const fam = xtFamily(bs);
    if (fam !== null && nbits >= 40) {
      const idx = bs.indexOf(fam), prefix = by.slice(0, idx), payload = by.slice(idx + fam.length);
      return `XMICRO super-chip command: ASCII family "${fam}"`
           + (prefix.length ? `, prefix 0x${bytesHex(prefix)}` : '')
           + (payload.length ? `, payload 0x${bytesHex(payload)}` : '')
           + ' (XT57-class management channel)';
    }
    if (nbits === 16) {
      if (v in KNOWN_16BIT) return KNOWN_16BIT[v];
      if (v in BRUTE_CMD_16) {
        return `hitager bruteCmd ${BRUTE_CMD_16[v]} (0x${hex(v, 4)}) -- pre-encrypted replay word, `
             + 'not the live LFSR channel';
      }
      if (prev && prev.replyTo === 0x7372) {
        return `Start of encrypted comms; sel bank 0x01 `;
      }
      return `16-bit reader value 0x${hex(v, 4)} -- not yet characterized`;
    }
    if (nbits === 48) {
      const opcode = by[0], data = by.slice(1, 5), crcRecv = by[5], crcCalc = crc8(by.slice(0, 5));
      if ((opcode & 0xF8) === 0x80 && crcCalc === crcRecv) {
        const page = opcode & 0x07;
        let extra = '';
        if (page === 0 && bytesHex(data) === UNLOCK_MAGIC) extra = ' *** MAGIC UNLOCK VALUE (enables memory access, per hitager) ***';
        else if (page === 5) extra = ` -- likely SET TYPE (type byte 0x${hex(data[3], 2)})`;
        return `WRITE PAGE ${page}: data=0x${bytesHex(data)} [CRC OK]${extra}`;
      }
      if (crcCalc === crcRecv) {
        return `raw WRITE (CRC-8 OK): op=0x${hex(opcode, 2)} data=0x${bytesHex(data)} -- XT57/drill-style plaintext page I/O`;
      }
      if (opcode === 0x03) {
        return `post-LISTN value: 0x03 + 40-bit payload 0x${bytesHex(by.slice(1))} (different in every trace -- session data)`;
      }
      if (by.every(b => b >= 32 && b < 127)) return `ASCII "${bs}" -- printable, not a cataloged vendor-magic string`;
    }
    if (nbits === 128) return annotatePostListn(by);
    if (nbits === 8 && (v & 0xF8) === 0x00) return `READ PAGE ${v & 0x07} (query)`;
    if (nbits === 5 && bits === '11000') return 'HITAG2 START_AUTH (standard command; the tag answers with its UID)';
    if (nbits === 5 && bits === '00000') return 'HITAG2 HALT';
    if (nbits === 64) {
      return `HITAG2 authenticate: 32-bit encrypted nonce 0x${bytesHex(by.slice(0, 4))} + 32-bit answer `
           + `0x${bytesHex(by.slice(4))} (standard HITAG2 crypto auth, not the XT27 LFSR channel)`;
    }
    if (nbits === 10) {
      return `HITAG2 post-auth command frame (10-bit, 0x${hex(v, 3)}); the tag returns the addressed 32-bit page `
           + '(emulated-HITAG2 read)';
    }
    if (nbits === 4) {
      if (v === 0b0011) return "4-bit 0011: hitager's drill/identify query -- tag answers with its ID";
      return `4-bit query ${bits}`;
    }
    if (nbits === 40 && by[0] === 0xFF) return `SELECT by ID: 0xFF + ${bytesHex(by.slice(1))} (hitager's drill-echo shape)`;
    if (nbits === 32) {
      if (v in BRUTE_CMD_32) {
        return `hitager bruteCmd ${BRUTE_CMD_32[v]} (0x${hex(v, 8)}) -- pre-encrypted replay payload; `
             + "the tag's reply is drillID";
      }
      return `32-bit reader value 0x${hex(v, 8)} (in set_UID traces: the UID field, XORed with the session keystream)`;
    }
    return `${nbits}-bit reader value -- not yet characterized`;
  }

  function annotateTag(msg, prev) {
    const bits = msg.bits;
    if (msg.coding !== 'MC32') {
      return `${msg.coding} reply (not the XT27A's own 4 kbit/s Manchester -- likely the emulated chip type `
           + `answering natively); raw bits ${bits}`;
    }
    const by = bitsToBytes(bits), nbits = bits.length, bs = bytesStr(by);
    const val = bitsToBig(bits), v = Number(val), vh = `0x${hex(val, Math.max(1, nbits >> 2))}`;
    const sof = msg.sof ? '' : ' [no 11111 start-of-frame found]';
    if (!prev || prev.kind !== 'READER') return `${nbits}-bit tag frame, not preceded by a reader command${sof}`;
    const gap = msg.start - prev.end;
    if (gap < C.REPLY_WINDOW[0] || gap > C.REPLY_WINDOW[1]) {
      return `${nbits}-bit tag frame, outside the reply window after the last command${sof}`;
    }
    const pby = bitsToBytes(prev.bits), pn = prev.bits.length, pbs = bytesStr(pby);
    const pval = Number(bitsToBig(prev.bits));
    if (pn === 48 && VENDOR_MAGIC.has(pbs)) return `tag ACK of "${pbs}" (${vh})${sof}`;
    if (pn === 16 && pval === 0x072F) return `tag reply to 072F${sof}`;
    if (pn === 16 && pval === 0x7372) {
      msg.replyTo = 0x7372;
      return `tag reply to 7372: hitager's timing-sync value; last nibble ${(v & 0xF).toString(2).padStart(4, '0')} = `
           + `tag nibble ${sof}`;
    }
    if (pn === 5 && prev.bits === '11000') return `UID ${vh} (reply to START_AUTH)${sof}`;
    if (pn === 4 && pval === 0b0011) {
      const fam = xtFamily(bs);
      if (fam !== null) {
        return `tag ID reply to drill/identify: ${vh} = ASCII "${fam}" -- super-chip family tag `
             + `(last byte varies, possible seed?)${sof}`;
      }
      return `tag ID reply to the drill query (${vh} -- 32-bit numeric chip ID, XT27-class)${sof}`;
    }
    if (pn === 8 && (pval & 0xF8) === 0x00) return `page ${pval & 0x07} data${sof}`;
    if (pn === 8 && nbits === 40 && crc8([pby[0]].concat(by.slice(0, 4))) === by[4]) {
      return `raw READ reply (CRC-8 OK): cmd=0x${hex(pby[0], 2)} data=0x${bytesHex(by.slice(0, 4))} `
           + `-- XT57/drill-style plaintext page I/O${sof}`;
    }
    return `${nbits}-bit tag reply${sof}`;
  }

  function annotateAll(msgs) {
    let prev = null;
    for (const m of msgs) {
      if (m.kind === 'FIELD') {
        if (m.fieldOn === null) m.note = 'reader field OFF (not seen coming back on within the trace)';
        else {
          const off = m.fieldOn - m.start;
          m.note = `reader field OFF for ${off} T0 (${(off * 8 / 1000).toFixed(1)} ms), then back ON -- resets the tag`;
        }
      } else if (m.kind === 'TAG') {
        m.note = annotateTag(m, prev);
      } else {
        m.note = annotate(bitsToBytes(m.bits), m.bits.length, m.bits, prev);
      }
      if (m.violations) m.note += `  [${m.violations} decode violation(s), marked '?']`;
      prev = m;
    }
  }

  // Viewer extras: one-line label and the sample extent of the message on the graph.
  function finishMessage(m) {
    const first = m.note.split('\n')[0];
    m.short = (m.decrypt ? m.decrypt.cmd : first).split(/ -- |; | \(| \[CRC/)[0].replace(/\s+\[\d+ decode.*$/, '');
    m.hex = m.kind === 'FIELD' ? '' : '0x' + bitsToHex(m.bits);
    if (m.kind === 'FIELD') { m.a = m.start; m.b = m.end; }
    else { m.a = m.cells[0]; m.b = m.cells[m.cells.length - 1]; }
  }

  const api = {
    C, parsePm3, decodeTrace, findReaderFrames, findFieldEvents, findTagFrames,
    bitsToHex, bitsToBytes, crc8, xt27Seed, xt27Keystream,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.XT27 = api;
})(typeof window !== 'undefined' ? window : globalThis);
