/**
 * Unit tests for the diff engine.
 * Run: node --test test/
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const D = require('../content/diff.js');

const { EQUAL, DELETE, INSERT } = D;

/** Reconstruct both sides from a move list — the invariant that must hold. */
function replay(moves, a, b) {
    const oldSide = [];
    const newSide = [];
    for (const [op, ai, bi] of moves) {
        if (op === EQUAL) {
            oldSide.push(a[ai]);
            newSide.push(b[bi]);
        } else if (op === DELETE) {
            oldSide.push(a[ai]);
        } else {
            newSide.push(b[bi]);
        }
    }
    return [oldSide, newSide];
}

function assertRoundTrip(a, b) {
    const moves = D.diffArrays(a, b);
    const [oldSide, newSide] = replay(moves, a, b);
    assert.deepEqual(oldSide, a, 'old side must replay exactly');
    assert.deepEqual(newSide, b, 'new side must replay exactly');
    return moves;
}

test('identical input produces only EQUAL moves', () => {
    const lines = ['a', 'b', 'c'];
    const moves = assertRoundTrip(lines, lines.slice());
    assert.ok(moves.every(([op]) => op === EQUAL));
    assert.equal(moves.length, 3);
});

test('empty inputs', () => {
    assert.deepEqual(D.diffArrays([], []), []);
    assert.equal(D.diffArrays([], ['x']).length, 1);
    assert.equal(D.diffArrays(['x'], [])[0][0], DELETE);
});

test('pure insertion in the middle', () => {
    const moves = assertRoundTrip(['a', 'b'], ['a', 'x', 'b']);
    const inserts = moves.filter(([op]) => op === INSERT);
    assert.equal(inserts.length, 1);
    assert.equal(moves.filter(([op]) => op === DELETE).length, 0);
});

test('minimal edit script for a replacement', () => {
    const moves = assertRoundTrip(
        ['h2. Story', '', 'old line', '', 'end'],
        ['h2. Story', '', 'new line', '', 'end']
    );
    assert.equal(moves.filter(([op]) => op === DELETE).length, 1);
    assert.equal(moves.filter(([op]) => op === INSERT).length, 1);
});

test('grouping collapses runs', () => {
    const moves = D.diffArrays(['a', 'b', 'c', 'd'], ['a', 'd']);
    const groups = D.group(moves);
    assert.deepEqual(groups.map((g) => g.op), [EQUAL, DELETE, EQUAL]);
    assert.equal(groups[1].aStart, 1);
    assert.equal(groups[1].aEnd, 3);
});

test('word diff marks only the changed words', () => {
    const { segments } = D.diffText(
        'Nahradit Simple.OData.Client za oficialni balicek',
        'Nahradit Simple.OData.Client za oficialni Microsoft balicek',
        'word'
    );
    const inserted = segments.filter((s) => s.op === INSERT).map((s) => s.text).join('');
    const deleted = segments.filter((s) => s.op === DELETE).map((s) => s.text).join('');
    assert.match(inserted, /Microsoft/);
    assert.equal(deleted, '');
});

test('word diff reports a high changed ratio for a full rewrite', () => {
    const same = D.diffText('the quick brown fox', 'the quick brown cat', 'word');
    const rewrite = D.diffText('the quick brown fox', 'zcela odlisna veta', 'word');
    assert.ok(same.changedRatio < 0.4, `expected small ratio, got ${same.changedRatio}`);
    assert.ok(rewrite.changedRatio > 0.9, `expected large ratio, got ${rewrite.changedRatio}`);
});

test('character granularity', () => {
    const { segments } = D.diffText('abc', 'abXc', 'char');
    assert.deepEqual(
        segments.map((s) => [s.op, s.text]),
        [[EQUAL, 'ab'], [INSERT, 'X'], [EQUAL, 'c']]
    );
});

test('large input falls back to anchors and still round-trips', () => {
    const a = Array.from({ length: 6000 }, (_, i) => 'line ' + i);
    const b = a.slice();
    b.splice(3000, 10);
    b.splice(100, 0, 'brand new unique line');
    const moves = assertRoundTrip(a, b);
    assert.ok(moves.length > 0);
});

test('completely disjoint large input degrades gracefully', () => {
    const a = Array.from({ length: 3000 }, (_, i) => 'a' + i);
    const b = Array.from({ length: 3000 }, (_, i) => 'b' + i);
    const moves = assertRoundTrip(a, b);
    assert.equal(moves.filter(([op]) => op === EQUAL).length, 0);
});

test('tokenizer keeps whitespace and punctuation as separate tokens', () => {
    assert.deepEqual(D.tokenizeWords('a, b'), ['a', ',', ' ', 'b']);
    assert.deepEqual(D.tokenizeWords('příliš žluťoučký'), ['příliš', ' ', 'žluťoučký']);
});
