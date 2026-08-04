/*!
 * Jira Diff Highlighter — standalone viewer
 *
 * Renders a diff handed over from a Jira tab, using the very same renderer.
 * Nothing Jira-specific reaches this page: the content script sends plain text
 * plus a serialised revision chain, so this file is only plumbing.
 *
 * Callback style on purpose — see the namespace note in common/settings.js.
 */
(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };

    function fail(message) {
        var status = $('vw-status');
        if (status) {
            status.textContent = message;
            status.classList.add('is-error');
        }
    }

    function render(payload) {
        document.title = (payload.fieldName || 'Diff') +
            (payload.source && payload.source.issueKey ? ' · ' + payload.source.issueKey : '') +
            ' — Jira diff';

        $('vw-field').textContent = payload.fieldName || 'Diff';
        if (payload.source && payload.source.issueKey) {
            $('vw-issue').textContent = payload.source.issueKey;
        }
        if (payload.source && payload.source.url) {
            var link = $('vw-link');
            link.href = payload.source.url;
            link.hidden = false;
        }

        var settings = JDHSettings.merge(payload.settings);
        // The page is already the full window, and there is no Jira markup here
        // to fall back to, so both of those controls are suppressed.
        settings.viewMode = payload.view === 'unified' ? 'unified' : settings.viewMode;

        var widget;
        try {
            widget = JDHRender.build(payload.oldText, payload.newText, settings, {
                fieldName: payload.fieldName,
                chain: payload.chain || null,
                revisionIndex: typeof payload.revisionIndex === 'number'
                    ? payload.revisionIndex
                    : -1,
                standalone: true,
                onViewChange: function (mode) {
                    JDHSettings.save({ viewMode: mode });
                },
                onMarkupChange: function (on) {
                    JDHSettings.save({ highlightMarkup: on });
                }
            });
        } catch (err) {
            fail('Could not render this diff: ' + err.message);
            return;
        }

        if (payload.view === 'blame') {
            var blameButton = widget.element
                .querySelector('[data-action="view"][data-value="blame"]');
            if (blameButton && !blameButton.disabled) blameButton.click();
        }

        var body = $('vw-body');
        body.textContent = '';
        body.appendChild(widget.element);
    }

    var id = new URLSearchParams(location.search).get('id');
    if (!id) {
        fail('No diff was handed over to this page.');
        return;
    }

    chrome.storage.session.get(id, function (data) {
        if (chrome.runtime.lastError) {
            fail('Could not read the diff: ' + chrome.runtime.lastError.message);
            return;
        }
        var payload = data && data[id];
        if (!payload) {
            fail('This diff is no longer available — session data is cleared when ' +
                'the browser restarts. Reopen it from the Jira tab.');
            return;
        }
        render(payload);
    });
})();
