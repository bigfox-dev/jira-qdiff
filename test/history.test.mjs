/**
 * Revision chains, gap detection and line attribution.
 *
 * Run: node --test test/history.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
require('../content/diff.js');            // history.js reads JDHDiff off the global
const History = require('../content/history.js');

/** Build history targets for one field from a list of values, newest change first. */
function entriesFor(field, steps) {
    // steps: [[old, new, author, when], …] given oldest-first for readability,
    // then reversed because Jira renders the newest change at the top.
    return steps
        .map(([oldText, newText, author, when]) => ({
            fieldName: field, oldText, newText, author, when: when || null
        }))
        .reverse();
}

test('a single change yields the before and after value', () => {
    const chains = History.buildChains(entriesFor('Description', [
        ['one', 'two', 'Michal']
    ]));
    const chain = chains.get('Description');

    assert.equal(chain.revisions.length, 2);
    assert.deepEqual(chain.revisions.map((r) => r.value), ['one', 'two']);
    assert.equal(chain.revisions[0].initial, true);
    assert.equal(chain.revisions[0].author, null, 'nobody is credited with the pre-history value');
    assert.equal(chain.revisions[1].author, 'Michal');
    assert.equal(chain.complete, true);
});

test('consecutive changes chain into one sequence', () => {
    const chains = History.buildChains(entriesFor('Description', [
        ['a', 'b', 'Michal'],
        ['b', 'c', 'Petra'],
        ['c', 'd', 'Michal']
    ]));
    const chain = chains.get('Description');

    assert.deepEqual(chain.revisions.map((r) => r.value), ['a', 'b', 'c', 'd']);
    assert.equal(chain.complete, true);
    assert.deepEqual(chain.gaps, []);
});

test('oldest-first DOM order is detected, not assumed', () => {
    const ascending = entriesFor('Description', [
        ['a', 'b', 'Michal'],
        ['b', 'c', 'Petra']
    ]).reverse(); // undo the reverse -> oldest change first in the DOM

    const chain = History.buildChains(ascending).get('Description');
    assert.deepEqual(chain.revisions.map((r) => r.value), ['a', 'b', 'c']);
    assert.equal(chain.complete, true);
    assert.equal(chain.domOrderNewestFirst, false);
});

test('a missing entry is reported as a gap, not smoothed over', () => {
    // The "b -> c" change never made it into the DOM.
    const chain = History.buildChains(entriesFor('Description', [
        ['a', 'b', 'Michal'],
        ['c', 'd', 'Petra']
    ])).get('Description');

    assert.equal(chain.complete, false, 'a broken chain must not claim to be complete');
    assert.equal(chain.gaps.length, 1);
    assert.equal(chain.gaps[0].after, 1);
});

test('truncated history values surface as a gap too', () => {
    const chain = History.buildChains(entriesFor('Description', [
        ['start', 'a very long value that got cut off', 'Michal'],
        ['a very long value that got cut…', 'final', 'Petra']
    ])).get('Description');

    assert.equal(chain.complete, false);
});

test('fields are chained independently', () => {
    const chains = History.buildChains([
        ...entriesFor('Description', [['a', 'b', 'Michal']]),
        ...entriesFor('Summary', [['x', 'y', 'Petra']])
    ]);
    assert.deepEqual([...chains.keys()].sort(), ['Description', 'Summary']);
    assert.deepEqual(chains.get('Summary').revisions.map((r) => r.value), ['x', 'y']);
});

test('targets with no field name are ignored', () => {
    const chains = History.buildChains([
        { fieldName: '', oldText: 'a', newText: 'b' },
        { fieldName: null, oldText: 'a', newText: 'b' }
    ]);
    assert.equal(chains.size, 0);
});

test('revisionIndexOf locates the entry that produced a revision', () => {
    const entries = entriesFor('Description', [
        ['a', 'b', 'Michal'],
        ['b', 'c', 'Petra']
    ]);
    const chain = History.buildChains(entries).get('Description');

    // entries[0] is the newest change (b -> c), i.e. the last revision.
    assert.equal(History.revisionIndexOf(chain, entries[0]), 2);
    assert.equal(History.revisionIndexOf(chain, entries[1]), 1);
    assert.equal(History.revisionIndexOf(chain, { fieldName: 'x' }), -1);
});

/* ------------------------------------------------------------------ *
 * Blame
 * ------------------------------------------------------------------ */

