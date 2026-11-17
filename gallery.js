/* Просмотр фото производства. Все ссылки внутри [data-gallery] на странице — один общий ряд:
   стрелки и свайп листают его целиком, счётчик показывает место в нём. Подпись — data-cap ссылки.
   Без этого скрипта ссылка просто открывает крупную версию снимка. */
(function () {
  "use strict";
  var links = Array.prototype.slice.call(document.querySelectorAll("[data-gallery] a[href]"));
  if (!links.length || typeof HTMLDialogElement !== "function") return;

  var dlg = document.createElement("dialog");
  dlg.className = "lb";
  dlg.setAttribute("aria-label", "Фото производства");
  dlg.innerHTML =
    '<div class="lb-fig"><img alt=""></div>' +
    '<div class="lb-bar"><span class="lb-n"></span><span class="lb-cap"></span></div>' +
    '<button class="lb-prev" type="button" aria-label="Предыдущее фото">←</button>' +
    '<button class="lb-next" type="button" aria-label="Следующее фото">→</button>' +
    '<button class="lb-x" type="button" aria-label="Закрыть">✕</button>';
  document.body.appendChild(dlg);

  var fig = dlg.querySelector(".lb-fig");
  var img = fig.querySelector("img");
  var num = dlg.querySelector(".lb-n");
  var cap = dlg.querySelector(".lb-cap");
  var cur = 0;

  function show(i) {
    cur = (i + links.length) % links.length;
    var a = links[cur];
    var thumb = a.querySelector("img");
    img.classList.add("wait");
    img.onload = function () { img.classList.remove("wait"); };
    img.src = a.getAttribute("href");
    img.alt = thumb ? thumb.alt : "";
    num.textContent = (cur + 1) + " / " + links.length;
    cap.textContent = a.getAttribute("data-cap") || "";
    // соседние кадры заранее, чтобы листание не ждало сети
    [cur + 1, cur - 1].forEach(function (j) {
      new Image().src = links[(j + links.length) % links.length].getAttribute("href");
    });
  }

  function close() { if (dlg.open) dlg.close(); }

  links.forEach(function (a, i) {
    a.addEventListener("click", function (e) {
      if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;   // открыть во вкладке — как обычно
      e.preventDefault();
      show(i);
      document.documentElement.classList.add("lb-open");
      dlg.showModal();
    });
  });

  dlg.addEventListener("close", function () {
    document.documentElement.classList.remove("lb-open");
    var a = links[cur];
    if (a) a.focus({ preventScroll: true });
  });
  dlg.querySelector(".lb-prev").addEventListener("click", function () { show(cur - 1); });
  dlg.querySelector(".lb-next").addEventListener("click", function () { show(cur + 1); });
  dlg.querySelector(".lb-x").addEventListener("click", close);
  // клик по пустому месту вокруг снимка закрывает просмотр
  var swiped = false;   // свайп по пустому месту не должен закрыть просмотр следом идущим кликом
  fig.addEventListener("click", function (e) {
    if (swiped) { swiped = false; return; }
    if (e.target === fig) close();
  });
  dlg.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight") { e.preventDefault(); show(cur + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); show(cur - 1); }
  });

  // свайп на телефоне
  var x0 = null, y0 = 0;
  fig.addEventListener("pointerdown", function (e) { if (e.pointerType !== "mouse") { x0 = e.clientX; y0 = e.clientY; } });
  fig.addEventListener("pointerup", function (e) {
    if (x0 === null) return;
    var dx = e.clientX - x0, dy = e.clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) { swiped = true; show(cur + (dx < 0 ? 1 : -1)); }
  });
  fig.addEventListener("pointercancel", function () { x0 = null; });
})();
