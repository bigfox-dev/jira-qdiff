/*!
 * Jira Diff Highlighter
 * ------------------------------------------------
 * Revision chains and line attribution.
 *
 * A single history entry only says "this became that". Chaining every entry for
 * one field reconstructs the whole sequence of values, which is what lets you
 * diff any two revisions — not just adjacent ones — and attribute each surviving
 * line to the revision that introduced it.
 *
 * The chain is only trustworthy if consecutive entries actually link up:
 * entry[i].newText must equal entry[i+1].oldText. When it doesn't, something is
 * missing (Cloud lazy-loads its feed, and a Jira that truncates long values in
 * history would break the same way). Those breaks are recorded as gaps rather
 * than papered over, so callers can say "incomplete" instead of guessing.
 */
(function (root) {
    'use strict';

    function splitLines(text) {
        return text.length ? text.split('\n') : [];
    }

    /** @param {Array} entries oldest change first */
    function assemble(entries) {
        var revisions = [{
            value: entries[0].oldText,
            author: null,
            when: null,
            initial: true,
            target: null
        }];
        var gaps = [];

        for (var i = 0; i < entries.length; i++) {
            if (i > 0 && entries[i - 1].newText !== entries[i].oldText) {
                gaps.push({ after: revisions.length - 1 });
            }
            revisions.push({
                value: entries[i].newText,
                author: entries[i].author || null,
                when: entries[i].when || null,
                initial: false,
                target: entries[i]
            });
        }
        return { revisions: revisions, gaps: gaps };
    }

    /**
     * Group targets by field and chain each group.
     * @param {Array} targets in DOM order
     * @returns {Map<string, object>}
     */
    function buildChains(targets) {
        var byField = new Map();
        targets.forEach(function (target) {
            var field = target.fieldName;
            if (!field) return;
            if (!byField.has(field)) byField.set(field, []);
            byField.get(field).push(target);
        });

        var chains = new Map();
        byField.forEach(function (entries, field) {
            if (!entries.length) return;

            // Jira's activity feed can be configured newest-first or
            // oldest-first, so DOM order is not a safe assumption. Try both and
            // keep whichever one actually chains up.
            var descending = assemble(entries.slice().reverse());
            var ascending = assemble(entries.slice());
            var chosen = descending.gaps.length <= ascending.gaps.length
                ? descending
                : ascending;

            chains.set(field, {
                field: field,
                revisions: chosen.revisions,
                gaps: chosen.gaps,
                complete: chosen.gaps.length === 0,
                domOrderNewestFirst: chosen === descending
            });
        });
        return chains;
    }

    /** Index in chain.revisions produced by this target's change. */
    function revisionIndexOf(chain, target) {
        for (var i = 0; i < chain.revisions.length; i++) {
            if (chain.revisions[i].target === target) return i;
        }
        return -1;
    }

    /**
     * Attribute every line of the newest revision to the revision that
     * introduced it: replay the chain forward, carrying attribution across
     * unchanged lines and stamping inserted ones.
     *
     * @returns {{lines: string[], revisions: object[], trustworthy: boolean}}
     */
    function blame(chain) {
        var D = root.JDHDiff;
        var revisions = chain.revisions;
        var attribution = splitLines(revisions[0].value).map(function () {
            return revisions[0];
        });

        for (var i = 1; i < revisions.length; i++) {
            var previous = splitLines(revisions[i - 1].value);
            var next = splitLines(revisions[i].value);
            var moves = D.diffArrays(previous, next);
            var carried = new Array(next.length);

            for (var m = 0; m < moves.length; m++) {
                var op = moves[m][0];
                var ai = moves[m][1];
                var bi = moves[m][2];
                if (op === D.EQUAL) carried[bi] = attribution[ai];
                else if (op === D.INSERT) carried[bi] = revisions[i];
            }
            for (var f = 0; f < carried.length; f++) {
                if (!carried[f]) carried[f] = revisions[i];
            }
            attribution = carried;
        }

        return {
            lines: splitLines(revisions[revisions.length - 1].value),
            revisions: attribution,
            trustworthy: chain.complete
        };
    }

    /**
     * Strip the DOM back-references so a chain can cross a message boundary.
     * Everything the renderer and blame need is plain data; `target` is the only
     * live object in there.
     */
    function toPayload(chain) {
        if (!chain) return null;
        return {
            field: chain.field,
            complete: chain.complete,
            gaps: chain.gaps.map(function (gap) { return { after: gap.after }; }),
            domOrderNewestFirst: chain.domOrderNewestFirst,
            revisions: chain.revisions.map(function (revision) {
                return {
                    value: revision.value,
                    author: revision.author,
                    when: revision.when,
                    initial: revision.initial
                };
            })
        };
    }

    root.JDHHistory = {
        buildChains: buildChains,
        revisionIndexOf: revisionIndexOf,
        blame: blame,
        assemble: assemble,
        toPayload: toPayload
    };

    if (typeof module === 'object' && module.exports) {
        module.exports = root.JDHHistory;
    }
})(typeof globalThis !== 'undefined' ? globalThis : this);
