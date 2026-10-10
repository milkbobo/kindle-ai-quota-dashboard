(function (win, doc) {
  'use strict';
  var page = 0;
  var cards = [];
  var grid = doc.getElementById('quotaGrid');
  function resize() {
    doc.body.style.fontSize = (16 * Math.min(win.innerWidth / 1072, win.innerHeight / (win.innerWidth > win.innerHeight ? 1000 : 1448))) + 'px';
  }
  function show() {
    var pages = Math.max(1, Math.ceil(cards.length / 2));
    page = Math.max(0, Math.min(page, pages - 1));
    cards.forEach(function (card, i) { card.style.display = Math.floor(i / 2) === page ? 'flex' : 'none'; });
    doc.getElementById('pageLabel').textContent = (page + 1) + ' / ' + pages;
    doc.getElementById('prevPage').disabled = page === 0;
    doc.getElementById('nextPage').disabled = page === pages - 1;
  }
  win.layoutQuotaPages = function () {
    // Split large providers into cards of at most two quota windows.
    cards = [];
    Array.prototype.slice.call(grid.children).forEach(function (card) {
      var rows = Array.prototype.slice.call(card.querySelectorAll('.q-row'));
      if (rows.length <= 2) { cards.push(card); return; }
      for (var i = 0; i < rows.length; i += 2) {
        var copy = card.cloneNode(false);
        copy.appendChild(card.querySelector('.q-head').cloneNode(true));
        rows.slice(i, i + 2).forEach(function (row) { copy.appendChild(row); });
        cards.push(copy);
      }
    });
    grid.innerHTML = '';
    cards.forEach(function (card) { grid.appendChild(card); });
    show();
  };
  doc.getElementById('prevPage').onclick = function () { page -= 1; show(); };
  doc.getElementById('nextPage').onclick = function () { page += 1; show(); };
  doc.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowLeft') { page -= 1; show(); }
    if (event.key === 'ArrowRight') { page += 1; show(); }
  });
  win.addEventListener('resize', resize);
  resize();
  win.layoutQuotaPages();
}(window, document));
