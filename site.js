// Общий скрипт внутренних страниц: выбранный на первом экране цвет, перекраска вещей на картинках,
// появление блоков при прокрутке и формы-заявки (пока открывают WhatsApp).
(() => {
  "use strict";
  const COLORS = window.IZUM_COLORS;
  const WHATSAPP = "77771737475";
  const hexRgb = (hex) => [1, 3, 5].map((p) => parseInt(hex.slice(p, p + 2), 16));
  const mixHex = (rgb, k) => "#" + rgb.map((v) => Math.round(v + (255 - v) * k).toString(16).padStart(2, "0")).join("");
  let color = COLORS[0];

  // Та же перекраска, что в hero.js: жёлтые пиксели вещи заменяются выбранным цветом.
  const tinted = [...document.querySelectorAll("img[data-tint]")].map((img) => ({ img, src: img.getAttribute("src"), base: null }));
  function tint(t) {
    if (!t.base) return;
    if (color.id === "yellow") { t.img.src = t.src; return; }
    const cv = document.createElement("canvas");
    cv.width = t.base.naturalWidth; cv.height = t.base.naturalHeight;
    const g = cv.getContext("2d");
    g.drawImage(t.base, 0, 0);
    const im = g.getImageData(0, 0, cv.width, cv.height), d = im.data;
    const [tr, tg, tb] = hexRgb(color.hex).map((v) => v / 255);
    for (let p = 0; p < d.length; p += 4) {
      const al = d[p + 3];
      if (!al) continue;
      const r = d[p], gg = d[p + 1], b = d[p + 2], c = (r + gg) / 2 - b;
      if (c <= 12) continue;
      const m = c >= 40 ? 1 : (c - 12) / 28, a = Math.max(r, gg) - b;
      d[p] = r + (b + a * tr - r) * m;
      d[p + 1] = gg + (b + a * tg - gg) * m;
      d[p + 2] = b + a * tb * m;
      // светлый полупрозрачный ореол на цветном фоне читается грязью — гасим (как в шейдере hero.js)
      const lum = (0.3 * r + 0.59 * gg + 0.11 * b) / 255, av = al / 255;
      if (av < 0.92 && lum > 0.5) { const q = Math.min(1, Math.max(0, (av - 0.45) / 0.47)), w = Math.min(1, (lum - 0.5) / 0.25); d[p + 3] = al * (1 - w + w * q * q * (3 - 2 * q)); }
    }
    g.putImageData(im, 0, 0);
    t.img.src = cv.toDataURL("image/png");
  }
  tinted.forEach((t) => {
    const base = new Image();
    base.onload = () => { t.base = base; tint(t); };
    base.src = t.src;
  });

  function setColor(id) {
    color = COLORS.find((c) => c.id === id) || COLORS[0];
    const rgb = hexRgb(color.hex), lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    const st = document.documentElement.style;
    st.setProperty("--accent", color.hex);
    st.setProperty("--accent-hi", mixHex(rgb, 0.3));
    st.setProperty("--on", lum > 0.55 ? "#0d0d0d" : "#ffffff");
    st.setProperty("--accent-ink", lum < 0.3 ? mixHex(rgb, 0.38) : color.hex);
    document.querySelectorAll("[data-swatches] button").forEach((b) => b.classList.toggle("on", b.dataset.id === color.id));
    try { localStorage.setItem("izum-color", color.id); } catch (e) { /* хранилище недоступно */ }
    tinted.forEach(tint);
  }
  document.querySelectorAll("[data-swatches]").forEach((box) => {
    box.innerHTML = COLORS.map((c) => `<button type="button" data-id="${c.id}" style="--c:${c.hex}" title="${c.name}" aria-label="${c.name}"></button>`).join("");
    box.addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (b) setColor(b.dataset.id); });
  });
  let saved = null;
  try { saved = localStorage.getItem("izum-color"); } catch (e) { /* нет доступа */ }
  setColor(saved || COLORS[0].id);

  // появление блоков
  const rev = document.querySelectorAll("[data-rev]");
  if ("IntersectionObserver" in window) {
    const io = new IntersectionObserver((es) => es.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); } }), { rootMargin: "0px 0px -8% 0px" });
    rev.forEach((el) => io.observe(el));
  } else rev.forEach((el) => el.classList.add("in"));

  // Заявки. Когда появится серверный приём, задать window.IZUM_LEAD_ENDPOINT (как в hero.js).
  document.querySelectorAll("form[data-lead]").forEach((form) => {
    form.addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const f = new FormData(form), note = form.querySelector("[data-note]");
      if (window.IZUM_LEAD_ENDPOINT) {
        f.append("topic", form.dataset.lead);
        try {
          const r = await fetch(window.IZUM_LEAD_ENDPOINT, { method: "POST", body: f });
          if (!r.ok) throw new Error(r.status);
          if (note) note.textContent = "Заявка отправлена. Менеджер свяжется с вами в рабочее время.";
        } catch (e) { if (note) note.textContent = "Не получилось отправить заявку. Напишите нам в WhatsApp: +7 (777) 173 74 75."; }
        return;
      }
      const lines = [`Здравствуйте! ${form.dataset.lead}.`];
      form.querySelectorAll("[name]").forEach((el) => { const v = (f.get(el.name) || "").toString().trim(); if (v) lines.push(`${el.dataset.label || el.name}: ${v}`); });
      window.open(`https://wa.me/${WHATSAPP}?text=${encodeURIComponent(lines.join("\n"))}`, "_blank", "noopener");
    });
  });
})();
