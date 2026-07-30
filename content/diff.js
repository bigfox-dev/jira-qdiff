/*!
 * Jira Diff Highlighter (Server / Data Center)
 * ------------------------------------------------
 * Diff engine.
 *
 * Myers O(ND) diff with:
 *   - common prefix/suffix stripping,
 *   - patience-style unique-anchor bisection for inputs too large for Myers,
 *   - graceful degradation to "delete everything / insert everything".
 *
 * No external dependencies (the upstream Cloud extension uses
 * google/diff-match-patch; we need line-aware alignment, so this is bespoke).
 */
(function (root) {
    'use strict';

    var DELETE = -1;
    var EQUAL = 0;
    var INSERT = 1;

    /** Above this many tokens in a single segment we stop using Myers. */
    var MYERS_TOKEN_BUDGET = 4000;
    /** Hard cap on the edit distance Myers is allowed to explore. */
    var MYERS_MAX_D = 1500;

    /* ------------------------------------------------------------------ *
     * Tokenizers
     * ------------------------------------------------------------------ */

    var WORD_RE = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;

    function tokenizeWords(text) {
        if (!text) return [];
        return text.match(WORD_RE) || [];
    }

    function tokenizeChars(text) {
        if (!text) return [];
        return Array.from(text);
    }

    /* ------------------------------------------------------------------ *
     * Interning: compare cheap integers instead of strings
     * ------------------------------------------------------------------ */

    function internPair(a, b) {
        var map = new Map();
        var ia = new Int32Array(a.length);
        var ib = new Int32Array(b.length);
        var i, id;
        for (i = 0; i < a.length; i++) {
            id = map.get(a[i]);
            if (id === undefined) {
                id = map.size;
                map.set(a[i], id);
            }
            ia[i] = id;
        }
        for (i = 0; i < b.length; i++) {
            id = map.get(b[i]);
            if (id === undefined) {
                id = map.size;
                map.set(b[i], id);
            }
            ib[i] = id;
        }
        return [ia, ib];
    }

    /* ------------------------------------------------------------------ *
     * Myers O(ND)
     * ------------------------------------------------------------------ */

    /**
     * @returns {Array<[number, number, number]>|null} moves as [op, aIndex, bIndex]
     *          (local indices), or null when the edit distance cap was hit.
     */
    function myers(a, b, maxD) {
        var n = a.length;
        var m = b.length;
        var max = n + m;
        var offset = max;
        var v = new Int32Array(2 * max + 1);
        var trace = [];
        var cap = Math.min(max, maxD);
        var found = false;
        var d, k, x, y;

        for (d = 0; d <= cap && !found; d++) {
            trace.push(v.slice(0));
            for (k = -d; k <= d; k += 2) {
                if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
                    x = v[offset + k + 1];
                } else {
                    x = v[offset + k - 1] + 1;
                }
                y = x - k;
                while (x < n && y < m && a[x] === b[y]) {
                    x++;
                    y++;
                }
                v[offset + k] = x;
                if (x >= n && y >= m) {
                    found = true;
                    break;
                }
            }
        }

        if (!found) return null;

        // Walk the trace backwards to reconstruct the edit script.
        var moves = [];
        x = n;
        y = m;
        for (d = trace.length - 1; d >= 0; d--) {
            var vv = trace[d];
            k = x - y;
            var prevK;
            if (k === -d || (k !== d && vv[offset + k - 1] < vv[offset + k + 1])) {
                prevK = k + 1;
            } else {
                prevK = k - 1;
            }
            var prevX = vv[offset + prevK];
            var prevY = prevX - prevK;

            while (x > prevX && y > prevY) {
                moves.push([EQUAL, x - 1, y - 1]);
                x--;
                y--;
            }
            if (d > 0) {
                if (x > prevX) {
                    moves.push([DELETE, prevX, -1]);
                } else if (y > prevY) {
                    moves.push([INSERT, -1, prevY]);
                }
                x = prevX;
                y = prevY;
            }
        }
        moves.reverse();
        return moves;
    }

    /* ------------------------------------------------------------------ *
     * Patience anchors (fallback for large inputs)
     * ------------------------------------------------------------------ */

    function countOccurrences(seq) {
        var counts = new Map();
        for (var i = 0; i < seq.length; i++) {
            counts.set(seq[i], (counts.get(seq[i]) || 0) + 1);
        }
        return counts;
    }

    /** Longest increasing subsequence over `seq`, returns indices into `seq`. */
    function longestIncreasingSubsequence(seq) {
        var tails = [];
        var prev = new Int32Array(seq.length).fill(-1);
        var i, lo, hi, mid, pos;
        for (i = 0; i < seq.length; i++) {
            lo = 0;
            hi = tails.length;
            while (lo < hi) {
                mid = (lo + hi) >> 1;
                if (seq[tails[mid]] < seq[i]) lo = mid + 1;
                else hi = mid;
            }
            pos = lo;
            if (pos > 0) prev[i] = tails[pos - 1];
            if (pos === tails.length) tails.push(i);
            else tails[pos] = i;
        }
        var out = [];
        var cur = tails.length ? tails[tails.length - 1] : -1;
        while (cur !== -1) {
            out.push(cur);
            cur = prev[cur];
        }
        out.reverse();
        return out;
    }

    /** Pairs of positions of elements appearing exactly once in both sequences. */
    function uniqueCommonAnchors(a, b) {
        var ca = countOccurrences(a);
        var cb = countOccurrences(b);
        var bPos = new Map();
        var i;
        for (i = 0; i < b.length; i++) {
            if (cb.get(b[i]) === 1) bPos.set(b[i], i);
        }
        var pairs = [];
        for (i = 0; i < a.length; i++) {
            if (ca.get(a[i]) === 1 && cb.get(a[i]) === 1) {
                pairs.push([i, bPos.get(a[i])]);
            }
        }
        if (!pairs.length) return [];
        var bIdx = pairs.map(function (p) { return p[1]; });
        var keep = longestIncreasingSubsequence(bIdx);
        return keep.map(function (idx) { return pairs[idx]; });
    }

    /* ------------------------------------------------------------------ *
     * Core recursive driver
     * ------------------------------------------------------------------ */

    function pushRange(out, op, start, count, isDelete) {
        for (var i = 0; i < count; i++) {
            out.push(isDelete ? [op, start + i, -1] : [op, -1, start + i]);
        }
    }

    function diffCore(a, b, aOff, bOff, out) {
        if (!a.length && !b.length) return;
        if (!a.length) {
            pushRange(out, INSERT, bOff, b.length, false);
            return;
        }
        if (!b.length) {
            pushRange(out, DELETE, aOff, a.length, true);
            return;
        }

        if (a.length + b.length <= MYERS_TOKEN_BUDGET) {
            var moves = myers(a, b, MYERS_MAX_D);
            if (moves) {
                for (var i = 0; i < moves.length; i++) {
                    var mv = moves[i];
                    out.push([
                        mv[0],
                        mv[1] === -1 ? -1 : mv[1] + aOff,
                        mv[2] === -1 ? -1 : mv[2] + bOff
                    ]);
                }
                return;
            }
        }

        var anchors = uniqueCommonAnchors(a, b);
        if (!anchors.length) {
            pushRange(out, DELETE, aOff, a.length, true);
            pushRange(out, INSERT, bOff, b.length, false);
            return;
        }

        var pa = 0;
        var pb = 0;
        for (var k = 0; k < anchors.length; k++) {
            var ia = anchors[k][0];
            var ib = anchors[k][1];
            diffCore(a.slice(pa, ia), b.slice(pb, ib), aOff + pa, bOff + pb, out);
            out.push([EQUAL, aOff + ia, bOff + ib]);
            pa = ia + 1;
            pb = ib + 1;
        }
        diffCore(a.slice(pa), b.slice(pb), aOff + pa, bOff + pb, out);
    }

    /**
     * Diff two arrays of strings.
     * @returns {Array<[number, number, number]>} [op, aIndex, bIndex]
     */
    function diffArrays(aItems, bItems) {
        var pair = internPair(aItems, bItems);
        var a = pair[0];
        var b = pair[1];
        var n = a.length;
        var m = b.length;
        var out = [];

        var pre = 0;
        while (pre < n && pre < m && a[pre] === b[pre]) {
            out.push([EQUAL, pre, pre]);
            pre++;
        }
        var aEnd = n;
        var bEnd = m;
        while (aEnd > pre && bEnd > pre && a[aEnd - 1] === b[bEnd - 1]) {
            aEnd--;
            bEnd--;
        }

        diffCore(a.slice(pre, aEnd), b.slice(pre, bEnd), pre, pre, out);

        for (var s = 0; s < n - aEnd; s++) {
            out.push([EQUAL, aEnd + s, bEnd + s]);
        }
        return out;
    }

    /** Collapse a move list into runs: {op, aStart, aEnd, bStart, bEnd}. */
    function group(moves) {
        var groups = [];
        var cur = null;
        for (var i = 0; i < moves.length; i++) {
            var op = moves[i][0];
            var ai = moves[i][1];
            var bi = moves[i][2];
            if (!cur || cur.op !== op) {
                cur = {
                    op: op,
                    aStart: ai === -1 ? (cur ? cur.aEnd : 0) : ai,
                    aEnd: ai === -1 ? (cur ? cur.aEnd : 0) : ai,
                    bStart: bi === -1 ? (cur ? cur.bEnd : 0) : bi,
                    bEnd: bi === -1 ? (cur ? cur.bEnd : 0) : bi
                };
                groups.push(cur);
            }
            if (ai !== -1) cur.aEnd = ai + 1;
            if (bi !== -1) cur.bEnd = bi + 1;
        }
        return groups;
    }

    /* ------------------------------------------------------------------ *
     * Token-level diff producing renderable segments
     * ------------------------------------------------------------------ */

    /**
     * Diff two strings at word (or character) granularity.
     * @returns {{segments: Array<{op:number, text:string}>, changedRatio:number}}
     */
    function diffText(oldText, newText, granularity) {
        var tokenize = granularity === 'char' ? tokenizeChars : tokenizeWords;
        var aTokens = tokenize(oldText);
        var bTokens = tokenize(newText);
        var moves = diffArrays(aTokens, bTokens);

        var segments = [];
        var changed = 0;
        var total = 0;

        for (var i = 0; i < moves.length; i++) {
            var op = moves[i][0];
            var text = op === INSERT ? bTokens[moves[i][2]] : aTokens[moves[i][1]];
            if (text === undefined) continue;
            total += text.length;
            if (op !== EQUAL) changed += text.length;
            var last = segments[segments.length - 1];
            if (last && last.op === op) last.text += text;
            else segments.push({ op: op, text: text });
        }

        segments = smoothSegments(segments);
        return {
            segments: segments,
            changedRatio: total === 0 ? 0 : changed / total
        };
    }

    /**
     * Fold tiny "equal" islands (a stray space, a single letter) that sit between
     * two changes back into the change, so highlighting reads as one block
     * instead of confetti.
     */
    function smoothSegments(segments) {
        if (segments.length < 3) return segments;
        var out = [];
        for (var i = 0; i < segments.length; i++) {
            var seg = segments[i];
            var prev = out[out.length - 1];
            var next = segments[i + 1];
            var isTinyIsland =
                seg.op === EQUAL &&
                prev && next &&
                prev.op !== EQUAL && next.op !== EQUAL &&
                (/^\s+$/.test(seg.text) || seg.text.length <= 2);

            if (isTinyIsland && prev.op === next.op) {
                prev.text += seg.text;
                continue;
            }
            if (prev && prev.op === seg.op) {
                prev.text += seg.text;
                continue;
            }
            out.push({ op: seg.op, text: seg.text });
        }
        return out;
    }

    root.JDHDiff = {
        DELETE: DELETE,
        EQUAL: EQUAL,
        INSERT: INSERT,
        tokenizeWords: tokenizeWords,
        tokenizeChars: tokenizeChars,
        diffArrays: diffArrays,
        diffText: diffText,
        group: group
    };

    if (typeof module === 'object' && module.exports) {
        module.exports = root.JDHDiff;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
