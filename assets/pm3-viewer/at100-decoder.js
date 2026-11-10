/*
 * AT100 protocol trace decoder -- JavaScript, self-contained.
 *
 * Turns a Proxmark3 `lf sniff` trace (.pm3: one signed sample per line, 1 sample = 1 T0 = 8 us at
 * 125 kHz) into a time-ordered list of reader->tag (HITAG2 BPLM), tag->reader (HITAG2 Manchester)
 * and field-reset messages, annotated with the decoded AT100 protocol and with the HITAG2 crypto
 * stream undone after the authentication handshake.
 *
 * The AT100 is an Autel programmable HITAG2 transponder (an emulator blank). Unlike the Xhorse
 * XT27A, there is no XT27 LFSR channel here -- the air interface is stock HITAG2 (BPLM reader,
 * Manchester tag, the 48-bit NXP stream cipher). The Autel authenticates with a device key that is
 * shared across the blanks (fixed reader IV), then reads/writes an emulation image. See docs/at100.md.
 *
 * The physical layer (parsePm3, the reader/tag framing, Manchester/biphase decode) is the same code
 * as the XT27A blog decoder.js; this file carries its own copy so it stands alone. What differs is the
 * annotation table (HITAG2 commands, the 20-bit {word}{~word} read/write opcodes) and the decrypt
 * pass (HITAG2 cipher keyed off the 64-bit {nR}{aR} auth frame instead of the XT27 LFSR seed).
 *
 * The HITAG2 cipher is a port of proxmark3/common/hitag2 (hitag2_init / hitag2_nstep / hitag2_crypt),
 * verified bit-exact against the C for every AT100 auth in the captures and the MIKRON test vector.
 *
 * Works as a plain <script> (window.AT100) and under Node (module.exports).
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
    READER_LOW: -110,         // AT100 load modulation is strong (dips past -90); keep reader pulses
                              // (which clamp near -127) separable from tag replies. See docs/at100.md §3.
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
  // `fieldOns` are the field-return points of field resets. The Autel sends some frames straight after
  // one with no start pulse, timing the first bit from the field return; without that edge the frame
  // decodes one bit short. The reader's own start pulse and the PCF7991 all-ones housekeeping also
  // follow field returns, so the return is used only when it is a valid bit that completes a whole byte.
  function findReaderFrames(sig, low, fieldOns) {
    const ons = (fieldOns || []).filter(e => e !== null && e !== undefined).sort((a, b) => a - b);
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
    for (let f of frames) {
      if (f.length < 2) continue;
      let lo = 0, hi = ons.length; // np.searchsorted(ons, f[0]): count of returns before the frame
      while (lo < hi) { const mid = (lo + hi) >> 1; if (ons[mid] < f[0]) lo = mid + 1; else hi = mid; }
      const k = lo - 1;
      if (k >= 0 && f[0] - ons[k] >= C.BPLM_0[0] && f[0] - ons[k] <= C.BPLM_1[1] && f.length % 8 === 0) {
        let zero = false;
        for (let q = 1; q < f.length; q++) {
          const g = f[q] - f[q - 1];
          if (g >= C.BPLM_0[0] && g <= C.BPLM_0[1]) { zero = true; break; }
        }
        if (zero) f = [ons[k]].concat(f);
      }
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
    const resets = findFieldEvents(sig, low);
    const reader = findReaderFrames(sig, low, resets.map(m => m.fieldOn)).filter(m => m.end >= start && m.start < end);
    let tag = opts.quietTag ? [] : findTagFrames(sig, reader, start, end, floor);
    if (!opts.showNoise) tag = tag.filter(m => !isNoise(m));
    const field = resets.filter(m => start <= m.start && m.start < end);
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

  // ---------------------------------------------------------------------------
  // HITAG2 stream cipher  (port of proxmark3/common/hitag2 hitagcrypto.c)
  //
  // Verified bit-exact against the C for every AT100 auth in the captures (and the MIKRON test
  // vector). The three init inputs -- key, UID, IV -- are the full-width bit reversal of the natural
  // (as-displayed) value; the keystream, nonce and answer are in natural (air, MSB-first) order.
  // ---------------------------------------------------------------------------
  const F4a = 0x2C79, F4b = 0x6671, F5c = 0x7907287B, Bi = n => BigInt(n), M64 = (1n << 64n) - 1n;
  const p22  = (S, A, b)        => Number(((S >> Bi(A)) & 3n) | ((S >> Bi(b - 2)) & 0xCn));
  const p1x4 = (S, A, b, c, d)  => Number(((S >> Bi(A)) & 1n) | ((S >> Bi(b - 1)) & 2n) | ((S >> Bi(c - 2)) & 4n) | ((S >> Bi(d - 3)) & 8n));
  const p112 = (S, A, b, c)     => Number(((S >> Bi(A)) & 1n) | ((S >> Bi(b - 1)) & 2n) | ((S >> Bi(c - 2)) & 0xCn));
  const p211 = (S, A, b, c)     => Number(((S >> Bi(A)) & 3n) | ((S >> Bi(b - 2)) & 4n) | ((S >> Bi(c - 3)) & 8n));
  const p121 = (S, A, b, c)     => Number(((S >> Bi(A)) & 1n) | ((S >> Bi(b - 1)) & 6n) | ((S >> Bi(c - 3)) & 8n));

  function ht2Crypt(x) {
    let bi = (F4a >> p22(x, 1, 4)) & 1;
    bi |= ((F4b << 1) >> p112(x, 7, 11, 13)) & 0x02;
    bi |= ((F4b << 2) >> p1x4(x, 16, 20, 22, 25)) & 0x04;
    bi |= ((F4b << 3) >> p211(x, 27, 30, 32)) & 0x08;
    bi |= ((F4a << 4) >> p121(x, 33, 42, 45)) & 0x10;
    return (F5c >> bi) & 1;
  }

  // full-width bit reversal: key/UID/IV go into the cipher reversed (rev48 / rev32)
  function revBits(v, nbits) {
    let out = 0n;
    for (let i = 0; i < nbits; i++) if ((v >> Bi(i)) & 1n) out |= 1n << Bi(nbits - 1 - i);
    return out;
  }

  function ht2Init(key, uid, iv) { // key/uid/iv already full-width-reversed BigInts
    let state = ((key & 0xFFFFn) << 32n) | (uid & 0xFFFFFFFFn);
    iv = (iv ^ (key >> 16n)) & 0xFFFFFFFFn;
    state = (state | (iv << 48n)) & M64;
    iv >>= 16n;
    state >>= 1n;
    for (let i = 0; i < 16; i++) state = ((state >> 1n) ^ (Bi(ht2Crypt(state)) << 46n)) & M64;
    state = (state | (iv << 47n)) & M64;
    for (let i = 0; i < 15; i++) state = ((state >> 1n) ^ (Bi(ht2Crypt(state)) << 46n)) & M64;
    state = (state ^ (Bi(ht2Crypt(state)) << 47n)) & M64;
    const t = state ^ (state >> 1n);
    const lfsr = state ^ (state >> 6n) ^ (state >> 16n) ^ (state >> 26n) ^ (state >> 30n) ^ (state >> 41n)
               ^ (t >> 2n) ^ (t >> 7n) ^ (t >> 22n) ^ (t >> 42n) ^ (t >> 46n);
    return { shiftreg: state & M64, lfsr: lfsr & M64 };
  }

  function ht2StepBit(st) {
    if (st.lfsr & 1n) {
      st.shiftreg = ((st.shiftreg >> 1n) | 0x800000000000n) & M64;
      st.lfsr = ((st.lfsr >> 1n) ^ 0xB38083220073n) & M64;
    } else { st.shiftreg >>= 1n; st.lfsr >>= 1n; }
    return ht2Crypt(st.shiftreg);
  }

  // next `n` keystream bits as a BigInt, MSB first (matches the air bit order)
  function ht2Keystream(st, n) {
    let r = 0n;
    for (let i = 0; i < n; i++) r = (r << 1n) | Bi(ht2StepBit(st));
    return r;
  }

  // ---------------------------------------------------------------------------
  // AT100 session decryption
  //
  // The device key is shared across the AT100 blanks in the captures; the Autel always replays the
  // same reader IV, so the crypto is reproducible from the trace alone. The cipher is keyed off the
  // 64-bit {nR}{aR} auth frame: nR is the top 32 bits, the UID comes from the earlier cleartext page-0
  // read, and the first 32 keystream bits (the aR) are consumed before the post-auth frames. From then
  // on every reader/tag payload XORs against the continuing keystream in transmission order.
  // ---------------------------------------------------------------------------
  const AT100_KEY = 0x9F63A5E8B14Bn;    // device/management key, shared across blanks (docs/at100.md)
  const AT100_KEY_REV = revBits(AT100_KEY, 48);

  // Decrypt a 20-bit post-auth command word: it carries a 10-bit payload twice, true then complemented
  // ({W}{~W}). Opcode = top 2 bits of the payload: 10 = WRITE page, 01 = READ. Returns a label or null.
  function at100CmdWord(pt20) {
    const hi10 = (pt20 >> 10) & 0x3FF, lo10 = pt20 & 0x3FF;
    if (((hi10 ^ lo10) & 0x3FF) !== 0x3FF) return null; // not a valid {W}{~W}
    const op = hi10 >> 8, page = hi10 & 0xFF;
    if (op === 2) return `WRITE page 0x${hex(page, 2)}`;
    if (op === 1) return `READ 0x${hex(hi10, 3)}`;
    return `cmd 0x${hex(hi10, 3)}`;
  }

  function at100DataNote(pt32) {
    const b = [(pt32 >>> 24) & 255, (pt32 >>> 16) & 255, (pt32 >>> 8) & 255, pt32 & 255];
    const asc = b.map(c => (c >= 32 && c < 127 ? String.fromCharCode(c) : '.')).join('');
    const txt = b.some(c => c >= 32 && c < 127) && b.some(c => c) ? `  "${asc}"` : '';
    return `data 0x${hex(pt32 >>> 0, 8)}${txt}`;
  }

  function decryptPass(msgs) {
    let st = null, uid = null, pendingRead = false;
    for (const m of msgs) {
      if (m.kind === 'FIELD') { st = null; uid = null; pendingRead = false; continue; }
      const bits = m.bits.replace(/\?/g, '0');
      const n = bits.length;

      // Track the UID from the cleartext page-0 read: a 10-bit reader read (0x3E0) then a 32-bit reply.
      if (st === null && m.kind === 'READER' && n === 10) {
        pendingRead = (parseInt(bits, 2) & 0x3FF) === 0x3E0;
        continue;
      }
      if (st === null && m.kind === 'TAG' && m.coding === 'MC32' && n >= 32 && pendingRead) {
        uid = parseInt(bits.slice(0, 32), 2) >>> 0;
        pendingRead = false;
        continue;
      }

      // The 64-bit {nR}{aR} auth frame keys the cipher.
      if (st === null && m.kind === 'READER' && n === 64 && uid !== null) {
        const nR = parseInt(bits.slice(0, 32), 2) >>> 0;
        const aR = parseInt(bits.slice(32, 64), 2) >>> 0;
        st = ht2Init(AT100_KEY_REV, revBits(Bi(uid), 32), revBits(Bi(nR), 32));
        const aRks = Number(ht2Keystream(st, 32) ^ 0xFFFFFFFFn) >>> 0; // consume the aR keystream
        m.note += `\nAUTH  key 0x${hex(AT100_KEY, 12)}  UID 0x${hex(uid, 8)}  IV 0x${hex(nR, 8)}`
                + `  aR ${aRks === aR ? 'verified' : 'MISMATCH (0x' + hex(aRks, 8) + ')'}`;
        m.decrypt = { ct: hex(aR, 8), pt: hex(aRks, 8), cmd: 'aR (auth answer)', bits: 32 };
        continue;
      }
      if (st === null) continue;

      // Post-auth: XOR each 16/20/32-bit payload against the continuing keystream.
      const nEff = n === 20 ? 20 : (n >> 4) << 4; // 20-bit commands, else whole 16/32-bit frames
      if (nEff === 0) continue;
      const ct = BigInt('0b' + bits.slice(0, nEff));
      const pt = ct ^ ht2Keystream(st, nEff);
      const digits = Math.ceil(nEff / 4);
      let cmd;
      if (nEff === 20) {
        cmd = at100CmdWord(Number(pt)) || `0x${hex(pt, 5)}`;
      } else if (nEff === 32) {
        cmd = at100DataNote(Number(pt));
      } else {
        cmd = `0x${hex(pt, digits)}`;
      }
      m.note += `\nDECRYPT  ct 0x${hex(ct, digits)}  pt 0x${hex(pt, digits)}  ${cmd}`;
      m.decrypt = { ct: hex(ct, digits), pt: hex(pt, digits), cmd, bits: nEff };
    }
  }

  // ---------------------------------------------------------------------------
  // Annotation
  // ---------------------------------------------------------------------------
  const AT100_OPENER = 0x1001002E3En; // constant 40-bit Autel wake/select at the top of every read

  function annotate(by, nbits, bits, prev) { // READER message
    const val = bitsToBig(bits), v = Number(val);
    if (nbits < 8 && !bits.includes('0')) {
      return `${nbits} field-off pulse(s) at ~32/64 T0, no '0' bit -- PCF7991 reader housekeeping `
           + 'between TX and the tag-read window, not a command';
    }
    if (nbits === 40 && val === AT100_OPENER) {
      return 'Autel opener 0x1001002E3E -- constant 40-bit wake/select at the start of every read '
           + '(not yet characterised)';
    }
    if (nbits === 4) {
      if (v === 0b0011) return "4-bit 0011: HITAG2 identify/drill query -- tag answers with its ID";
      if (v === 0b1010) return '4-bit 1010: pre-read handshake query (tag echoes 1010)';
      return `4-bit query ${bits}`;
    }
    if (nbits === 5 && bits === '11000') return 'HITAG2 START_AUTH (standard command; the tag answers with its UID)';
    if (nbits === 5 && bits === '00000') return 'HITAG2 HALT';
    if (nbits === 5) return `5-bit HITAG2 command ${bits}`;
    if (nbits === 8 && (v & 0xF8) === 0x00) return `HITAG2 READ page ${v & 0x07} (query)`;
    if (nbits === 10) {
      if (v === 0x3E0) return 'HITAG2 READ page 0 (0x3E0); the tag returns its 32-bit UID in clear';
      return `HITAG2 post-auth command frame (10-bit, 0x${hex(v, 3)})`;
    }
    if (nbits === 20) {
      return '20-bit post-auth command (encrypted; {word}{~word}, 0x2xx=WRITE page / 0x1xx=READ -- '
           + 'see the decrypted line)';
    }
    if (nbits === 32) return `32-bit reader data (encrypted; see the decrypted line)`;
    if (nbits === 64) {
      return `HITAG2 authenticate: 32-bit IV (nonce) 0x${bytesHex(by.slice(0, 4))} + 32-bit answer `
           + `0x${bytesHex(by.slice(4))} (the Autel replays a fixed IV; this keys the cipher)`;
    }
    if (nbits === 8) return `8-bit reader value 0x${hex(v, 2)}`;
    return `${nbits}-bit reader value -- not yet characterized`;
  }

  function annotateTag(msg, prev) {
    const bits = msg.bits;
    if (msg.coding !== 'MC32') {
      return `${msg.coding} reply (non-standard rate); raw bits ${bits}`;
    }
    const by = bitsToBytes(bits), nbits = bits.length;
    const val = bitsToBig(bits), v = Number(val), vh = `0x${hex(val, Math.max(1, nbits >> 2))}`;
    const sof = msg.sof ? '' : ' [no 11111 start-of-frame found]';
    if (!prev || prev.kind !== 'READER') return `${nbits}-bit tag frame, not preceded by a reader command${sof}`;
    const gap = msg.start - prev.end;
    if (gap < C.REPLY_WINDOW[0] || gap > C.REPLY_WINDOW[1]) {
      return `${nbits}-bit tag frame, outside the reply window after the last command${sof}`;
    }
    const pn = prev.bits.length, pval = Number(bitsToBig(prev.bits));
    if (pn === 5 && prev.bits === '11000') return `UID ${vh} (reply to START_AUTH)${sof}`;
    if (pn === 4 && pval === 0b1010) return `handshake echo ${vh} (reply to 1010)${sof}`;
    if (pn === 4 && pval === 0b0011) return `tag ID reply to the identify query (${vh})${sof}`;
    if (pn === 10 && pval === 0x3E0) return `page-0 UID ${vh} (cleartext read)${sof}`;
    if (pn === 10) return `page data ${vh} (reply to 0x${hex(pval, 3)})${sof}`;
    if (pn === 20 && nbits === 20) return `20-bit tag echo/ack ${vh} (encrypted WRITE ack; see the decrypted line)${sof}`;
    if (pn === 20) return `32-bit page data ${vh} (encrypted READ reply; see the decrypted line)${sof}`;
    if (pn === 64) return `post-auth token ${vh} (encrypted; the AT100's config/password page)${sof}`;
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
    m.short = (m.decrypt ? m.decrypt.cmd : first).split(/ -- |; | \(| \[/)[0].replace(/\s+\[\d+ decode.*$/, '');
    m.hex = m.kind === 'FIELD' ? '' : '0x' + bitsToHex(m.bits);
    if (m.kind === 'FIELD') { m.a = m.start; m.b = m.end; }
    else { m.a = m.cells[0]; m.b = m.cells[m.cells.length - 1]; }
  }

  const api = {
    C, parsePm3, decodeTrace, findReaderFrames, findFieldEvents, findTagFrames,
    bitsToHex, bitsToBytes, ht2Init, ht2Keystream, revBits, AT100_KEY,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else { root.AT100 = api; root.XT27 = api; } // XT27 alias: the shared viewer.js looks up window.XT27
})(typeof window !== 'undefined' ? window : globalThis);
