/*!
 * Jira Diff Highlighter
 * ------------------------------------------------
 * Theme resolution.
 *
 * All dark styling hangs off `html[data-jdh-theme="dark"]`, never off a media
 * query, so the palette can be forced by a setting instead of only by the OS.
 * This module is the single place that decides what that attribute says.
 *
 * On 'auto' the OS is the fallback, not the first choice: Jira has its own
 * light/dark setting, and when the two disagree a widget that follows only the
 * OS ends up glowing white inside a dark page. Jira's own choice wins when we
 * can read it.
 *
 * Callback style on purpose — see the namespace note in common/settings.js.
 */
(function (root) {
    'use strict';

    var ATTRIBUTE = 'jdhTheme';
    var VALID = ['auto', 'light', 'dark'];

    /** Attributes Atlassian's design tokens put the active colour mode in. */
    var JIRA_ATTRIBUTES = ['data-color-mode', 'data-theme-mode'];

    function prefersDark() {
        return typeof matchMedia === 'function' &&
            matchMedia('(prefers-color-scheme: dark)').matches;
    }

    /**
     * Jira's own colour mode, or null when it does not say.
     * Only exact light/dark is trusted — 'auto' and anything unrecognised means
     * Jira is itself deferring, so we should too.
     */
    function detectJira() {
        if (typeof document === 'undefined' || !document.documentElement) return null;
        var html = document.documentElement;
        for (var i = 0; i < JIRA_ATTRIBUTES.length; i++) {
            var value = (html.getAttribute(JIRA_ATTRIBUTES[i]) || '').trim().toLowerCase();
            if (value === 'dark' || value === 'light') return value;
        }
        return null;
    }

    /**
     * @param {string} setting 'auto' | 'light' | 'dark'
     * @param {{prefersDark?: boolean, jira?: string|null}} [context]
     * @returns {'light'|'dark'}
     */
    function resolve(setting, context) {
        if (setting === 'light' || setting === 'dark') return setting;

        var info = context || {};
        if (info.jira === 'dark' || info.jira === 'light') return info.jira;
        return info.prefersDark ? 'dark' : 'light';
    }

    function currentContext() {
        return { prefersDark: prefersDark(), jira: detectJira() };
    }

    var watching = false;
    var setting = 'auto';

    function paint() {
        if (typeof document === 'undefined' || !document.documentElement) return;
        var resolved = resolve(setting, currentContext());
        if (document.documentElement.dataset[ATTRIBUTE] !== resolved) {
            document.documentElement.dataset[ATTRIBUTE] = resolved;
        }
    }

    /**
     * Keep following the OS and Jira while 'auto' is in effect. Registered once;
     * `paint` is a no-op when the setting is explicit.
     */
    function watch() {
        if (watching) return;
        watching = true;

        if (typeof matchMedia === 'function') {
            var query = matchMedia('(prefers-color-scheme: dark)');
            if (query.addEventListener) query.addEventListener('change', paint);
            else if (query.addListener) query.addListener(paint);
        }

        if (typeof MutationObserver === 'function' && document.documentElement) {
            // data-jdh-theme is deliberately not in the filter, so writing it
            // cannot retrigger this observer.
            new MutationObserver(paint).observe(document.documentElement, {
                attributes: true,
                attributeFilter: JIRA_ATTRIBUTES
            });
        }
    }

    function apply(next) {
        setting = VALID.indexOf(next) === -1 ? 'auto' : next;
        paint();
        watch();
        return document.documentElement.dataset[ATTRIBUTE];
    }

    root.JDHTheme = {
        VALID: VALID,
        apply: apply,
        resolve: resolve,
        detectJira: detectJira,
        current: function () { return document.documentElement.dataset[ATTRIBUTE] || 'light'; }
    };

    if (typeof module === 'object' && module.exports) {
        module.exports = root.JDHTheme;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
