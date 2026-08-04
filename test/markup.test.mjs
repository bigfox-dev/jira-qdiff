/**
 * Wiki-markup tokenizer.
 *
 * The renderer merges these token runs with diff runs by character offset, so
 * the round-trip invariant (tokens concatenate back to the input) is not a nice
 * property — it is a hard requirement. Every case below asserts it.
 *
 * Run: node --test test/markup.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Markup = require('../content/markup.js');

function roundTrip(line) {
    const tokens = Markup.tokenizeLine(line);
    assert.equal(
        tokens.map((t) => t.text).join(''),
        line,
        `tokens must reproduce the input exactly: ${JSON.stringify(line)}`
    );
    return tokens;
}

/** Compact view: "kind:text" per token. */
function shape(line) {
    return roundTrip(line).map((t) => `${t.kind}:${t.text}`);
}

test('headings mark the prefix only', () => {
    assert.deepEqual(shape('h2. Story'), ['delim:h2.', 'text: Story']);
    assert.deepEqual(shape('h6. Deep'), ['delim:h6.', 'text: Deep']);
    assert.equal(Markup.isHeading('h3. x'), true);
    assert.equal(Markup.isHeading('hello'), false);
    assert.equal(Markup.isHeading('h7. not a heading'), false);
});

test('list markers are separated from their content', () => {
    assert.deepEqual(shape('* item'), ['delim:*', 'text: item']);
    assert.deepEqual(shape('# numbered'), ['delim:#', 'text: numbered']);
    assert.deepEqual(shape('  ** nested'), ['text:  ', 'delim:**', 'text: nested']);
});

test('a bare asterisk pair is emphasis, not a list', () => {
    assert.deepEqual(shape('use *bold* here'), [
        'text:use ', 'delim:*', 'strong:bold', 'delim:*', 'text: here'
    ]);
});

test('monospace and macros are distinguished', () => {
    assert.deepEqual(shape('named {{data}} field'), [
        'text:named ', 'delim:{{', 'mono:data', 'delim:}}', 'text: field'
    ]);
    assert.deepEqual(shape('{noformat}'), ['macro:{noformat}']);
    assert.deepEqual(shape('{code:java}'), ['macro:{code:java}']);
});

test('the real-world noformat + JSON line survives', () => {
    const line = '{noformat}GET /api/v1/electionCandidates/current{noformat}';
    const tokens = roundTrip(line);
    assert.equal(tokens.filter((t) => t.kind === 'macro').length, 2);
});

test('links and images', () => {
    assert.deepEqual(shape('[https://x.test]'), [
        'delim:[', 'link:https://x.test', 'delim:]'
    ]);
    assert.deepEqual(shape('!image-1.png|width=538,height=89!'), [
        'image:!image-1.png|width=538,height=89!'
    ]);
});

test('a bare URL is highlighted', () => {
    assert.deepEqual(shape('See https://github.com/a/b now'), [
        'text:See ', 'url:https://github.com/a/b', 'text: now'
    ]);
});

test('emphasis, citation and inserted text', () => {
    assert.deepEqual(shape('_em_'), ['delim:_', 'em:em', 'delim:_']);
    assert.deepEqual(shape('??cite??'), ['delim:??', 'cite:cite', 'delim:??']);
    assert.deepEqual(shape('+added+'), ['delim:+', 'ins:added', 'delim:+']);
});

test('malformed markup degrades to plain text instead of throwing', () => {
    // Diff fragments routinely cut markup in half; none of this may explode.
    for (const line of [
        '*unclosed bold',
        '{{unclosed mono',
        '{unclosed macro',
        '[unclosed link',
        '!unclosed image',
        '}}stray close{{',
        '****',
        '____',
        '{}',
        '{{}}',
        '_',
        '*'
    ]) {
        roundTrip(line);
    }
});

test('empty and whitespace lines are safe', () => {
    assert.deepEqual(Markup.tokenizeLine(''), []);
    roundTrip('   ');
    roundTrip('\t');
});

test('the Jira nested-brace idiom round-trips', () => {
    // Straight out of the user's ticket: {{{}} and {{ [}}
    for (const line of ['{{{}}', '{{      [}}', '{{}}}', '{{            }}}']) {
        roundTrip(line);
    }
});

test('unicode and accents are not mangled', () => {
    roundTrip('h2. Akceptační kritéria — *tučně* a “quotes”');
    const tokens = roundTrip('_Elected From_ and _Elected To_ fields');
    assert.equal(tokens.filter((t) => t.kind === 'em').length, 2);
});

test('a long line stays linear enough to be safe', () => {
    const line = 'text '.repeat(4000);
    const started = Date.now();
    roundTrip(line);
    assert.ok(Date.now() - started < 1000, 'tokenizer must not blow up on long lines');
});