test('blame credits each surviving line to the revision that added it', () => {
    const chain = History.buildChains(entriesFor('Description', [
        ['first\nsecond', 'first\nsecond\nthird', 'Michal'],
        ['first\nsecond\nthird', 'first\nCHANGED\nthird\nfourth', 'Petra']
    ])).get('Description');

    const result = History.blame(chain);

    assert.deepEqual(result.lines, ['first', 'CHANGED', 'third', 'fourth']);
    assert.deepEqual(result.revisions.map((r) => r.author), [
        null,       // "first" predates the recorded history
        'Petra',    // "CHANGED" replaced "second"
        'Michal',   // "third" came from the first change and survived
        'Petra'     // "fourth" is new
    ]);
    assert.equal(result.trustworthy, true);
});

test('an unchanged line keeps its original author across many revisions', () => {
    const chain = History.buildChains(entriesFor('Description', [
        ['keep\nold', 'keep\nmid', 'A'],
        ['keep\nmid', 'keep\nnew', 'B'],
        ['keep\nnew', 'keep\nnewer', 'C']
    ])).get('Description');

    const result = History.blame(chain);
    assert.equal(result.revisions[0].author, null, '"keep" was never touched');
    assert.equal(result.revisions[1].author, 'C');
});

test('blame over a broken chain reports itself as untrustworthy', () => {
    const chain = History.buildChains(entriesFor('Description', [
        ['a', 'b', 'Michal'],
        ['c', 'd', 'Petra']
    ])).get('Description');

    const result = History.blame(chain);
    assert.equal(result.trustworthy, false);
    assert.equal(result.lines.length, 1, 'it still attributes what it can');
});

test('blame handles a field that was empty to begin with', () => {
    const chain = History.buildChains(entriesFor('Environment', [
        ['', 'line one\nline two', 'Michal']
    ])).get('Environment');

    const result = History.blame(chain);
    assert.deepEqual(result.lines, ['line one', 'line two']);
    assert.deepEqual(result.revisions.map((r) => r.author), ['Michal', 'Michal']);
});

/* ------------------------------------------------------------------ *
 * Serialisation for the standalone viewer
 * ------------------------------------------------------------------ */

test('toPayload strips the DOM back-references', () => {
    const entries = entriesFor('Description', [
        ['a', 'b', 'Michal', 'July 1'],
        ['b', 'c', 'Petra', 'July 2']
    ]);
    // Stand in for the live DOM nodes a real target carries.
    entries.forEach((entry) => { entry.node = { nodeType: 1 }; entry.mount = () => {}; });

    const chain = History.buildChains(entries).get('Description');
    const payload = History.toPayload(chain);

    assert.doesNotThrow(() => JSON.stringify(payload), 'payload must be serialisable');
    assert.ok(
        payload.revisions.every((r) => !('target' in r)),
        'no revision may keep a target reference'
    );
    assert.deepEqual(payload.revisions.map((r) => r.value), ['a', 'b', 'c']);
    assert.deepEqual(payload.revisions.map((r) => r.author), [null, 'Michal', 'Petra']);
    assert.deepEqual(payload.revisions.map((r) => r.when), [null, 'July 1', 'July 2']);
    assert.equal(payload.complete, true);
    assert.equal(payload.field, 'Description');
});

test('a chain survives a round trip and still blames correctly', () => {
    const chain = History.buildChains(entriesFor('Description', [
        ['first\nsecond', 'first\nsecond\nthird', 'Michal'],
        ['first\nsecond\nthird', 'first\nCHANGED\nthird', 'Petra']
    ])).get('Description');

    const revived = JSON.parse(JSON.stringify(History.toPayload(chain)));
    const result = History.blame(revived);

    assert.deepEqual(result.lines, ['first', 'CHANGED', 'third']);
    assert.deepEqual(result.revisions.map((r) => r.author), [null, 'Petra', 'Michal']);
    assert.equal(result.trustworthy, true);
});

test('toPayload keeps gap information so the viewer can warn too', () => {
    const chain = History.buildChains(entriesFor('Description', [
        ['a', 'b', 'Michal'],
        ['c', 'd', 'Petra']
    ])).get('Description');

    const payload = History.toPayload(chain);
    assert.equal(payload.complete, false);
    assert.deepEqual(payload.gaps, [{ after: 1 }]);
    assert.equal(History.blame(payload).trustworthy, false);
});

test('toPayload tolerates no chain at all', () => {
    assert.equal(History.toPayload(null), null);
    assert.equal(History.toPayload(undefined), null);
});

test('blame handles a field that was emptied', () => {
    const chain = History.buildChains(entriesFor('Description', [
        ['gone', '', 'Michal']
    ])).get('Description');

    const result = History.blame(chain);
    assert.deepEqual(result.lines, []);
    assert.deepEqual(result.revisions, []);
});
