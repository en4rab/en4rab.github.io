# Review — `2026-11-23-AT100-Super-Chip.md`

Fifth pass, 2026-11-23. Line numbers refer to the current file. Fixed items have been deleted.

**No factual errors outstanding.** Both remaining must-fixes are resolved: the UID read-only claim is
gone (lines 76–77 now state the write test), and the `crack5` paragraph has been rewritten into
something considerably better than what I suggested — I verified its specific claims and they hold
(see §4). What is left is four typos, three small precision points and some optional suggestions.

Fixed and removed this pass: the "does not appear to be changeable" claim, the one-nonce `crack5`
description, and the missing provenance for `0xFB`–`0xFD` (line 136 now states the write test).

**Note:** `_site/` is still built from an older draft, so the `<td>{: .wrap-cells }</td>` rows are
still sitting in there. A rebuild clears them.

---

## 1. Small accuracy points

### 1.1 "a session with 18 commands" counts frames, not commands
**Line 91.** The arithmetic is right but the noun is loose. The session this matches is the ID48
write burst: 9 commands (`0xFE` plus pages `0x00`–`0x07`), each of which the tag echoes, giving
**18 self-checking 20-bit frames** — so 180 bits of redundancy, which is what the argument needs.
As written, a reader who counts commands in the viewer will find nine, not eighteen. Suggest "a
session with 9 writes — 18 self-checking frames once the tag's echoes are counted".

### 1.2 Say that the attack was run with the pair given twice
**Line 91** says `ht2crack5` wants two pairs and that a tag only ever hands you one, then goes
straight to "Running the attack on that single pair…". It is implied, but never stated, that you fed
it the same pair twice (which is the only way the binary runs at all — it exits unless given five
arguments). Half a clause would close the gap: "…so it was run with that one pair given twice".

### 1.3 `7939 / ID49` vs `ID5C / MQB49`
**Lines 144–145.** Still worth one check against the Autel menu. ID49 is normally the PCF7939
HITAG-AES chip used in VAG MQB, so "MQB49" hanging off ID5C looks like it could be a transcription
slip — unless that is literally what the menu says, in which case "these are Autel's own menu labels,
not my naming" would head off the question.

---

## 2. Writing and typos

| Line | Problem | Suggested fix |
|---|---|---|
| 128 | "**Set** 7937, 7938 and ID4A **set** these pages to `0x00000000`" — verb twice; and the row sits out of numeric order, before the `0x50` row. | "7937, 7938 and ID4A clear these pages to `00000000`" — and move it after the `0x50` row. |
| 163 | "…and `0xF0`–`0xF4` **it also writes** `0x00`–`0x07` (…)" — two sentences run together. | "…and `0xF0`–`0xF4`. It also fills `0x00`–`0x07` (`FFFFFFFF` ×4, then `00000000` ×4)." |
| 167 | "The exceptions **are** the fixed-code family writes page `0x00` first, 7937/7946 program…" — missing "that", three clauses joined by commas. | "There are three exceptions: the fixed-code family writes page `0x00` first; 7937 and 7946 program the chip as ID46 and then re-type it; and MQB49 writes its serial up front." |
| 171 | "if you want to try use that fork"; "It is experimental, while it has worked for me while testing these tags, I cannot guarantee it wont harm your tag!" — comma splice, "while" twice, and "wont". | "…use that fork if you want to try it. It is experimental: it has worked for me on my own tags, but I cannot guarantee it won't harm yours!" |

---

## 3. Suggestions (optional)

* **Spell out that the device key is writable.** Line 136 now says writing `0xFB`–`0xFD` changed the
  UID and the auth key, but the post never draws the conclusion: the management key is not fixed in
  silicon, which is why `-k` exists in the client — and why writing a key you have not recorded leaves
  a chip nothing can reach. A sentence of warning next to line 136 would be worth more than most of
  the memory map. The flip side (UID and key both under your control, so a blank can be given any
  identity the protocol checks) is a strong note to end the post on.
