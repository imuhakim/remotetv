'use strict';
/* "Type with arrows": turns text into arrow + OK presses for an on-screen
 * keyboard, for TVs that can only be reached by infra-red (no letter keys).
 * The layout is YouTube's search keyboard on Android / Google TV:
 *
 *   A B C D E F G  ⌫
 *   H I J K L M N  &123
 *   O P Q R S T U  🌐
 *   V W X Y Z - '
 *   [ SPACE ][ CLEAR ][ SEARCH ]
 *
 * The highlight must start on A. After SPACE we assume Up lands on V
 * (the left end of the row above), which is how the keyboard behaves when
 * SPACE is entered from V. */
(function (root) {
  const ROWS = ['abcdefg', 'hijklmn', 'opqrstu', "vwxyz-'"];
  const POS = {};
  ROWS.forEach((row, r) => [...row].forEach((ch, c) => { POS[ch] = [r, c]; }));

  function moves(from, to) {
    const out = [];
    const [r0, c0] = from;
    const [r1, c1] = to;
    for (let i = r0; i < r1; i++) out.push('down');
    for (let i = r0; i > r1; i--) out.push('up');
    for (let i = c0; i < c1; i++) out.push('right');
    for (let i = c0; i > c1; i--) out.push('left');
    return out;
  }

  /** Returns { keys: [...], typed: 'text actually typed', skipped: 'chars without a key' }. */
  function plan(text) {
    const keys = [];
    let at = [0, 0]; // highlight on A
    let typed = '';
    let skipped = '';
    const clean = String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    for (const ch of clean) {
      if (ch === ' ' || ch === '\n') {
        if (!typed || typed.endsWith(' ')) continue; // no leading or double spaces
        keys.push(...moves(at, [3, 0]), 'down', 'ok', 'up'); // V -> SPACE -> back to V
        at = [3, 0];
        typed += ' ';
      } else if (POS[ch]) {
        keys.push(...moves(at, POS[ch]), 'ok');
        at = POS[ch];
        typed += ch;
      } else if (!skipped.includes(ch)) {
        skipped += ch;
      }
    }
    return { keys, typed: typed.trimEnd(), skipped };
  }

  root.KeyboardNav = { plan, ROWS };
})(typeof window !== 'undefined' ? window : globalThis);
