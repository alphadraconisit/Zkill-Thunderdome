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
    if (img.classList.contains('itemicon')) {
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
