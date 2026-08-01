// Progressive enhancement only — every page works without this file.
(function () {
  'use strict';

  // Ship renders come from EVE's image server; if a type has no art (or the
  // board is offline) swap in the tinted initials tile instead of a broken icon.
  document.addEventListener('error', function (event) {
    var img = event.target;
    if (!(img instanceof HTMLImageElement) || img.dataset.fallbackApplied) return;
    img.dataset.fallbackApplied = '1';

    var name = img.alt || '?';
    var span = document.createElement('span');
    span.className = img.closest('.killhead-ship') ? 'shipfallback big' : 'shipfallback';
    if (img.closest('.crew-ship-icon')) {
      span.className = 'crew-ship-blank';
      span.textContent = '';
    } else if (img.classList.contains('itemicon')) {
      span.className = 'itemicon placeholder';
      span.textContent = '';
    } else {
      span.textContent = name.split(/[\s-]+/).filter(Boolean).slice(0, 2)
        .map(function (w) { return w[0].toUpperCase(); }).join('');
      span.style.background = tint(name);
    }
    img.replaceWith(span);
  }, true);

  function tint(name) {
    var hash = 0;
    for (var i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
    return 'hsl(' + (hash % 360) + ' 45% 32%)';
  }

  // Range slider beside the killmail list: picks a contiguous run of kills and
  // feeds them to the battle report. Without this the form still submits every
  // kill on the page, so the feature degrades to "report on this page".
  document.querySelectorAll('[data-killselect]').forEach(function (form) {
    var rail = form.querySelector('[data-rail]');
    var rangeEl = form.querySelector('[data-rail-range]');
    var rows = Array.prototype.slice.call(form.querySelectorAll('[data-kill-id]'));
    var idsInput = form.querySelector('[data-selected-ids]');
    var countEl = form.querySelector('[data-selection-count]');
    var summaryEl = form.querySelector('[data-selection-summary]');
    var hintEl = form.querySelector('[data-slider-hint]');
    if (!rail || !rows.length || !idsInput) return;

    var handles = {
      start: rail.querySelector('[data-handle="start"]'),
      end: rail.querySelector('[data-handle="end"]'),
    };
    var value = { start: 0, end: rows.length - 1 };

    rail.hidden = false;
    if (hintEl) hintEl.hidden = false;

    // Handle positions are derived from where the rows actually are, so the
    // rail stays aligned whatever the row heights turn out to be.
    //
    // Everything is measured relative to the rail, because that is the
    // containing block the handles are positioned in — offsetTop would be
    // relative to some other ancestor and put the two out of step.
    var centres = [];
    function measure() {
      var railTop = rail.getBoundingClientRect().top;
      centres = rows.map(function (row) {
        var box = row.getBoundingClientRect();
        return box.top + box.height / 2 - railTop;
      });
    }

    function centreOf(index) {
      return centres[index] || 0;
    }

    function render() {
      if (!centres.length) measure();
      var lo = Math.min(value.start, value.end);
      var hi = Math.max(value.start, value.end);

      rows.forEach(function (row, i) {
        row.classList.toggle('is-outside', i < lo || i > hi);
      });

      var top = centreOf(lo);
      var bottom = centreOf(hi);
      rangeEl.style.top = top + 'px';
      rangeEl.style.height = Math.max(2, bottom - top) + 'px';
      handles.start.style.top = centreOf(value.start) + 'px';
      handles.end.style.top = centreOf(value.end) + 'px';
      handles.start.setAttribute('aria-valuenow', String(value.start));
      handles.end.setAttribute('aria-valuenow', String(value.end));

      var selected = rows.slice(lo, hi + 1);
      idsInput.value = selected.map(function (r) { return r.dataset.killId; }).join(',');
      if (countEl) countEl.textContent = String(selected.length);
      if (summaryEl) {
        summaryEl.textContent = selected.length === rows.length
          ? 'All ' + rows.length + ' killmails on this page selected.'
          : 'Selected ' + selected.length + ' of ' + rows.length + ' killmails on this page.';
      }
    }

    function nearestIndex(clientY) {
      var offset = clientY - rail.getBoundingClientRect().top;
      var best = 0;
      var bestDistance = Infinity;
      for (var i = 0; i < centres.length; i++) {
        var distance = Math.abs(centres[i] - offset);
        if (distance < bestDistance) { bestDistance = distance; best = i; }
      }
      return best;
    }

    Object.keys(handles).forEach(function (key) {
      var handle = handles[key];

      handle.addEventListener('pointerdown', function (event) {
        event.preventDefault();
        handle.setPointerCapture(event.pointerId);
        handle.classList.add('is-dragging');
      });

      handle.addEventListener('pointermove', function (event) {
        if (!handle.hasPointerCapture(event.pointerId)) return;
        value[key] = nearestIndex(event.clientY);
        render();
      });

      handle.addEventListener('pointerup', function (event) {
        handle.releasePointerCapture(event.pointerId);
        handle.classList.remove('is-dragging');
      });

      handle.addEventListener('keydown', function (event) {
        var step = 0;
        if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') step = -1;
        else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') step = 1;
        else if (event.key === 'PageUp') step = -5;
        else if (event.key === 'PageDown') step = 5;
        else if (event.key === 'Home') value[key] = 0;
        else if (event.key === 'End') value[key] = rows.length - 1;
        else return;

        event.preventDefault();
        if (step) value[key] = Math.min(rows.length - 1, Math.max(0, value[key] + step));
        render();
      });
    });

    // Clicking a row's gutter area moves the nearer handle to it.
    rail.addEventListener('pointerdown', function (event) {
      if (event.target !== rail && event.target.className !== 'killrail-track') return;
      var index = nearestIndex(event.clientY);
      var key = Math.abs(index - value.start) <= Math.abs(index - value.end) ? 'start' : 'end';
      value[key] = index;
      render();
    });

    window.addEventListener('resize', function () {
      measure();
      render();
    });

    measure();
    render();
  });

  // Per-side pilot filter. Rows carry their searchable text in data-crew, so
  // this never has to touch or rebuild the markup.
  document.querySelectorAll('[data-side]').forEach(function (side) {
    var input = side.querySelector('[data-side-filter]');
    var rows = side.querySelectorAll('.crewrow');
    var empty = side.querySelector('.crew-empty');
    if (!input || !rows.length) return;

    input.addEventListener('input', function () {
      var term = input.value.trim().toLowerCase();
      var shown = 0;

      rows.forEach(function (row) {
        var match = !term || (row.dataset.crew || '').indexOf(term) !== -1;
        row.hidden = !match;
        if (match) shown++;
      });

      if (empty) empty.hidden = shown !== 0;
    });
  });

  // Crosshair + tooltip for the damage timeline. The chart itself is already
  // drawn server-side; this only adds the read-off layer.
  document.querySelectorAll('[data-chart]').forEach(function (figure) {
    var svg = figure.querySelector('svg');
    var payload = figure.querySelector('.chartdata');
    var tip = figure.querySelector('.charttip');
    var crosshair = figure.querySelector('.crosshair');
    var line = figure.querySelector('.crosshair-line');
    if (!svg || !payload || !tip || !crosshair || !line) return;

    var data;
    try {
      data = JSON.parse(payload.textContent);
    } catch (err) {
      return;
    }
    if (!data.columns || !data.columns.length) return;

    function nearestColumn(viewX) {
      var best = data.columns[0];
      var bestDistance = Infinity;
      for (var i = 0; i < data.columns.length; i++) {
        var distance = Math.abs(data.columns[i].x - viewX);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = data.columns[i];
        }
      }
      return best;
    }

    function show(event) {
      var rect = svg.getBoundingClientRect();
      if (!rect.width) return;
      var viewX = ((event.clientX - rect.left) / rect.width) * data.viewWidth;
      var column = nearestColumn(viewX);

      crosshair.removeAttribute('hidden');
      line.setAttribute('x1', column.x);
      line.setAttribute('x2', column.x);

      // Series labels are user data — build the DOM, never assign innerHTML.
      tip.textContent = '';
      var time = document.createElement('div');
      time.className = 'charttip-time';
      time.textContent = column.label;
      tip.appendChild(time);

      column.values
        .slice()
        .sort(function (a, b) { return b.value - a.value; })
        .forEach(function (entry) {
          var row = document.createElement('div');
          row.className = 'charttip-row';

          var key = document.createElement('span');
          key.className = 'charttip-key';
          key.style.background = entry.color;

          var value = document.createElement('span');
          value.className = 'charttip-value';
          value.textContent = entry.value.toLocaleString('en-US');

          var name = document.createElement('span');
          name.className = 'charttip-label';
          name.textContent = entry.label;

          row.appendChild(key);
          row.appendChild(value);
          row.appendChild(name);
          tip.appendChild(row);
        });

      tip.removeAttribute('hidden');

      // Flip the tooltip to the other side near the right edge.
      var ratio = column.x / data.viewWidth;
      var left = ratio * rect.width;
      tip.style.left = Math.max(8, Math.min(rect.width - tip.offsetWidth - 8,
        ratio > 0.6 ? left - tip.offsetWidth - 12 : left + 12)) + 'px';
    }

    function hide() {
      crosshair.setAttribute('hidden', '');
      tip.setAttribute('hidden', '');
    }

    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerleave', hide);
  });

  // "/" focuses the search box, as on most killboards.
  document.addEventListener('keydown', function (event) {
    if (event.key !== '/' || event.metaKey || event.ctrlKey) return;
    var tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    var input = document.querySelector('.searchbox input');
    if (input) {
      event.preventDefault();
      input.focus();
    }
  });
})();
