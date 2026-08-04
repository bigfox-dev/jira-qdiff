/**
 * Theme resolution.
 *
 * The interesting case is 'auto': Jira's own colour mode has to beat the OS
 * preference, because a widget that follows only the OS glows white inside a
 * dark Jira. Everything below pins that precedence.
 *
 * Run: node --test test/theme.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Theme = require('../common/theme.js');

test('an explicit setting wins over everything', () => {
    for (const jira of ['dark', 'light', null]) {
        for (const prefersDark of [true, false]) {
            assert.equal(Theme.resolve('light', { jira, prefersDark }), 'light');
            assert.equal(Theme.resolve('dark', { jira, prefersDark }), 'dark');
        }
    }
});

test('auto follows Jira when Jira states a mode', () => {
    // The mismatch that motivated the whole setting: dark Jira, light OS.
    assert.equal(Theme.resolve('auto', { jira: 'dark', prefersDark: false }), 'dark');
    assert.equal(Theme.resolve('auto', { jira: 'light', prefersDark: true }), 'light');
});

test('auto falls back to the OS when Jira says nothing', () => {
    assert.equal(Theme.resolve('auto', { jira: null, prefersDark: true }), 'dark');
    assert.equal(Theme.resolve('auto', { jira: null, prefersDark: false }), 'light');
});

test('an unrecognised Jira value is treated as "no opinion"', () => {
    // Jira's own "match browser" setting must not be mistaken for a mode.
    for (const jira of ['auto', 'match-browser', '', 'DARKISH', undefined]) {
        assert.equal(Theme.resolve('auto', { jira, prefersDark: true }), 'dark');
        assert.equal(Theme.resolve('auto', { jira, prefersDark: false }), 'light');
    }
});

test('an unknown setting degrades to auto behaviour', () => {
    assert.equal(Theme.resolve('sepia', { jira: null, prefersDark: true }), 'dark');
    assert.equal(Theme.resolve(undefined, { jira: 'dark', prefersDark: false }), 'dark');
});

test('resolve never needs a context object', () => {
    assert.equal(Theme.resolve('dark'), 'dark');
    assert.equal(Theme.resolve('auto'), 'light', 'no signals at all means light');
});

test('the setting whitelist matches what the popup offers', () => {
    assert.deepEqual(Theme.VALID, ['auto', 'light', 'dark']);
});
