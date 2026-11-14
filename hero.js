// Первый экран Izum: очередь вещей → выбранная подлетает к камере, рядом — её описание и характеристики;
// цвет вещи и сцены выбирается. Вырос из presentation/falcon/app.js.
//
// Вещь рисуется шейдером (WebGL2): он перекрашивает жёлтые пиксели в выбранный цвет.
// Примерки логотипа здесь больше нет (убрана 14.11.2026 по решению пользователя): нанесение собирают
// на отдельной странице «Конструктор» (constructor.html). Прежний код примерки — в истории git.
(() => {
  "use strict";

  const ITEMS = window.IZUM_ITEMS, COLORS = window.IZUM_COLORS, METHODS = window.IZUM_METHODS;
  const N = ITEMS.length;
  const STEP = 0.38;               // угол между соседями на дуге, рад
  const THICK = 18;                // «толщина» плоской вырезки, px
  const LAYERS = 5;
  const CH_ANGLE = [8, 20];        // поворот вещи в каждом разделе карточки, градусы (только от исходной позы вперёд)
  const CHAPTERS = CH_ANGLE.length;
  const HI_FRAMES = 14;            // столько первых кадров есть в полном размере (tools/make_turntable.py: HI_KEEP)

  const $ = (id) => document.getElementById(id);
  const app = $("app"), stage = $("stage");
  const pedTop = document.querySelector(".pedestal-top"), pedBottom = document.querySelector(".pedestal-bottom");
  const topBar = document.querySelector(".top"), caption = document.querySelector(".caption"), floor = document.querySelector(".floor");
  const PED_UP = 0.92, PED_DOWN = 0.74;   // верхний и нижний подиум: доли размера вещи вверх и вниз от центра очереди

  const S = {
    pos: 0, target: 0,      // позиция очереди (дробная) и цель
    active: -1,             // индекс вещи в режиме презентации
    chapter: 0,
    g: 0,                   // 0 — очередь, 1 — презентация
    shown: -1,              // индекс, подписанный внизу
    W: 0, H: 0, mobile: false, size: 0, R: 0,
    color: null,            // выбранный цвет {id, name, hex, t:[r,g,b] 0..1, lum}
    visible: true,          // первый экран в зоне видимости
  };

  // Кадры, которые у выбранной вещи берутся в полном размере: лицевые (в карточке вещь поворачивается не дальше 20°).
  const hiFrames = (n) => Array.from({ length: Math.min(HI_FRAMES, n) }, (_, k) => k);

  const mod = (a, n) => ((a % n) + n) % n;
  const wrap = (d) => { d = mod(d, N); return d > N / 2 ? d - N : d; };
  const lerp = (a, b, t) => a + (b - a) * t;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const smooth = (t) => t * t * (3 - 2 * t);
  const pad = (n) => String(n).padStart(2, "0");

  // ---------- шейдер ----------
  const VS = `#version 300 es
in vec2 p; out vec2 v;
void main() { v = vec2(p.x * .5 + .5, .5 - p.y * .5); gl_Position = vec4(p, 0., 1.); }`;
  const FS = `#version 300 es
precision highp float;
uniform sampler2D uF;              // кадр вещи
uniform vec3 uCol;                 // выбранный цвет
uniform float uRec;                // 1 — перекрашивать
uniform float uCut;                // 1 — тёмная сцена: слабый ореол вокруг вещи срезается
in vec2 v; out vec4 o;
void main() {
  vec4 s = texture(uF, v);
  s.rgb = s.a > 0. ? s.rgb / s.a : vec3(0.);   // кадр хранится с предумноженной прозрачностью
  s.a *= smoothstep(.04, .16, s.a);   // слабый шум альфы по краям (сжатие ролика) давал крапинки на цветном фоне
  // светлый полупрозрачный ореол (отсвет вещи на белом фоне съёмки) на цветной заливке читается грязью — убираем;
  // тёмные полупрозрачные пиксели — это тень под вещью, они остаются
  s.a *= mix(1., smoothstep(.45, .92, s.a), smoothstep(.5, .75, dot(s.rgb, vec3(.3, .59, .11))));
  // Вокруг вещи в кадрах остаётся блочный след сжатия ролика (прозрачность 10–30 %). На светлом фоне это мягкая тень,
  // на тёмной сцене — светящиеся квадраты, поэтому там всё слабее полупрозрачного края убираем.
  s.a *= mix(1., smoothstep(.24, .62, s.a), uCut);
  if (s.a < .004) { o = vec4(0.); return; }
  vec3 c = s.rgb * 255.;
  // Вещи сняты в чёрном с жёлтым. Пиксель раскладывается на «белую» часть (канал B) и «жёлтую»
  // (max(R,G) − B); жёлтая заменяется выбранным цветом.
  float y = (c.r + c.g) * .5 - c.b;
  float m = clamp((y - 12.) / 28., 0., 1.);
  vec3 rec = vec3(c.b) + (max(c.r, c.g) - c.b) * uCol;
  vec3 base = mix(c, rec, m * uRec) / 255.;
  o = vec4(base * s.a, s.a);
}`;

  function makeGL(canvas) {
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: true, antialias: false });
    if (!gl) return null;
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const u = {};
    for (const name of ["uF", "uCol", "uRec", "uCut"]) u[name] = gl.getUniformLocation(prog, name);
    const tex = (unit, wrapMode, mips) => {
      const t = gl.createTexture();
      gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapMode); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrapMode);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, mips ? gl.LINEAR_MIPMAP_LINEAR : gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
      return t;
    };
    const texF = tex(0, gl.CLAMP_TO_EDGE, true);
    gl.uniform1i(u.uF, 0);
    return { gl, u, texF };
  }
  function tryGL(canvas) {
    try { const G = makeGL(canvas); if (G) return G; glErrors.push("нет контекста"); }
    catch (e) { glErrors.push(String(e && e.message)); }
    return null;
  }
  // Контекст может пропасть (драйвер, нехватка видеопамяти, сон ноутбука) или не создаться с первого раза.
  // Тогда вещь рисуется как есть, без перекраски, — поэтому пробуем поднять WebGL заново.
  function watchGL(t, canvas) {
    canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); t.dirty = true; });
    if (!t.G && t.glTries < GL_TRIES) setTimeout(() => { t.dirty = true; }, GL_RETRY + 50);
  }
  function resetCanvas(t) {
    const old = t.canvas, c = document.createElement("canvas");
    c.className = old.className; c.width = old.width; c.height = old.height; c.style.cssText = old.style.cssText;
    t.glAt = performance.now(); t.glTries++;
    t.G = tryGL(c); t.ctx = t.G ? null : c.getContext("2d");
    t.canvas = c; t.texImg = null; t.dirty = true;
    old.replaceWith(c);
    watchGL(t, c);
  }
  function upload(G, unit, texture, source, premultiply) {
    const gl = G.gl;
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, premultiply);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    gl.generateMipmap(gl.TEXTURE_2D);
  }

  // ---------- сборка сцены ----------
  const turnQueue = [];   // вещи, чьи кадры оборота ещё не загружены
  let turnBusy = false;
  const GL_TRIES = 12, GL_RETRY = 1500;
  const glErrors = [];    // почему не поднялся WebGL (для диагностики: izumHero.glErrors)
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
    const node = { el, sh, h: 0, rot: 0, rotT: 0, rotGoal: 0, rotFrom: 0, rotT0: 0, rotDur: 1, w: 0, hgt: 0, heroK: 1, turn: null };
    return node;
  });

  // Кадры оборота: номер кадра задаётся углом поворота, поэтому вещь реально вращается.
  // Три набора: sm — кадры около исходной позы в четверть размера (хватает для очереди);
  // md — весь оборот в половинном размере (у вещи в центре и у выбранной);
  // hi — первые кадры в полном размере (выбранная вещь, когда она стоит у камеры).
  const frameUrl = (turn, tier, k) => `${turn.dir}/${tier}/${String(k).padStart(3, "0")}.webp`;
  // Кадры держим с предумноженной прозрачностью: иначе при уменьшении и сглаживании цвет прозрачных
  // пикселей затекает в контур вещи (тёмная рваная кайма, серый ореол). Шейдер делит цвет на альфу обратно.
  const bitmap = (blob, opts) => createImageBitmap(blob, { premultiplyAlpha: "premultiply", ...opts });
  // Холст вещи поднимается сразу — из картинки, которая уже стоит на странице. Перекраска работает
  // с первой секунды и не ждёт кадров оборота: по плохой сети те могут идти минутами.
  function startTurn(node) {
    const turn = ITEMS[nodes.indexOf(node)].turn, img = node.el.querySelector("img");
    if (!turn) return;
    const lw = Math.max(1, Math.floor(turn.fw / 2)), lh = Math.max(1, Math.floor(turn.fh / 2));
    img.decode().then(() => bitmap(img, { resizeWidth: Math.max(1, Math.round(lw / 2)), resizeQuality: "high" })).then((first) => {
      const canvas = document.createElement("canvas");
      canvas.className = "turn";
      canvas.width = lw; canvas.height = lh;
      const G = tryGL(canvas);
      const t = { ...turn, canvas, G, ctx: G ? null : canvas.getContext("2d"), glAt: performance.now(), glTries: 0, lw, lh, blobs: new Array(turn.n), sm: new Array(turn.n), md: new Array(turn.n), hi: new Array(turn.n),
                  complete: false, full: false, busy: false, drop: false, hiState: 0, dirty: true, shown: null, pk: "" };
      t.sm[0] = first;
      watchGL(t, canvas);
      node.turn = t;
      node.el.append(canvas);
      node.el.classList.add("turning");
      layout();
      turnQueue.push({ node, turn, phase: 1 });
      nextTurn();
    }, () => {                                   // картинка не дошла — запрашиваем заново
      setTimeout(() => {
        for (const im of node.el.querySelectorAll("img")) im.src = im.src.split("?")[0] + "?r=" + Date.now();
        startTurn(node);
      }, 3000);
    });
  }
  function nextTurn() {
    if (turnBusy || !turnQueue.length) return;
    turnQueue.sort((p, q) => p.phase - q.phase || dist(p.node) - dist(q.node));
    const job = turnQueue.shift(), { node, turn } = job;
    turnBusy = true;
    let work;
    const t = node.turn, ks = [];
    if (job.phase === 1) {                       // кадры около исходной позы — в четверть размера, показываем по мере прихода
      for (const k of restFrames(t.n)) if (!t.blobs[k]) ks.push(k);
      const half = Math.max(1, Math.round(t.lw / 2));
      work = fetchAll(ks.map((k) => frameUrl(turn, "lo", k)), (j, blob) => {
        const k = ks[j];
        t.blobs[k] = blob;
        bitmap(blob, { resizeWidth: half, resizeQuality: "high" }).then((bm) => { if (t.sm[k]) t.sm[k].close(); t.sm[k] = bm; t.dirty = true; }, () => {});
      }).then(() => { turnQueue.push({ node, turn, phase: 2 }); });
    } else {                                     // остальной оборот
      for (let k = 0; k < t.n; k++) if (!t.blobs[k]) ks.push(k);
      work = fetchAll(ks.map((k) => frameUrl(turn, "lo", k)), (j, blob) => { t.blobs[ks[j]] = blob; }).then(() => { t.complete = true; });
    }
    // сеть срывается — пробуем снова, пока не получится (с паузой, чтобы не молотить впустую)
    work.catch(() => { job.tries = (job.tries || 0) + 1; setTimeout(() => { turnQueue.push(job); nextTurn(); }, Math.min(8000, 1200 * job.tries)); })
        .finally(() => { turnBusy = false; nextTurn(); });
  }

  // Не больше 8 запросов сразу и до 4 попыток на файл — по сети отдельные запросы срываются.
  // each(j, blob) вызывается сразу, как пришёл файл: при срыве остальных уже полученное не пропадает.
  async function fetchAll(urls, each) {
    const out = new Array(urls.length);
    let next = 0;
    const one = async (u) => {
      for (let attempt = 0; ; attempt++) {
        const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 12000);   // зависший запрос не должен держать очередь
        try { const r = await fetch(u, { signal: ac.signal }); if (r.ok) return await r.blob(); throw new Error(r.status); }
        catch (err) { if (attempt >= 3) throw err; await new Promise((res) => setTimeout(res, 400 * (attempt + 1))); }
        finally { clearTimeout(timer); }
      }
    };
    const worker = async () => { while (next < urls.length) { const k = next++; out[k] = await one(urls[k]); if (each) each(k, out[k]); } };
    await Promise.all(Array.from({ length: 8 }, worker));
    return out;
  }

  const REST = 20;
  const restFrames = (n) => { const ks = []; for (let j = -2; j <= REST; j++) ks.push(mod(j, n)); return ks; };
  async function decodeFull(t) {      // весь оборот в половинном размере — заранее, чтобы вращение не запиналось
    if (t.full || t.busy || !t.complete) return;
    t.busy = true;
    for (let s = 0; s < t.n && !t.drop; s += 12) {
      const ks = [];
      for (let k = s; k < Math.min(t.n, s + 12); k++) if (!t.md[k]) ks.push(k);
      await Promise.all(ks.map(async (k) => { t.md[k] = await bitmap(t.blobs[k]); }));
      t.dirty = true;
    }
    t.busy = false;
    if (t.drop) freeFull(t); else t.full = true;
  }
  function freeFull(t) {
    for (const b of t.md) if (b) b.close();
    t.md = new Array(t.n); t.full = false; t.drop = false; t.dirty = true;
  }
  async function loadHi(t) {          // кадры полного размера — только у выбранной вещи
    if (t.hiState) return;
    t.hiState = 1;
    try {
      const ks = hiFrames(t.n);
      const got = await fetchAll(ks.map((k) => frameUrl(t, "hi", k)));
      await Promise.all(ks.map(async (k, j) => { t.hi[k] = await bitmap(got[j]); }));
      if (t.hiState === 1) { t.hiState = 2; t.dirty = true; } else freeHi(t);
    } catch (e) { t.hiState = 0; }
  }
  function freeHi(t) {
    for (const b of t.hi) if (b) b.close();
    t.hi = new Array(t.n); t.hiState = 0; t.dirty = true;
  }
  function frameOf(t, k, sharp) {        // t.at — номер кадра, который реально отдан
    t.at = k;
    if (sharp && t.hi[k]) return t.hi[k];
    if (t.md[k]) return t.md[k];
    if (t.sm[k]) return t.sm[k];
    for (let j = 1; j < t.n; j++) {         // нужный кадр ещё не загружен — берём ближайший готовый
      const a = mod(k - j, t.n), b = mod(k + j, t.n);
      if (t.md[a] || t.sm[a]) { t.at = a; return t.md[a] || t.sm[a]; }
      if (t.md[b] || t.sm[b]) { t.at = b; return t.md[b] || t.sm[b]; }
    }
    return null;
  }

  const dist = (node) => { const i = nodes.indexOf(node); return i === S.active ? -1 : Math.abs(wrap(i - S.pos)); };

  // ---------- цвет ----------
  const hexRgb = (hex) => [1, 3, 5].map((p) => parseInt(hex.slice(p, p + 2), 16));
  const mixHex = (rgb, k) => "#" + rgb.map((v) => Math.round(v + (255 - v) * k).toString(16).padStart(2, "0")).join("");
  function setColor(id) {
    const c = COLORS.find((x) => x.id === id) || COLORS[0];
    const rgb = hexRgb(c.hex);
    const lum = (0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]) / 255;
    S.color = { ...c, t: rgb.map((v) => v / 255), lum };
    // Текст поверх акцента — тот из двух (чёрный или белый), у которого выше контраст по WCAG. Прежний порог
    // яркости давал белый текст на оранжевом, розовом и зелёном с контрастом 2,9–3,4 при норме 4,5.
    const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const rl = 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
    const darkOn = (rl + 0.05) / 0.0537 > 1.05 / (rl + 0.05);     // 0.0537 — яркость #0d0d0d + 0.05
    const pale = 1.05 / (rl + 0.05) < 1.25;                       // почти белый акцент не виден на светлой странице
    const st = document.documentElement.style;
    st.setProperty("--accent", c.hex);
    st.setProperty("--accent-hi", mixHex(rgb, 0.3));
    st.setProperty("--on", darkOn ? "#0d0d0d" : "#ffffff");
    st.setProperty("--accent-edge", pale ? "#0d0d0d" : "transparent");      // контур акцентных карточек
    st.setProperty("--plate", pale ? "#0d0d0d" : c.hex);                    // плашка под словом в заголовках
    st.setProperty("--on-plate", pale ? "#ffffff" : darkOn ? "#0d0d0d" : "#ffffff");
    st.setProperty("--accent-ink", lum < 0.3 ? mixHex(rgb, 0.38) : c.hex);
    // сцена презентации: тёмный тон цвета вещи — на нём вещь читается, а не сливается с заливкой
    const tone = (k, add) => "#" + rgb.map((v) => Math.round(v * k + add).toString(16).padStart(2, "0")).join("");
    const soft = rgb.map((v) => Math.round(v + (255 - v) * 0.35)).join(", ");
    st.setProperty("--stage", tone(0.2, 9));
    st.setProperty("--stage-hi", tone(0.27, 14));
    st.setProperty("--lit", lum < 0.45 ? mixHex(rgb, 0.45) : c.hex);
    st.setProperty("--glow", `rgba(${soft}, .42)`);
    st.setProperty("--glow-2", `rgba(${soft}, .16)`);
    st.setProperty("--glow-d", `rgba(${soft}, .78)`);
    st.setProperty("--glow-d2", `rgba(${soft}, .36)`);
    app.dataset.on = darkOn ? "dark" : "light";
    document.querySelectorAll("[data-swatches] button").forEach((b) => b.classList.toggle("on", b.dataset.id === c.id));
    try { localStorage.setItem("izum-color", c.id); } catch (e) { /* хранилище недоступно — не страшно */ }
  }

  // ---------- кадр вещи ----------
  // Один кадр вещи: шейдер перекрашивает жёлтые пиксели в выбранный цвет.
  function paint(t, img) {
    if (t.G && t.G.gl.isContextLost()) { t.G = null; t.ctx = null; t.glTries = Math.min(t.glTries, GL_TRIES - 3); }
    if (!t.G && (!t.ctx || (t.glTries < GL_TRIES && performance.now() - t.glAt > GL_RETRY))) resetCanvas(t);
    if (!t.G) {                                  // нет WebGL2 — показываем вещь как есть, без перекраски
      t.ctx.clearRect(0, 0, t.canvas.width, t.canvas.height);
      t.ctx.drawImage(img, 0, 0, t.canvas.width, t.canvas.height);
      return;
    }
    const { gl, u } = t.G;
    if (t.texImg !== img) { t.texImg = img; upload(t.G, 0, t.G.texF, img, false); }
    gl.viewport(0, 0, t.canvas.width, t.canvas.height);
    gl.uniform3fv(u.uCol, S.color.t);
    gl.uniform1f(u.uRec, S.color.id === "yellow" ? 0 : 1);
    gl.uniform1f(u.uCut, t.cut || 0);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // ---------- геометрия ----------
  function layout() {
    S.W = app.clientWidth; S.H = app.clientHeight;
    S.mobile = S.W <= 820;
    S.size = S.mobile ? Math.min(S.W * 0.44, S.H * 0.28) : Math.min(S.H * 0.3, S.W * 0.2);
    // Сцена очереди (от верхнего подиума до нижнего) должна поместиться между шапкой и подписью. Раньше она
    // считалась только долями высоты окна: на невысоком окне ноутбука нижний подиум ложился на подпись,
    // на невысоком телефоне верхний заходил в меню. Если места хватает, размер и центр остаются прежними.
    const box = app.getBoundingClientRect();
    const head = topBar.getBoundingClientRect().bottom - box.top, cap = caption.getBoundingClientRect().top - box.top;
    const pedH = Math.min(S.W, S.H) * 0.046, padTop = 8, padBottom = 12;
    const room = cap - head - pedH - padTop - padBottom;
    if (room > 60) S.size = Math.min(S.size, room / (PED_UP + PED_DOWN));
    S.cy = S.H * 0.44;
    const lo = head + padTop + S.size * PED_UP, hi = cap - padBottom - pedH - S.size * PED_DOWN;
    if (room > 60 && lo <= hi) S.cy = clamp(S.cy, lo, hi);
    S.R = S.size / STEP * (S.mobile ? 1.15 : 1.02);
    const boxW = S.mobile ? S.W * 0.66 : S.W * 0.4;
    const boxH = S.mobile ? S.H * 0.23 : S.H * 0.62;
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
    pedTop.style.top = S.cy - S.size * PED_UP + "px";
    pedBottom.style.top = S.cy + S.size * PED_DOWN + "px";
    // линия пола держится под нижним подиумом; при обычной раскладке это прежние 28 % высоты
    const moved = Math.abs(S.cy - S.H * 0.44) > 1 || S.size < (S.mobile ? Math.min(S.W * 0.44, S.H * 0.28) : Math.min(S.H * 0.3, S.W * 0.2)) - 1;
    floor.style.height = moved ? Math.max(0, S.H - (S.cy + S.size * PED_DOWN + pedH + S.H * 0.012)) + "px" : "";
    stage.style.perspectiveOrigin = moved ? `50% ${(S.cy / S.H) * 100}%` : "";
  }

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

    const heroX = S.mobile ? 0 : W * 0.19;
    const heroY = S.mobile ? -H * 0.285 : H * 0.03;
    const baseY = S.cy - H / 2;      // центр очереди: 44 % высоты, если layout() не сдвинул его под шапку и подпись

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
        y = lerp(y, heroY + Math.sin(t * 1.1) * 7, e) - arc * H * 0.05;
        z = lerp(z, 60, e) + arc * 300;
        sc = lerp(sc, n.heroK, e);
        rz = lerp(rz, -6 + Math.sin(t * 0.7) * 1.4, e);
        ry = lerp(ry, n.turn ? 0 : Math.sin(t * 0.6) * 5, e);
        op = lerp(op, 1, e);
      }
      ry += n.rot;

      if (n.turn) {   // весь оборот держим только у вещи в центре и у выбранной; полный размер — только у выбранной
        const tt = n.turn, mine = i === S.active || n.h > 0, want = mine || (S.active < 0 && ad < 0.6);
        if (want) { tt.drop = false; if (!tt.full && !tt.busy) decodeFull(tt); }
        else if (ad > 1.6) { if (tt.busy) tt.drop = true; else if (tt.full || tt.md.some(Boolean)) freeFull(tt); }
        if (i === S.active) loadHi(tt);
        else if (!mine && tt.hiState) { if (tt.hiState === 2) freeHi(tt); else tt.hiState = 3; }
        const cw = mine ? tt.fw : tt.lw, chh = mine ? tt.fh : tt.lh;      // у камеры холст в полном размере
        if (tt.canvas.width !== cw) { tt.canvas.width = cw; tt.canvas.height = chh; tt.dirty = true; }
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
        const want = mod(Math.round((ry / 360) * tt.n), tt.n);
        const img = frameOf(tt, want, true), kf = tt.at;
        // Пока нужного кадра нет (медленная сеть), показываем ближайший загруженный и доворачиваем его
        // в объёме на недостающий угол — вещь вращается с первой секунды, а не стоит плоской картинкой.
        let lack = ry - (kf / tt.n) * 360; lack = mod(lack + 180, 360) - 180;
        if (kf === want) lack = 0;
        tt.cut = Math.round(smooth(clamp(e * 1.6, 0, 1)) * 12) / 12;   // вещь летит на тёмную сцену — ореол уходит
        const pk = S.color.id + "|" + tt.cut;
        if (img && (tt.dirty || img !== tt.shown || pk !== tt.pk)) {
          tt.shown = img; tt.dirty = false; tt.pk = pk;
          paint(tt, img);
        }
        n.el.style.transform = `translate3d(${x}px,${y}px,${z}px) rotateZ(${rz}deg)${lack ? ` rotateY(${lack}deg)` : ""} scale(${sc})`;
      } else n.el.style.transform = `translate3d(${x}px,${y}px,${z}px) rotateZ(${rz}deg) rotateY(${ry}deg) scale(${sc})`;

      // тень под вещью: кадры вырезаны по контуру, без тени съёмки
      const flatK = n.turn ? 0.9 : Math.abs(Math.cos((ry * Math.PI) / 180));
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
    i = mod(i, N); ch = clamp(ch, 0, CHAPTERS - 1);
    if (S.active === i) { setChapter(ch); return; }
    if (S.active >= 0) release(S.active);
    S.target = Math.round(S.pos + wrap(i - S.pos));
    S.active = i;
    app.dataset.body = ITEMS[i].print && ITEMS[i].print.surf === "dark" ? "dark" : "light";   // чёрной вещи нужна подсветка сильнее
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
    // панель выше окна прокручивается сама — колесо над ней не листает главы
    const pan = !horiz && ev.target.closest(".panel");
    if (pan && pan.scrollHeight > pan.clientHeight + 1) return;
    ev.preventDefault();
    const delta = horiz ? ev.deltaX : ev.deltaY;
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
    drag = { x: ev.clientX, y: ev.clientY, start: S.target, moved: false, hit, id: ev.pointerId };
    stage.setPointerCapture(ev.pointerId);
  });
  stage.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    const dx = ev.clientX - drag.x, dy = ev.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 7) {
      if (S.active < 0 && Math.abs(dy) > Math.abs(dx) * 1.3 && ev.pointerType !== "mouse") { drag = null; return; }   // вертикальный свайп — прокрутка страницы
      drag.moved = true; touched();
      stage.classList.add("dragging");
    }
    if (!drag.moved) return;
    if (S.active < 0) S.target = drag.start - dx / (S.R * STEP);
  });
  stage.addEventListener("mousemove", (ev) => {
    if (drag) return;
    const hit = pick(ev.clientX, ev.clientY);
    stage.style.cursor = hit < 0 ? "" : "pointer";
  });
  const endDrag = (ev) => {
    if (!drag) return;
    const d = drag; drag = null;
    stage.classList.remove("dragging");
    if (d.moved) {
      if (S.active >= 0) { const dx = ev.clientX - d.x; if (Math.abs(dx) > 60) open(S.active + (dx < 0 ? 1 : -1), S.chapter); }
      else S.target = Math.round(S.target);
    } else if (d.hit >= 0) {
      if (S.active !== d.hit) open(d.hit);
      else close();
    }
  };
  stage.addEventListener("pointerup", endDrag);
  stage.addEventListener("pointercancel", endDrag);

  window.addEventListener("keydown", (ev) => {
    const k = ev.key;
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
  $("openBtn").addEventListener("click", () => open(Math.round(S.target)));
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

  if ("IntersectionObserver" in window) new IntersectionObserver((es) => { S.visible = es[0].isIntersecting; }).observe(app);

  // Автопрокрутка: пока слайдером не пользуются, вещи сменяются сами. Любое действие (мышь, касание,
  // колесо, клавиша) откладывает её на AUTO_WAIT; в открытой карточке вещи и на скрытой вкладке она стоит.
  const AUTO_WAIT = 6000, AUTO_STEP = 3400;
  let autoAt = performance.now() + AUTO_WAIT;
  const still = () => { autoAt = performance.now() + AUTO_WAIT; };
  ["pointerdown", "pointermove", "wheel", "keydown", "touchstart"].forEach((e) => window.addEventListener(e, still, { passive: true, capture: true }));
  const calm = window.matchMedia && matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (!calm) setInterval(() => {
    const now = performance.now();
    if (S.active >= 0 || !S.visible || document.hidden || now < autoAt) return;
    S.target = Math.round(S.target) + 1; autoAt = now + AUTO_STEP;
  }, 300);
  window.addEventListener("resize", layout);
  if ("ResizeObserver" in window) {   // шапка или подпись изменили высоту (догрузился шрифт, перестроилось меню) — сцена вписывается заново
    const ro = new ResizeObserver(() => layout());
    ro.observe(topBar); ro.observe(caption);
  }

  let saved = null;
  try { saved = localStorage.getItem("izum-color"); } catch (e) { /* нет доступа к хранилищу */ }
  setColor(saved || COLORS[0].id);
  layout();
  nodes.forEach(startTurn);
  requestAnimationFrame(frame);

  // Для проверки из консоли.
  window.izumHero = { open, close, go, setChapter, setColor, state: S, nodes, glErrors };
})();
