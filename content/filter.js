/*!
 * Jira Diff Highlighter
 * ------------------------------------------------
 * Field filter for the history feed.
 *
 * The History tab is a firehose — rank bumps, worklog ids and time recalculations
 * bury the changes anyone actually came to read. This mounts a chip bar above the
 * feed and hides the rows for fields you switch off.
 *
 * Hiding is per change row, not per history entry: one Server/DC entry can carry
 * several field changes in a single table, so the whole block only disappears
 * once every row inside it is off.
 */
(function (root) {
    'use strict';

    function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    /** Fields switched off by the user, by lower-cased name. */
    var hidden = new Set();
    var initialised = false;
    var bar = null;

    function isNoisy(field, settings) {
        var lower = field.toLowerCase();
        return (settings.noisyFields || []).some(function (needle) {
            return needle && lower.indexOf(needle.toLowerCase()) !== -1;
        });
    }

    function tally(targets) {
        var counts = new Map();
        targets.forEach(function (target) {
            var field = target.fieldName || '(unnamed)';
            counts.set(field, (counts.get(field) || 0) + 1);
        });
        return counts;
    }

    /**
     * Apply current visibility to the DOM.
     * Returns the number of rows hidden, for the summary line.
     */
    function apply(targets) {
        var affected = 0;
        targets.forEach(function (target) {
            var row = target.rowElement;
            if (!row) return;
            var off = hidden.has((target.fieldName || '(unnamed)').toLowerCase());
            row.classList.toggle('jdh-filtered', off);
            if (off) affected++;
        });

        // Server/DC: collapse an entry whose every row is now hidden, otherwise
        // its "made changes - <date>" header lingers over nothing.
        document.querySelectorAll('.issue-data-block').forEach(function (block) {
            var rows = Array.prototype.filter.call(
                block.querySelectorAll('tr'),
                function (tr) { return !!tr.querySelector('td.activity-name'); }
            );
            var everyRowHidden = rows.length > 0 && rows.every(function (tr) {
                return tr.classList.contains('jdh-filtered');
            });
            block.classList.toggle('jdh-filtered', everyRowHidden);
        });

        return affected;
    }

    function render(targets, settings, onChange) {
        if (!bar) return;
        bar.textContent = '';

        var counts = tally(targets);
        var fields = Array.from(counts.keys()).sort(function (a, b) {
            return counts.get(b) - counts.get(a) || a.localeCompare(b);
        });

        bar.appendChild(el('span', 'jdh-filter-label', 'Fields'));

        var chips = el('div', 'jdh-filter-chips');
        fields.forEach(function (field) {
            var key = field.toLowerCase();
            var chip = el('button', 'jdh-chip');
            chip.type = 'button';
            chip.classList.toggle('is-off', hidden.has(key));
            chip.appendChild(el('span', 'jdh-chip-name', field));
            chip.appendChild(el('span', 'jdh-chip-count', String(counts.get(field))));
            chip.title = (hidden.has(key) ? 'Show ' : 'Hide ') + field + ' changes';
            chip.addEventListener('click', function (event) {
                event.preventDefault();
                if (hidden.has(key)) hidden.delete(key);
                else hidden.add(key);
                onChange();
            });
            chips.appendChild(chip);
        });
        bar.appendChild(chips);

        var actions = el('div', 'jdh-filter-actions');

        var allButton = el('button', 'jdh-btn', hidden.size ? 'Show all' : 'Hide all');
        allButton.type = 'button';
        allButton.addEventListener('click', function (event) {
            event.preventDefault();
            if (hidden.size) hidden.clear();
            else fields.forEach(function (f) { hidden.add(f.toLowerCase()); });
            onChange();
        });
        actions.appendChild(allButton);

        var noisy = fields.filter(function (f) { return isNoisy(f, settings); });
        if (noisy.length) {
            var everyNoisyHidden = noisy.every(function (f) {
                return hidden.has(f.toLowerCase());
            });
            var noiseButton = el(
                'button', 'jdh-btn',
                everyNoisyHidden ? 'Show noise' : 'Hide noise'
            );
            noiseButton.type = 'button';
            noiseButton.title = 'Bookkeeping fields: ' + noisy.join(', ');
            noiseButton.addEventListener('click', function (event) {
                event.preventDefault();
                noisy.forEach(function (f) {
                    if (everyNoisyHidden) hidden.delete(f.toLowerCase());
                    else hidden.add(f.toLowerCase());
                });
                onChange();
            });
            actions.appendChild(noiseButton);
        }

        bar.appendChild(actions);

        var off = targets.filter(function (t) {
            return hidden.has((t.fieldName || '(unnamed)').toLowerCase());
        }).length;
        bar.appendChild(el(
            'span', 'jdh-filter-summary',
            off ? off + ' of ' + targets.length + ' changes hidden' : ''
        ));
    }

    /**
     * @param {Array} targets every change on the page (not just diffed ones)
     * @param {object} settings
     * @param {Element|null} historyRoot where to mount the bar
     */
    function update(targets, settings, historyRoot) {
        if (!settings.showFilterBar || !targets.length || !historyRoot) {
            teardown();
            return;
        }

        // First run: switch the bookkeeping fields off, if asked to.
        if (!initialised) {
            initialised = true;
            if (settings.hideNoisyFields) {
                targets.forEach(function (target) {
                    var field = target.fieldName || '';
                    if (field && isNoisy(field, settings)) hidden.add(field.toLowerCase());
                });
            }
        }

        if (!bar || !bar.isConnected) {
            bar = el('div', 'jdh-filter');
            historyRoot.insertBefore(bar, historyRoot.firstChild);
        } else if (bar.parentElement !== historyRoot) {
            historyRoot.insertBefore(bar, historyRoot.firstChild);
        }

        function refresh() {
            apply(targets);
            render(targets, settings, refresh);
        }
        refresh();
    }

    function teardown() {
        if (bar && bar.parentElement) bar.remove();
        bar = null;
        document.querySelectorAll('.jdh-filtered').forEach(function (node) {
            node.classList.remove('jdh-filtered');
        });
    }

    /** Forget the user's choices — used when settings change wholesale. */
    function reset() {
        hidden.clear();
        initialised = false;
    }

    root.JDHFilter = {
        update: update,
        teardown: teardown,
        reset: reset,
        isNoisy: isNoisy,
        hiddenFields: function () { return Array.from(hidden); }
    };

    if (typeof module === 'object' && module.exports) {
        module.exports = root.JDHFilter;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
