/**
 * Platform routing and label parsing.
 *
 * The DOM-level behaviour of the adapters is covered by the two fixtures
 * (test/fixture.html, test/fixture-cloud.html) — these tests pin the parts
 * that decide WHICH adapter runs, since that is pure logic and the piece most
 * likely to be broken by a careless edit.
 *
 * Run: node --test test/adapters.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Adapters = require('../content/adapters.js');

const FIELDS = ['description', 'popis', 'environment', 'summary', 'acceptance', 'komentář'];

test('Cloud hostnames are recognised', () => {
    for (const host of [
        'eaaci.atlassian.net',
        'EAACI.Atlassian.NET',
        'foo.bar.atlassian.net',
        'team.atlassian.com',
        'something.jira.com'
    ]) {
        assert.equal(Adapters.detectPlatform(host), 'cloud', host);
    }
});

test('on-premise hostnames stay on the server adapter', () => {
    for (const host of [
        'jira.firma.cz',
        'localhost',
        'jira.internal',
        'atlassian.net.firma.cz',      // suffix must not match mid-name
        'notatlassian.net',            // must anchor on a dot boundary
        'jira-cloud.firma.cz'
    ]) {
        assert.equal(Adapters.detectPlatform(host), 'server', host);
    }
});

test('explicit platform settings override detection', () => {
    const ids = (mode, host) => Adapters.selectAdapters(mode, host).map((a) => a.id);

    assert.deepEqual(ids('server', 'eaaci.atlassian.net'), ['server']);
    assert.deepEqual(ids('cloud', 'jira.firma.cz'), ['cloud']);
    assert.deepEqual(ids('both', 'jira.firma.cz'), ['server', 'cloud']);
});

test('auto puts Cloud first on an atlassian.net host', () => {
    const ids = Adapters.selectAdapters('auto', 'eaaci.atlassian.net').map((a) => a.id);
    assert.equal(ids[0], 'cloud');
    // Server stays in the list: a custom-domain on-prem proxy is still possible.
    assert.ok(ids.includes('server'));
});

test('guessFieldName pulls a configured name out of a Cloud label', () => {
    const settings = { fieldNames: FIELDS };
    const cases = [
        ['Michal Zavadil updated the Description', 'Description'],
        ['Petra Nováková added the Environment', 'Environment'],
        ['Michal Zavadil updated the Summary · 29 Jan 2026', 'Summary'],
        ['Petra Nováková updated the Acceptance Criteria', 'Acceptance']
    ];
    for (const [label, expected] of cases) {
        assert.equal(Adapters.guessFieldName(label, settings), expected, label);
    }
});

test('guessFieldName matches across accents and case', () => {
    assert.equal(
        Adapters.guessFieldName('Jan Novák upravil Popis úkolu', { fieldNames: ['popis'] }),
        'Popis'
    );
    assert.equal(
        Adapters.guessFieldName('updated the KOMENTÁŘ', { fieldNames: ['komentář'] }),
        'KOMENTÁ' + 'Ř'
    );
});

test('guessFieldName returns nothing rather than guessing wrong', () => {
    const settings = { fieldNames: FIELDS };
    assert.equal(Adapters.guessFieldName('Michal Zavadil updated the Rank', settings), '');
    assert.equal(Adapters.guessFieldName('', settings), '');
    assert.equal(Adapters.guessFieldName('updated the Story Points', settings), '');
});

test('guessFieldName prefers the longest configured match', () => {
    const settings = { fieldNames: ['comment', 'comment visibility'] };
    assert.equal(
        Adapters.guessFieldName('updated the Comment visibility today', settings),
        'Comment visibility'
    );
});

test('both adapters expose the documented interface', () => {
    for (const adapter of [Adapters.server, Adapters.cloud]) {
        assert.equal(typeof adapter.id, 'string');
        assert.equal(typeof adapter.detect, 'function');
        assert.equal(typeof adapter.collect, 'function');
    }
    assert.equal(Adapters.server.id, 'server');
    assert.equal(Adapters.cloud.id, 'cloud');
});
