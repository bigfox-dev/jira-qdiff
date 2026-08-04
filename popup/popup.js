/*!
 * Jira Diff Highlighter (Server / Data Center)
 * Popup: per-site activation + settings.
 */
(function () {
    'use strict';

    var $ = function (id) { return document.getElementById(id); };
    var settings = JDHSettings.DEFAULTS;
    var currentTab = null;
    var originPattern = null;
    var enabledSites = [];
    var statusTimer = null;

    function send(type, payload) {
        return new Promise(function (resolve) {
            chrome.runtime.sendMessage({ type: 'jdh:' + type, payload: payload || {} },
                function (response) {
                    if (chrome.runtime.lastError) {
                        resolve({ ok: false, error: chrome.runtime.lastError.message });
                        return;
                    }
                    resolve(response || { ok: false });
                });
        });
    }

    function flash(text, isError) {
        var node = $('status');
        node.textContent = text;
        node.style.color = isError ? 'var(--danger)' : '';
        if (statusTimer) clearTimeout(statusTimer);
        statusTimer = setTimeout(function () { node.textContent = ''; }, 2600);
    }

    /* ------------------------------------------------------------------ *
     * Site activation
     * ------------------------------------------------------------------ */

    function patternForUrl(url) {
        try {
            var parsed = new URL(url);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
            return parsed.protocol + '//' + parsed.hostname + '/*';
        } catch (err) {
            return null;
        }
    }

    function renderSite() {
        var host = $('site-host');
        var button = $('site-toggle');
        var hint = $('site-hint');

        if (!originPattern) {
            host.textContent = currentTab ? 'unsupported page' : 'no active tab';
            button.disabled = true;
            button.textContent = 'Enable';
            hint.textContent = 'Open your Jira issue in a tab, then reopen this popup.';
            hint.classList.add('is-error');
            return;
        }

        hint.classList.remove('is-error');
        host.textContent = new URL(currentTab.url).hostname;
        button.disabled = false;

        var active = enabledSites.indexOf(originPattern) !== -1;
        button.textContent = active ? 'Disable' : 'Enable';
        button.className = active ? 'btn btn-danger' : 'btn btn-primary';
        hint.textContent = active
            ? 'Active here. Open an issue and switch to the History tab.'
            : 'Grant access to this host so the diff view can run there.';
    }

    function onSiteToggle() {
        if (!originPattern) return;
        var active = enabledSites.indexOf(originPattern) !== -1;

        if (active) {
            send('disableSite', { pattern: originPattern }).then(function (response) {
                enabledSites = response.sites || [];
                renderSite();
                flash('Disabled on this host');
            });
            return;
        }

        // Must run inside the popup's user gesture.
        chrome.permissions.request({ origins: [originPattern] }, function (granted) {
            if (!granted) {
                flash('Permission denied', true);
                return;
            }
            send('enableSite', { pattern: originPattern, tabId: currentTab.id })
                .then(function (response) {
                    if (!response.ok) {
                        flash(response.error || 'Could not enable', true);
                        return;
                    }
                    enabledSites = response.sites || [];
                    renderSite();
                    flash('Enabled — reload if needed');
                });
        });
    }

    /* ------------------------------------------------------------------ *
     * Settings form
     * ------------------------------------------------------------------ */

    function paintSegmented(id, value) {
        Array.prototype.forEach.call($(id).children, function (button) {
            button.classList.toggle('is-active', button.dataset.value === value);
        });
    }

    function renderSettings() {
        $('enabled').checked = settings.enabled;
        $('platform').value = settings.platform;
        $('collapseUnchanged').checked = settings.collapseUnchanged;
        $('normalizeWhitespace').checked = settings.normalizeWhitespace;
        $('highlightMarkup').checked = settings.highlightMarkup;
        $('showFilterBar').checked = settings.showFilterBar;
        $('hideNoisyFields').checked = settings.hideNoisyFields;
        $('contextLines').value = settings.contextLines;
        $('minLength').value = settings.minLength;
        $('fieldNames').value = settings.fieldNames.join(', ');
        $('noisyFields').value = settings.noisyFields.join(', ');

        paintSegmented('viewMode', settings.viewMode);
        paintSegmented('granularity', settings.granularity);
        paintSegmented('fieldMode', settings.fieldMode);

        $('context-field').hidden = !settings.collapseUnchanged;
        $('minlength-field').hidden = settings.fieldMode !== 'auto';
        $('noisy-field').hidden = !settings.showFilterBar;
        $('fieldModeHint').textContent = settings.fieldMode === 'auto'
            ? 'Any multi-line or long value, plus the named fields below.'
            : 'Only fields whose name contains one of the entries below.';
    }

    function update(patch) {
        return JDHSettings.save(patch).then(function (next) {
            settings = next;
            renderSettings();
            return next;
        });
    }

    function bindSegmented(id, key) {
        $(id).addEventListener('click', function (event) {
            var button = event.target.closest('button[data-value]');
            if (!button) return;
            var patch = {};
            patch[key] = button.dataset.value;
            update(patch);
        });
    }

    function bindCheckbox(id) {
        $(id).addEventListener('change', function (event) {
            var patch = {};
            patch[id] = event.target.checked;
            update(patch);
        });
    }

    function bindNumber(id, min, max) {
        $(id).addEventListener('change', function (event) {
            var value = parseInt(event.target.value, 10);
            if (isNaN(value)) value = JDHSettings.DEFAULTS[id];
            value = Math.min(max, Math.max(min, value));
            var patch = {};
            patch[id] = value;
            update(patch);
        });
    }

    function bind() {
        $('site-toggle').addEventListener('click', onSiteToggle);

        $('platform').addEventListener('change', function (event) {
            update({ platform: event.target.value }).then(function () {
                flash('Adapter switched');
            });
        });

        bindCheckbox('enabled');
        bindCheckbox('collapseUnchanged');
        bindCheckbox('normalizeWhitespace');
        bindCheckbox('highlightMarkup');
        bindCheckbox('showFilterBar');
        bindCheckbox('hideNoisyFields');
        bindNumber('contextLines', 0, 20);
        bindNumber('minLength', 0, 5000);
        bindSegmented('viewMode', 'viewMode');
        bindSegmented('granularity', 'granularity');
        bindSegmented('fieldMode', 'fieldMode');

        function bindList(id, label) {
            $(id).addEventListener('change', function (event) {
                var names = event.target.value
                    .split(',')
                    .map(function (s) { return s.trim().toLowerCase(); })
                    .filter(Boolean);
                var patch = {};
                patch[id] = names;
                update(patch).then(function () { flash(label + ' saved'); });
            });
        }
        bindList('fieldNames', 'Field list');
        bindList('noisyFields', 'Bookkeeping list');

        $('rescan').addEventListener('click', function () {
            if (!currentTab) return;
            chrome.tabs.sendMessage(currentTab.id, { type: 'jdh:rescan' }, function (response) {
                if (chrome.runtime.lastError || !response) {
                    flash('Not running on this tab', true);
                    return;
                }
                flash(response.enhanced + ' diff(s) rendered');
            });
        });

        // Content scripts live in an isolated world, so the page console cannot
        // reach JDHContent. This is the supported way to get a report out.
        $('diagnose').addEventListener('click', function () {
            if (!currentTab) return;
            chrome.tabs.sendMessage(currentTab.id, { type: 'jdh:diagnose' }, function (response) {
                if (chrome.runtime.lastError || !response || !response.report) {
                    flash('Not running on this tab', true);
                    return;
                }
                var json = JSON.stringify(response.report, null, 2);
                console.log('[jira-diff] diagnostics', response.report);
                navigator.clipboard.writeText(json).then(function () {
                    flash('Report copied to clipboard');
                }, function () {
                    flash('Report in popup console', true);
                });
            });
        });

        $('reset').addEventListener('click', function () {
            update(JDHSettings.DEFAULTS).then(function () { flash('Defaults restored'); });
        });
    }

    /* ------------------------------------------------------------------ *
     * Boot
     * ------------------------------------------------------------------ */

    Promise.all([
        JDHSettings.load(),
        send('status'),
        new Promise(function (resolve) {
            chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
                resolve(tabs && tabs[0] ? tabs[0] : null);
            });
        })
    ]).then(function (results) {
        settings = results[0];
        enabledSites = (results[1] && results[1].sites) || [];
        currentTab = results[2];
        originPattern = currentTab && currentTab.url ? patternForUrl(currentTab.url) : null;

        renderSettings();
        renderSite();
        bind();
    });
})();
