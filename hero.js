// Первый экран Izum: очередь вещей → выбранная подлетает к камере → на неё можно примерить
// свой логотип или паттерн и выбрать цвет. Вырос из presentation/falcon/app.js.
(() => {
  "use strict";

  const ITEMS = window.IZUM_ITEMS, COLORS = window.IZUM_COLORS, METHODS = window.IZUM_METHODS;
  const N = ITEMS.length;
  const STEP = 0.38;               // угол между соседями на дуге, рад
  const THICK = 18;                // «толщина» плоской вырезки, px
  const LAYERS = 5;
  const CH_ANGLE = [8, 26, 0];     // поворот вещи в каждом разделе, градусы (только от исходной позы вперёд);
                                   // в разделе «Ваш логотип» вещь стоит строго лицом
  const CHAPTERS = CH_ANGLE.length;
  const CUSTOM = 2;                // раздел с примеркой логотипа
  const WHATSAPP = "77771737475";

  const $ = (id) => document.getElementById(id);
  const app = $("app"), stage = $("stage");
  const pedTop = document.querySelector(".pedestal-top"), pedBottom = document.querySelector(".pedestal-bottom");

  const S = {
    pos: 0, target: 0,      // позиция очереди (дробная) и цель
    active: -1,             // индекс вещи в режиме презентации
    chapter: 0,
    g: 0,                   // 0 — очередь, 1 — презентация
    flat: 0,                // 0 — вещь слегка наклонена, 1 — стоит ровно (примерка)
    shown: -1,              // индекс, подписанный внизу
    W: 0, H: 0, mobile: false, size: 0, R: 0,
    color: null,            // выбранный цвет {id, name, hex, t:[r,g,b] 0..1}
    visible: true,          // первый экран в зоне видимости
  };

  // Нанесение пользователя
  const C = {
    src: null,              // canvas с логотипом (обрезан по содержимому)
    mono: false,            // логотип набран текстом — цвет подбирается под поверхность
    mode: "logo",           // logo | pattern
    tint: "orig",           // orig | white | black
    scale: 1,
    ver: 0,                 // растёт при любом изменении — слои вещей пересобираются
    off: ITEMS.map(() => ({ x: 0, y: 0 })),   // сдвиг логотипа на каждой вещи, в долях кадра
  };

  // ---------- сборка сцены ----------
  const turnQueue = [];   // вещи, чьи кадры оборота ещё не загружены
  let turnBusy = false;
  const nodes = ITEMS.map((it, i) => {
    const el = document.createElement("div");
    el.className = "item";
    el.dataset.i = i;
    for (let k = 0; k < LAYERS; k++) {
      const img = new Image();
      img.src = it.img;
      img.alt = k === 0 ? it.name : "";
      img.decoding = "async";
      img.draggable = false;
      img.style.transform = `translateZ(${THICK / 2 - (THICK * k) / (LAYERS - 1)}px)`;
      if (k > 0 && k < LAYERS - 1) img.className = "mid";
      el.appendChild(img);
    }
    const sh = document.createElement("div");
    sh.className = "shadow";
    stage.append(sh, el);
    const node = { el, sh, h: 0, rot: 0, rotT: 0, rotGoal: 0, rotFrom: 0, rotT0: 0, rotDur: 1, w: 0, hgt: 0, heroK: 1, turn: null, layer: null };
    if (it.turn) turnQueue.push({ node, turn: it.turn, phase: 1 });
    return node;
  });

  // Кадры оборота: номер кадра задаётся углом поворота, поэтому вещь реально вращается.
  // Загрузка в два прохода: сначала у всех кадры около исходной позы, потом остальные — от центра очереди.
  const frameUrl = (turn, k) => `${turn.dir}/${String(k).padStart(3, "0")}.webp`;
  function nextTurn() {
    if (turnBusy || !turnQueue.length) return;
    turnQueue.sort((p, q) => p.phase - q.phase || dist(p.node) - dist(q.node));
    const job = turnQueue.shift(), { node, turn } = job;
    turnBusy = true;
    let work;
    if (job.phase === 1) {
      const ks = restFrames(turn.n);
      work = fetchAll(ks.map((k) => frameUrl(turn, k))).then(async (got) => {
        const canvas = document.createElement("canvas");
        canvas.className = "turn";
        canvas.width = turn.fw; canvas.height = turn.fh;
        const t = { ...turn, canvas, ctx: canvas.getContext("2d", { willReadFrequently: true }), blobs: new Array(turn.n), lo: new Array(turn.n), hi: new Array(turn.n),
                    complete: false, full: false, busy: false, drop: false, dirty: true, shown: null, pk: "" };
        ks.forEach((k, j) => { t.blobs[k] = got[j]; });
        await decodeRest(t);
        node.turn = t;
        node.el.append(canvas);
        node.el.classList.add("turning");
        layout();
        turnQueue.push({ node, turn, phase: 2 });
      });
    } else {
      const t = node.turn, ks = [];
      for (let k = 0; k < t.n; k++) if (!t.blobs[k]) ks.push(k);
      work = fetchAll(ks.map((k) => frameUrl(turn, k))).then((got) => {
        ks.forEach((k, j) => { t.blobs[k] = got[j]; });
        t.complete = true;
      });
    }
    work.catch(() => { if ((job.tries = (job.tries || 0) + 1) < 3) turnQueue.push(job); })
        .finally(() => { turnBusy = false; nextTurn(); });
  }

  // Не больше 8 запросов сразу и до 4 попыток на файл — по сети отдельные запросы срываются.
  async function fetchAll(urls) {
    const out = new Array(urls.length);
    let next = 0;
    const one = async (u) => {
      for (let attempt = 0; ; attempt++) {
        try { const r = await fetch(u); if (r.ok) return await r.blob(); throw new Error(r.status); }
        catch (err) { if (attempt >= 3) throw err; await new Promise((res) => setTimeout(res, 400 * (attempt + 1))); }
      }
    };
    const worker = async () => { while (next < urls.length) { const k = next++; out[k] = await one(urls[k]); } };
    await Promise.all(Array.from({ length: 8 }, worker));
    return out;
  }

  // Кадры распаковываются заранее, чтобы вращение не запиналось на декодировании:
  //  • у каждой вещи — кадры около исходной позы в половинном размере (их хватает для очереди);
  //  • у вещи в центре и у выбранной — весь оборот в полном размере; когда вещь уходит, они освобождаются.
  const REST = 20;
  const restFrames = (n) => { const ks = []; for (let j = -2; j <= REST; j++) ks.push(mod(j, n)); return ks; };
  async function decodeRest(t) {
    const half = Math.max(1, Math.round(t.fw / 2));
    await Promise.all(restFrames(t.n).map(async (k) => { t.lo[k] = await createImageBitmap(t.blobs[k], { resizeWidth: half, resizeQuality: "high" }); }));
  }
  async function decodeFull(t) {
    if (t.full || t.busy || !t.complete) return;
    t.busy = true;
    for (let s = 0; s < t.n && !t.drop; s += 12) {
      const ks = [];
      for (let k = s; k < Math.min(t.n, s + 12); k++) if (!t.hi[k]) ks.push(k);
      await Promise.all(ks.map(async (k) => { t.hi[k] = await createImageBitmap(t.blobs[k]); }));
      t.dirty = true;
    }
    t.busy = false;
    if (t.drop) freeFull(t); else t.full = true;
  }
  function freeFull(t) {
    for (const b of t.hi) if (b) b.close();
    t.hi = new Array(t.n); t.full = false; t.drop = false; t.dirty = true;
  }
  function frameOf(t, k) {
    if (t.hi[k]) return t.hi[k];
    if (t.lo[k]) return t.lo[k];
    for (let j = 1; j < t.n; j++) {         // нужный кадр ещё не распакован — берём ближайший готовый
      const a = mod(k - j, t.n), b = mod(k + j, t.n);
      if (t.hi[a] || t.lo[a]) return t.hi[a] || t.lo[a];
      if (t.hi[b] || t.lo[b]) return t.hi[b] || t.lo[b];
    }
    return null;
  }

  const dist = (node) => { const i = nodes.indexOf(node); return i === S.active ? -1 : Math.abs(wrap(i - S.pos)); };

  // ---------- цвет ----------
  // Вещи сняты в чёрном с жёлтым. Жёлтые пиксели перекрашиваются в выбранный цвет:
  // пиксель раскладывается на «белую» часть (канал B) и «жёлтую» (max(R,G) − B), жёлтая заменяется цветом.
  const hexRgb = (hex) => [1, 3, 5].map((p) => parseInt(hex.slice(p, p + 2), 16));
  const mixHex = (rgb, k) => "#" + rgb.map((v) => Math.round(v + (255 - v) * k).toString(16).padStart(2, "0")).join("");
  function setColor(id) {
    const c = COLORS.find((x) => x.id === id) || COLORS[0];
    const rgb = hexRgb(c.hex);
    const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    S.color = { ...c, t: rgb.map((v) => v / 255) };
    const st = document.documentElement.style;
    st.setProperty("--accent", c.hex);
    st.setProperty("--accent-hi", mixHex(rgb, 0.3));
    st.setProperty("--on", lum > 0.55 ? "#0d0d0d" : "#ffffff");
    st.setProperty("--accent-ink", lum < 0.3 ? mixHex(rgb, 0.38) : c.hex);
    app.dataset.on = lum > 0.55 ? "dark" : "light";
    document.querySelectorAll("[data-swatches] button").forEach((b) => b.classList.toggle("on", b.dataset.id === c.id));
    try { localStorage.setItem("izum-color", c.id); } catch (e) { /* хранилище недоступно — не страшно */ }
  }

  // ---------- логотип пользователя ----------
  const layerCv = document.createElement("canvas");
  const layerCx = layerCv.getContext("2d", { willReadFrequently: true });

  // Слой нанесения в координатах кадра вещи: логотип в зоне печати или паттерн по всей вещи.
  function layerFor(node, i) {
    if (node.layer && node.layer.ver === C.ver) return node.layer;
    const t = node.turn, p = ITEMS[i].print, o = C.off[i], src = C.src;
    layerCv.width = t.fw; layerCv.height = t.fh;
    const g = layerCx;
    g.clearRect(0, 0, t.fw, t.fh);
    let bx = 0, by = 0, bw = t.fw, bh = t.fh;
    if (C.mode === "pattern") {
      const w = t.fw * 0.17 * C.scale, h = (w * src.height) / src.width;
      const gx = w * 1.55, gy = h + w * 0.42, diag = Math.hypot(t.fw, t.fh);
      g.save();
      g.translate(t.fw / 2, t.fh / 2);
      g.rotate(-0.2);
      for (let r = -Math.ceil(diag / 2 / gy), row = 0; r * gy < diag / 2; r++, row++) {
        for (let x = -diag / 2 - (row % 2 ? gx / 2 : 0); x < diag / 2; x += gx) g.drawImage(src, x, r * gy - h / 2, w, h);
      }
      g.restore();
    } else {
      let w = p.w * t.fw * C.scale, h = (w * src.height) / src.width;
      const maxH = t.fh * 0.5 * Math.max(1, C.scale);
      if (h > maxH) { w *= maxH / h; h = maxH; }
      const x = (p.x + o.x) * t.fw - w / 2, y = (p.y + o.y) * t.fh - h / 2;
      g.drawImage(src, x, y, w, h);
      bx = clamp(Math.floor(x), 0, t.fw - 1); by = clamp(Math.floor(y), 0, t.fh - 1);
      bw = clamp(Math.ceil(x + w) - bx, 1, t.fw - bx); bh = clamp(Math.ceil(y + h) - by, 1, t.fh - by);
    }
    node.layer = { ver: C.ver, data: g.getImageData(bx, by, bw, bh).data, bx, by, bw, bh };
    return node.layer;
  }

  // Один кадр вещи: перекраска и нанесение считаются попиксельно, поверх уже нарисованного кадра.
  function paint(node, i, t, img, k) {
    const { ctx, fw, fh } = t;
    ctx.clearRect(0, 0, fw, fh);
    ctx.drawImage(img, 0, 0, fw, fh);
    const recolor = S.color.id !== "yellow";
    const lay = k > 0 && C.src ? layerFor(node, i) : null;
    if (!recolor && !lay) return;
    const im = ctx.getImageData(0, 0, fw, fh), d = im.data;

    if (recolor) {
      const tr = S.color.t[0], tg = S.color.t[1], tb = S.color.t[2];
      for (let p = 0; p < d.length; p += 4) {
        if (!d[p + 3]) continue;
        const r = d[p], g = d[p + 1], b = d[p + 2];
        const c = (r + g) / 2 - b;                     // «желтизна» пикселя; в глубоких складках жёлтый уходит в коричневый
        if (c <= 12) continue;
        const m = c >= 40 ? 1 : (c - 12) / 28;
        const a = (r > g ? r : g) - b, al = d[p + 3];
        if (al < 180) {                                // полупрозрачный ореол (отсвет вещи на фоне) — в серую тень, а не в цвет
          const k = al <= 60 ? 0 : (al - 60) / 120, gr = 0.3 * r + 0.59 * g + 0.11 * b;
          d[p] = r + (gr + (b + a * tr - gr) * k - r) * m;
          d[p + 1] = g + (gr + (b + a * tg - gr) * k - g) * m;
          d[p + 2] = b + (gr + (b + a * tb - gr) * k - b) * m;
          continue;
        }
        d[p] = r + (b + a * tr - r) * m;
        d[p + 1] = g + (b + a * tg - g) * m;
        d[p + 2] = b + a * tb * m;
      }
    }

    if (lay) {
      const L = lay.data, { bx, by, bw, bh } = lay;
      let sum = 0, cnt = 0;                            // средняя яркость поверхности под нанесением
      for (let y = 0; y < bh; y += 2) for (let x = 0; x < bw; x += 2) {
        const q = (y * bw + x) * 4;
        if (L[q + 3] < 8) continue;
        const p = ((by + y) * fw + bx + x) * 4;
        if (d[p + 3] < 128) continue;
        sum += 0.3 * d[p] + 0.59 * d[p + 1] + 0.11 * d[p + 2]; cnt++;
      }
      if (cnt) {
        const ref = Math.max(14, sum / cnt), pattern = C.mode === "pattern";
        let tint = C.tint;
        if (tint === "orig" && C.mono) tint = ref < 120 ? "white" : "black";   // текст — контрастно к поверхности
        const flat = tint === "white" ? 244 : 20, kk = k * (pattern ? 0.84 : 0.96);
        for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) {
          const q = (y * bw + x) * 4, la0 = L[q + 3];
          if (!la0) continue;
          const p = ((by + y) * fw + bx + x) * 4, pa = d[p + 3];
          if (!pa) continue;                           // мимо вещи нанесение не ложится
          const la = (la0 / 255) * (pa / 255) * kk;
          let sh = 1;                                  // нанесение повторяет складки и тени ткани
          if (!pattern) { sh = 1 + ((0.3 * d[p] + 0.59 * d[p + 1] + 0.11 * d[p + 2]) / ref - 1) * 0.5; sh = sh < 0.62 ? 0.62 : sh > 1.18 ? 1.18 : sh; }
          const orig = tint === "orig";
          d[p] += ((orig ? L[q] : flat) * sh - d[p]) * la;
          d[p + 1] += ((orig ? L[q + 1] : flat) * sh - d[p + 1]) * la;
          d[p + 2] += ((orig ? L[q + 2] : flat - 4) * sh - d[p + 2]) * la;
        }
      }
    }
    ctx.putImageData(im, 0, 0);
  }

  function logoChanged() {
    C.ver++;
    app.dataset.logo = C.src ? "1" : "0";
    $("toolHint").textContent = !C.src ? "Загрузите файл или напишите название — логотип сразу появится на вещи."
      : C.mode === "pattern" ? "Паттерн покрывает всю вещь. Размер — ползунком или колесом мыши над вещью."
      : "Двигайте логотип прямо на вещи. Размер — ползунком или колесом мыши над вещью.";
  }

  // Картинка → canvas: уменьшаем, у непрозрачных файлов убираем белый фон, обрезаем поля.
  function useImage(img) {
    const iw = img.naturalWidth || img.width || 512, ih = img.naturalHeight || img.height || 512;
    const k = Math.min(1, 800 / Math.max(iw, ih));
    const cv = document.createElement("canvas");
    cv.width = Math.max(1, Math.round(iw * k)); cv.height = Math.max(1, Math.round(ih * k));
    const g = cv.getContext("2d", { willReadFrequently: true });
    g.drawImage(img, 0, 0, cv.width, cv.height);
    const im = g.getImageData(0, 0, cv.width, cv.height), d = im.data;
    let opaque = true;
    for (let p = 3; p < d.length; p += 4) if (d[p] < 250) { opaque = false; break; }
    if (opaque) {
      for (let p = 0; p < d.length; p += 4) {
        const mn = Math.min(d[p], d[p + 1], d[p + 2]);
        d[p + 3] = mn >= 250 ? 0 : mn <= 215 ? 255 : Math.round(((250 - mn) / 35) * 255);
      }
    }
    let x0 = cv.width, y0 = cv.height, x1 = -1, y1 = -1;
    for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
      if (d[(y * cv.width + x) * 4 + 3] > 16) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
    if (x1 < 0) return false;                          // пустая картинка
    g.putImageData(im, 0, 0);
    const out = document.createElement("canvas");
    out.width = x1 - x0 + 1; out.height = y1 - y0 + 1;
    out.getContext("2d").drawImage(cv, x0, y0, out.width, out.height, 0, 0, out.width, out.height);
    C.src = out; C.mono = false;
    logoChanged();
    return true;
  }
  function useFile(file) {
    if (!file || !/^image\//.test(file.type)) return;
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => { useImage(img); URL.revokeObjectURL(url); $("textLogo").value = ""; if (S.active < 0) open(Math.round(S.target), CUSTOM); else setChapter(CUSTOM); };
    img.onerror = () => { URL.revokeObjectURL(url); $("toolHint").textContent = "Не получилось прочитать файл. Подойдёт PNG, SVG или JPG."; };
    img.src = url;
  }
  async function useText(s) {
    s = s.trim().toUpperCase();
    if (!s) { C.src = null; logoChanged(); return; }
    const font = 'italic 900 150px "Gotham Pro", Arial, sans-serif';
    try { await document.fonts.load(font, s); } catch (e) { /* возьмём запасной шрифт */ }
    const cv = document.createElement("canvas"), g = cv.getContext("2d");
    g.font = font;
    cv.width = Math.ceil(g.measureText(s).width) + 40; cv.height = 170;
    g.font = font; g.textBaseline = "middle"; g.fillStyle = "#141414";
    g.fillText(s, 14, 90);
    C.src = cv; C.mono = true;
    logoChanged();
  }

  // ---------- геометрия ----------
  function layout() {
    S.W = app.clientWidth; S.H = app.clientHeight;
    S.mobile = S.W <= 820;
    S.size = S.mobile ? Math.min(S.W * 0.44, S.H * 0.28) : Math.min(S.H * 0.3, S.W * 0.2);
    S.R = S.size / STEP * (S.mobile ? 1.15 : 1.02);
    const boxW = S.mobile ? S.W * 0.66 : S.W * 0.4;
    const boxH = S.mobile ? S.H * 0.25 : S.H * 0.62;
    ITEMS.forEach((it, i) => {
      const n = nodes[i];
      const long = Math.max(it.w, it.h), short = Math.min(it.w, it.h);
      const k = (S.size / long) * Math.min(1.28, Math.pow(long / short, 0.3));
      n.w = it.w * k; n.hgt = it.h * k;
      n.el.style.width = n.w + "px"; n.el.style.height = n.hgt + "px";
      n.el.style.margin = `${-n.hgt / 2}px 0 0 ${-n.w / 2}px`;
      n.heroK = Math.min(boxW / n.w, boxH / n.hgt);
      if (n.turn) {   // совмещаем вещь в кадре с рамкой вырезки
        const t = n.turn, q = n.hgt / t.oh, c = t.canvas.style;
        c.width = t.fw * q + "px"; c.height = t.fh * q + "px";
        c.left = (n.w - t.ow * q) / 2 - t.ox * q + "px"; c.top = -t.oy * q + "px";
      }
    });
    const cy = S.H * 0.44;
    pedTop.style.top = cy - S.size * 0.92 + "px";
    pedBottom.style.top = cy + S.size * 0.74 + "px";
  }

  const mod = (a, n) => ((a % n) + n) % n;
  const wrap = (d) => { d = mod(d, N); return d > N / 2 ? d - N : d; };
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const smooth = (t) => t * t * (3 - 2 * t);
  const pad = (n) => String(n).padStart(2, "0");

  // ---------- кадр ----------
  let last = performance.now();
  function frame(now) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (!S.visible) return;
    const t = now / 1000;
    const { W, H, size, R } = S;

    S.pos += (S.target - S.pos) * (1 - Math.exp(-dt * 7));
    S.g += ((S.active >= 0 ? 1 : 0) - S.g) * (1 - Math.exp(-dt * 5));
    S.flat += ((S.active >= 0 && S.chapter === CUSTOM ? 1 : 0) - S.flat) * (1 - Math.exp(-dt * 5));

    const heroX = S.mobile ? 0 : W * 0.19;
    const heroY = S.mobile ? -H * 0.27 : H * 0.03;
    const baseY = -H * 0.06;

    for (let i = 0; i < N; i++) {
      const n = nodes[i];
      n.h = clamp(n.h + (i === S.active ? dt / 1.15 : -dt / 0.85), 0, 1);
      if (n.rotT !== n.rotGoal) {            // новая цель — новый отрезок движения
        n.rotGoal = n.rotT; n.rotFrom = n.rot; n.rotT0 = t;
        n.rotDur = clamp((Math.abs(n.rotT - n.rot) / 360) * 2.1, 0.7, 2.4);
      }
      const u = clamp((t - n.rotT0) / n.rotDur, 0, 1);
      n.rot = lerp(n.rotFrom, n.rotT, u * u * u * (u * (u * 6 - 15) + 10));
      if (n.h === 0 && u === 1) { n.rot = n.rotT = n.rotGoal = n.rotFrom = 0; }
      const e = ease(n.h);

      // положение в очереди
      const d = wrap(i - S.pos), ad = Math.abs(d), ang = d * STEP;
      const near = smooth(clamp(1 - ad, 0, 1));
      let x = Math.sin(ang) * R;
      let z = (Math.cos(ang) - 1) * R * 0.8;
      let y = baseY + Math.sin(t * 0.9 + i * 1.3) * size * 0.04 * (1 - near * 0.6);
      let sc = 0.8 + 0.42 * near;
      let rz = (Math.sin(i * 2.1) * 10 + Math.sin(t * 0.5 + i) * 3.5) * (1 - near * 0.9);
      // Вещи с кадрами оборота поворачиваются только вперёд от исходной позы и без покачивания по углу.
      let ry = n.turn ? (Math.abs(ang) * 0.3 * 180) / Math.PI
                      : (-ang * 0.3 * 180) / Math.PI + Math.sin(t * 0.4 + i * 0.7) * 5 * (1 - near);
      let op = clamp((3.9 - ad) / 1.2, 0, 1);

      // остальные вещи отступают, когда одна выбрана
      const away = S.g * (1 - e);
      op *= 1 - away;
      z -= away * 520;
      y += away * H * 0.06;

      // подлёт к камере
      if (e > 0) {
        const arc = Math.sin(e * Math.PI);
        x = lerp(x, heroX, e);
        y = lerp(y, heroY + Math.sin(t * 1.1) * 7 * (1 - S.flat * 0.7), e) - arc * H * 0.05;
        z = lerp(z, 60, e) + arc * 300;
        sc = lerp(sc, n.heroK, e);
        rz = lerp(rz, (-6 + Math.sin(t * 0.7) * 1.4) * (1 - S.flat), e);
        ry = lerp(ry, n.turn ? 0 : Math.sin(t * 0.6) * 5, e);
        op = lerp(op, 1, e);
      }
      ry += n.rot;

      if (n.turn) {   // полный набор кадров держим только у вещи в центре и у выбранной
        const tt = n.turn, want = i === S.active || n.h > 0 || (S.active < 0 && ad < 0.6);
        if (want) { tt.drop = false; if (!tt.full && !tt.busy) decodeFull(tt); }
        else if (ad > 1.6) { if (tt.busy) tt.drop = true; else if (tt.full || tt.hi.some(Boolean)) freeFull(tt); }
      }

      const vis = op > 0.01;
      n.el.style.visibility = n.sh.style.visibility = vis ? "visible" : "hidden";
      if (!vis) continue;
      n.el.style.opacity = op;
      n.el.style.zIndex = e > 0 ? 5 : 1;
      n.el.style.pointerEvents = op > 0.5 ? "auto" : "none";
      if (n.turn) {
        const tt = n.turn;
        // Всегда один чёткий кадр — ближайший к углу (смесь соседних даёт двойной контур).
        const kf = mod(Math.round((ry / 360) * tt.n), tt.n);
        const img = frameOf(tt, kf);
        // Нанесение держится на вещи, пока она стоит лицом, и растворяется при повороте.
        const a = mod(ry, 360), front = Math.min(a, 360 - a);
        const lk = C.src ? Math.round(clamp((24 - front) / 10, 0, 1) * 10) / 10 : 0;
        const pk = S.color.id + "|" + (lk ? C.ver + ":" + lk : "");
        if (img && (tt.dirty || img !== tt.shown || pk !== tt.pk)) {
          tt.shown = img; tt.dirty = false; tt.pk = pk;
          paint(n, i, tt, img, lk);
        }
        n.el.style.transform = `translate3d(${x}px,${y}px,${z}px) rotateZ(${rz}deg) scale(${sc})`;
        n.sh.style.visibility = "hidden";   // тень уже есть в кадрах
        continue;
      }
      n.el.style.transform = `translate3d(${x}px,${y}px,${z}px) rotateZ(${rz}deg) rotateY(${ry}deg) scale(${sc})`;

      const flatK = Math.abs(Math.cos((ry * Math.PI) / 180));
      const sy = lerp(baseY + size * 0.78, heroY + (n.hgt * n.heroK) / 2 + 34, e);
      const sw = (n.w * sc * (0.25 + 0.75 * flatK)) / 100;
      n.sh.style.opacity = op * lerp(0.9, 0.55, e);
      n.sh.style.transform = `translate3d(${x}px,${sy}px,${z - 2}px) scale(${sw},${0.26 * sc})`;
    }

    const idx = mod(Math.round(S.pos), N);
    if (idx !== S.shown) showCaption(idx);
  }

  // ---------- подписи ----------
  const capName = $("capName"), capSet = $("capSet");
  function showCaption(idx) {
    S.shown = idx;
    const it = ITEMS[idx];
    capName.textContent = it.name; capSet.textContent = it.set;
    for (const el of [capName, capSet]) { el.classList.remove("swap"); void el.offsetWidth; el.classList.add("swap"); }
    $("count").textContent = `${pad(idx + 1)} / ${pad(N)}`;
    $("railDot").style.left = (idx / (N - 1)) * 100 + "%";
  }

  function fillPanel(i) {
    const it = ITEMS[i];
    $("dNum").textContent = pad(i + 1);
    $("dSet").textContent = it.set;
    $("dTitle").textContent = it.name;
    $("dText").textContent = it.text;
    $("dKit").innerHTML = METHODS.map((k) => `<li>${k}</li>`).join("");
    $("dSpecs").innerHTML = it.specs.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("");
  }

  // ---------- действия ----------
  const hint = $("hint");
  const touched = () => hint.classList.add("off");

  function go(dir) { S.target = Math.round(S.target) + dir; touched(); }

  function showChapter(c) {
    S.chapter = c;
    app.dataset.chapter = c;
    $("more").style.visibility = c === CHAPTERS - 1 ? "hidden" : "visible";
  }
  function setChapter(c) {
    c = clamp(c, 0, CHAPTERS - 1);
    const n = nodes[S.active];
    if (n && c !== S.chapter) n.rotT += (c > S.chapter ? 360 : -360) + CH_ANGLE[c] - CH_ANGLE[S.chapter];
    showChapter(c);
  }

  function release(i) {
    const n = nodes[i];
    n.rotT = Math.round(n.rot / 360) * 360;   // вещь доворачивается лицом и уходит в очередь
  }

  function open(i, ch = 0) {
    i = mod(i, N);
    if (S.active === i) { setChapter(ch); return; }
    if (S.active >= 0) release(S.active);
    S.target = Math.round(S.pos + wrap(i - S.pos));
    S.active = i;
    const n = nodes[i];
    n.rotT = Math.round(n.rot / 360) * 360 + 360 + CH_ANGLE[ch];
    fillPanel(i);
    showChapter(ch);
    app.dataset.mode = "detail";
    touched();
  }

  function close() {
    if (S.active < 0) return;
    release(S.active);
    S.active = -1;
    app.dataset.mode = "browse";
  }

  // ---------- заявка с макетом ----------
  function mockup() {
    const cv = document.createElement("canvas");
    cv.width = cv.height = 900;
    const g = cv.getContext("2d");
    g.fillStyle = S.color.hex; g.fillRect(0, 0, 900, 900);
    const glow = g.createRadialGradient(450, 430, 0, 450, 430, 430);
    glow.addColorStop(0, "rgba(255,255,255,.9)"); glow.addColorStop(1, "rgba(255,255,255,0)");
    g.fillStyle = glow; g.fillRect(0, 0, 900, 900);
    const t = nodes[S.active] && nodes[S.active].turn;
    if (t) {
      const k = Math.min(700 / t.fw, 700 / t.fh);
      g.drawImage(t.canvas, (900 - t.fw * k) / 2, (900 - t.fh * k) / 2, t.fw * k, t.fh * k);
    }
    return cv;
  }
  const order = $("lead");
  let shotBlob = null;
  function openOrder() {
    if (S.active < 0) return;
    const it = ITEMS[S.active], cv = mockup();
    const url = cv.toDataURL("image/png");
    $("leadImg").src = url;
    $("leadSave").href = url;
    cv.toBlob((b) => { shotBlob = b; });
    const how = !C.src ? "без нанесения" : C.mode === "pattern" ? "паттерн" : "логотип";
    $("leadSum").textContent = `${it.name} · ${S.color.name.toLowerCase()} · ${how}`;
    order.hidden = false;
    order.querySelector("input").focus();
  }
  const closeOrder = () => { order.hidden = true; };
  $("leadBtn").addEventListener("click", openOrder);
  $("leadX").addEventListener("click", closeOrder);
  order.addEventListener("pointerdown", (ev) => { if (ev.target === order) closeOrder(); });
  $("leadForm").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const f = new FormData(ev.target), it = ITEMS[S.active];
    const lines = [
      "Здравствуйте! Хочу получить расчёт.",
      `Изделие: ${it.name}`,
      `Цвет: ${S.color.name.toLowerCase()}`,
      `Нанесение: ${!C.src ? "нет" : C.mode === "pattern" ? "паттерн" : "логотип"}`,
      f.get("qty") ? `Тираж: ${f.get("qty")}` : "",
      f.get("company") ? `Компания: ${f.get("company")}` : "",
      `Имя: ${f.get("name")}`,
      `Телефон: ${f.get("phone")}`,
    ].filter(Boolean);
    // Когда появится приём заявок на сервере, достаточно задать window.IZUM_LEAD_ENDPOINT —
    // туда уйдут поля формы и картинка макета. Пока его нет, заявка открывается в WhatsApp.
    if (window.IZUM_LEAD_ENDPOINT) {
      f.append("item", it.name); f.append("color", S.color.name);
      if (shotBlob) f.append("mockup", shotBlob, "izum-maket.png");
      const note = $("leadNote");
      try {
        const r = await fetch(window.IZUM_LEAD_ENDPOINT, { method: "POST", body: f });
        if (!r.ok) throw new Error(r.status);
        note.textContent = "Заявка отправлена. Менеджер свяжется с вами в рабочее время.";
      } catch (e) { note.textContent = "Не получилось отправить заявку. Напишите нам в WhatsApp: +7 (777) 173 74 75."; }
      return;
    }
    window.open(`https://wa.me/${WHATSAPP}?text=${encodeURIComponent(lines.join("\n"))}`, "_blank", "noopener");
  });

  // ---------- ввод ----------
  let wheelLock = 0;
  app.addEventListener("wheel", (ev) => {
    const now = performance.now();
    const horiz = Math.abs(ev.deltaX) > Math.abs(ev.deltaY);
    if (S.active < 0) {                      // в очереди колесо листает страницу; горизонтальная прокрутка — очередь
      if (!horiz) return;
      ev.preventDefault();
      if (Math.abs(ev.deltaX) < 4 || now < wheelLock) return;
      wheelLock = now + 170;
      go(ev.deltaX > 0 ? 1 : -1);
      return;
    }
    ev.preventDefault();
    const delta = horiz ? ev.deltaX : ev.deltaY;
    if (S.chapter === CUSTOM && C.src && pick(ev.clientX, ev.clientY) === S.active) {   // над вещью — размер нанесения
      setScale(C.scale * Math.exp(-delta * 0.0016));
      return;
    }
    if (Math.abs(delta) < 4 || now < wheelLock) return;
    wheelLock = now + 650;
    const c = S.chapter + (delta > 0 ? 1 : -1);
    if (c < 0 || c >= CHAPTERS) close(); else setChapter(c);
  }, { passive: false });

  // Вещь под курсором ищем по её экранному прямоугольнику: боковые стоят глубже плоскости сцены,
  // и обычный hit-test браузера до них не доходит.
  function pick(px, py) {
    let best = -1, bestD = Infinity;
    for (let i = 0; i < N; i++) {
      const el = nodes[i].el;
      if (el.style.visibility === "hidden" || +el.style.opacity < 0.5) continue;
      const r = el.getBoundingClientRect();
      if (px < r.left || px > r.right || py < r.top || py > r.bottom) continue;
      const d = i === S.active ? -1 : Math.abs(wrap(i - S.pos));
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  let drag = null;
  stage.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    const hit = pick(ev.clientX, ev.clientY);
    drag = { x: ev.clientX, y: ev.clientY, start: S.target, moved: false, hit, id: ev.pointerId, logo: null };
    if (S.active >= 0 && S.chapter === CUSTOM && C.src && C.mode === "logo" && hit === S.active) {
      const o = C.off[S.active];
      drag.logo = { x: o.x, y: o.y };
      stage.classList.add("moving");
    }
    stage.setPointerCapture(ev.pointerId);
  });
  stage.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 7) {
      if (!drag.logo && S.active < 0 && Math.abs(dy) > Math.abs(dx) * 1.3 && ev.pointerType !== "mouse") { drag = null; return; }   // вертикальный свайп — прокрутка страницы
      drag.moved = true; touched();
      if (!drag.logo) stage.classList.add("dragging");
    }
    if (!drag.moved) return;
    if (drag.logo) {                         // логотип едет за курсором
      const i = S.active, t = nodes[i].turn, p = ITEMS[i].print;
      const r = t.canvas.getBoundingClientRect();
      const o = C.off[i];
      o.x = clamp(drag.logo.x + dx / r.width, 0.04 - p.x, 0.96 - p.x);
      o.y = clamp(drag.logo.y + dy / r.height, 0.04 - p.y, 0.96 - p.y);
      C.ver++;
    } else if (S.active < 0) S.target = drag.start - dx / (S.R * STEP);
  });
  stage.addEventListener("mousemove", (ev) => {
    if (drag) return;
    const hit = pick(ev.clientX, ev.clientY);
    stage.style.cursor = hit < 0 ? "" : hit === S.active && S.chapter === CUSTOM && C.src && C.mode === "logo" ? "move" : "pointer";
  });
  const endDrag = (ev) => {
    if (!drag) return;
    const d = drag; drag = null;
    stage.classList.remove("dragging", "moving");
    if (d.logo) return;
    if (d.moved) {
      if (S.active >= 0) { const dx = ev.clientX - d.x; if (Math.abs(dx) > 60) open(S.active + (dx < 0 ? 1 : -1), S.chapter); }
      else S.target = Math.round(S.target);
    } else if (d.hit >= 0) {
      if (S.active !== d.hit) open(d.hit);
      else if (S.chapter !== CUSTOM) close();
    }
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  window.addEventListener("keydown", (ev) => {
    const k = ev.key;
    if (!order.hidden) { if (k === "Escape") closeOrder(); return; }
    if (!S.visible || ev.target.closest("input, select, textarea")) return;
    if (S.active >= 0) {
      if (k === "Escape") close();
      else if (k === "ArrowRight") open(S.active + 1, S.chapter);
      else if (k === "ArrowLeft") open(S.active - 1, S.chapter);
      else if (k === "ArrowDown" || k === "PageDown") { ev.preventDefault(); S.chapter === CHAPTERS - 1 ? close() : setChapter(S.chapter + 1); }
      else if (k === "ArrowUp" || k === "PageUp") { ev.preventDefault(); S.chapter === 0 ? close() : setChapter(S.chapter - 1); }
    } else if (window.scrollY < 40) {
      if (k === "ArrowRight") go(1);
      else if (k === "ArrowLeft") go(-1);
      else if (k === "Enter" && !ev.target.closest("a, button")) open(Math.round(S.target));
    }
  });

  $("prev").addEventListener("click", () => go(-1));
  $("next").addEventListener("click", () => go(1));
  $("openBtn").addEventListener("click", () => open(Math.round(S.target), CUSTOM));
  $("tryBtn").addEventListener("click", () => setChapter(CUSTOM));
  $("back").addEventListener("click", close);
  $("more").addEventListener("click", () => setChapter(S.chapter + 1));
  $("dPrev").addEventListener("click", () => open(S.active - 1, S.chapter));
  $("dNext").addEventListener("click", () => open(S.active + 1, S.chapter));
  $("dots").addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (b) setChapter(+b.dataset.ch); });

  // цвет
  document.querySelectorAll("[data-swatches]").forEach((box) => {
    box.innerHTML = COLORS.map((c) => `<button type="button" data-id="${c.id}" style="--c:${c.hex}" title="${c.name}" aria-label="${c.name}"></button>`).join("");
    box.addEventListener("click", (ev) => { const b = ev.target.closest("button"); if (b) { setColor(b.dataset.id); touched(); } });
  });

  // примерка
  const sizeIn = $("size");
  function setScale(v) { C.scale = clamp(v, 0.35, 2.2); sizeIn.value = Math.round(C.scale * 100); C.ver++; }
  sizeIn.addEventListener("input", () => { C.scale = sizeIn.value / 100; C.ver++; });
  $("file").addEventListener("change", (ev) => { useFile(ev.target.files[0]); ev.target.value = ""; });
  $("textLogo").addEventListener("input", (ev) => useText(ev.target.value));
  const seg = (id, key) => $(id).addEventListener("click", (ev) => {
    const b = ev.target.closest("button"); if (!b) return;
    C[key] = b.dataset.v;
    $(id).querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
    logoChanged();
  });
  seg("segMode", "mode"); seg("segTint", "tint");
  $("clearBtn").addEventListener("click", () => { C.src = null; $("textLogo").value = ""; C.off.forEach((o) => { o.x = o.y = 0; }); logoChanged(); });

  // файл можно бросить прямо на первый экран
  let dropDepth = 0;
  app.addEventListener("dragenter", (ev) => { if (ev.dataTransfer && [...ev.dataTransfer.types].includes("Files")) { dropDepth++; app.classList.add("dropping"); } });
  app.addEventListener("dragleave", () => { if (--dropDepth <= 0) { dropDepth = 0; app.classList.remove("dropping"); } });
  app.addEventListener("dragover", (ev) => { if (ev.dataTransfer && [...ev.dataTransfer.types].includes("Files")) ev.preventDefault(); });
  app.addEventListener("drop", (ev) => {
    if (!ev.dataTransfer || !ev.dataTransfer.files.length) return;
    ev.preventDefault(); dropDepth = 0; app.classList.remove("dropping");
    useFile(ev.dataTransfer.files[0]);
  });

  if ("IntersectionObserver" in window) new IntersectionObserver((es) => { S.visible = es[0].isIntersecting; }).observe(app);
  window.addEventListener("resize", layout);

  let saved = null;
  try { saved = localStorage.getItem("izum-color"); } catch (e) { /* нет доступа к хранилищу */ }
  setColor(saved || COLORS[0].id);
  logoChanged();
  layout();
  nextTurn();
  requestAnimationFrame(frame);

  // для проверки из консоли
  window.izumHero = { open, close, go, setChapter, setColor, useText, useImage, state: S, custom: C, nodes };
})();