* **The probe sweep is still unexplained anywhere.** The first trace in the viewer opens with eight
  annotated frames the chip never answers (`0x1001002E3E`, `0011`, three HITAG2 `START_AUTH`s,
  `11110`, `11100`, `0xFF`), one per power-up. A reader clicking through meets them cold. One sentence
  under §"The wake handshake" would cover it and would earn the good line already there ("Entry is not
  the standard HITAG2 sequence").
* **Link the [XT136]({% post_url 2026-10-31-XT136-Super-Chip %}) post** from line 48 or the 7936/ID46
  bullet — it writes the same `MIKR`/`..ON`/`06AA4854` bytes.
* **Distinguish traced from untraced types.** Seven of the 18 are backed by captures in the viewer;
  the rest are not. The caveat box promises that spirit and the XT27A post does it explicitly.

---

## 4. Verified — no action needed

### The rewritten key-recovery paragraph (line 91)

I checked every specific claim in it:

* **`0x58C0916AE748` behaves exactly as described.** Run through the HITAG2 cipher it reproduces
  `aR = 53AFB236` for UID `836BC7C7` — the tag it was cracked from — and produces `266ED2FD` for UID
  `8358BE8C`, where the capture shows `76D8A24C`. So "authenticates flawlessly against the tag it was
  cracked from and fails on every other blank" is precisely right.
* **"The stock tool hides this by stopping at the first candidate."** Confirmed in
  `ht2crack5.c`: `try_state()` reconstructs the key from a state producing `aR1`, tests it against
  `(nR2, aR2)`, and on success prints it and calls `exit(0)`. With the same pair supplied twice, every
  candidate passes that test, so it prints whichever it reaches first.
* **The `{W}{~W}` filter does the work you say it does.** I decrypted all eight traces under both
  keys. The real key passes **179 of 179** 20-bit complement checks across every session; the decoy
  passes **0 of 179** — including on the `836BC7C7` traces it authenticates against. A single session
  is more than enough to separate them.
* **~62,000 candidates is the right order of magnitude.** A 48-bit key constrained by one 32-bit `aR`
  leaves ~2^16 = 65,536 survivors, so 61,831 is exactly what theory predicts.
* **The cross-check argument is sound** — each further UID adds a 32-bit constraint, so 62,000
  candidates against one more blank leaves the true key alone, which is what the decoy test above
  demonstrates concretely.
* **"bit-sliced"** is accurate — crack5 is the bitsliced CPU implementation.

### Everything else

* **Line 136's write test** is now the post's strongest piece of evidence and reads correctly against
  the rest of the text.
* **Table attribute lines** are all the bare `{: .wrap-cells }` form; nothing matches `^|{: ` in the
  post.
* **`0x78`–`0x7B` row is correct** — `img_7937`, `img_7938` and `img_id4a` write those four pages and
  they are not UID-patched (`AT_PLACE_P00` touches only `0x00`), so `00000000` is right.
* **Page counts reconcile** — emulation `0x00`–`0xFA` = 251 pages, plus `0xFB`–`0xFE` = the 255
  readable pages of line 118; the fork's `read` help agrees `0xFF` alone never answers.
* **Line 11's "six of its emulation modes"** matches the drop-down, plus the identify and detect
  traces.
* **ID4C** — the trace writes `0x00` = `D210A09A`, `0x01` = `00000000`, `0x02` = `0F340000`, and
  CRC-16/XMODEM over those 8 UID bytes is exactly **`0F34`**.
* **Device UID `0x8358BE8C`**, **`nR = 0xED355308`**, **key `9F63A5E8B14B`** — every auth in all eight
  traces verifies; all captured UIDs begin `0x83`.
* **`aR = keystream(32) ^ 0xFFFFFFFF`** — matches the decoder and every capture.
* **Post-auth framing** — `READ {0x1FE}{0x201}` and `WRITE {0x2FE}{0x101}` decrypt bit-for-bit as
  written; op `01` = READ, `10` = WRITE; the tag echoes the WRITE command and nothing acknowledges the
  data.
* **"~98 ms for the EEPROM"** — measured 96.5–100.9 ms (median 97.8) across the 48 writes in the ID8A
  and ID48 traces.
* **Identify flow reads exactly page `0xFC`**; detect is auth + READ `0xFE`. Both match their
  drop-down labels.
* **Factory `0xFE = 9B290A9B` (ID4D)** confirmed as the auto-returned word on a fresh blank.
* **All 15 type codes** match `at100-decoder.js` and `cmdlfautel.c`; the catalogue is exactly **18**
  types once the shared codes are counted out.
* **7936 / ID46 image** — `0x00` fresh serial, `0x01` = `4D494B52` "MIKR", `0x02` = `00004F4E` "..ON",
  `0x03` = `06AA4854`.
* **ID13 EM4102 frame** — hand-decoded `FF812A65 CC07E238`: nine header ones, ten rows of four data
  bits with correct row parity, column parity `1100`, stop bit `0`, ID `04 56 B3 07 C8`; every parity
  bit checks, and page `0x00` (`02900000`) really is written before `0xFE`.
* **ID48** — pages `0x00`–`0x07`, `AAAAAAAA` at `0x06`/`0x07`; MQB/ID8B's "four extra pages" matches
  `cmdlfautel.c` (`0x16`, `0x17`, `0x1D`, `0x1E`).
* **ID8A** — 40 pages `0x00`–`0x27`, payload on even pages only.
* **ID5C** — serial `929DE017` to page `0xC8`, written before `0xFE`.
* **`0x3C` selects DST40 vs DST80** — `4D80` carries `0x3C = 08460000`, ID4D/ID4E `00460000`.
* **Upstream paths** — `common/hitag2/hitag2_crypto.c` and `tools/hitag2crack/crack5` both exist.
* **Command set** — matches the fork exactly; `dump` reads every readable page, `read` takes `-p`/`-n`
  (1..64), `write` `-p`/`-d`, `configure` `-t`/`-u`, `reset` restores `9B290A9B`, and `list` is the
  only one without `-k`.
* **Assets and viewer** — all eight traces plus `km100x.jpg` in place, `tb` path correct, and the
  "upload your own" claim is accurate (`viewer.js` has a file input and drag-and-drop).
* **"KM100X"** is a real Autel product name, and the AT100 is sold as the universal chip for the
  KM100 family.
* **All four `data-tv-msg` deep links** (38, 43, 44, 45) still land on the right frames.
