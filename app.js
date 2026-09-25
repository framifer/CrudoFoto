/* CrudoFoto PWA - logica principale.
 * - Accede alla fotocamera (getUserMedia)
 * - Disegna i frame con WebGL applicando l'effetto pellicola selezionato
 * - Simula la focale con un crop centrale (zoom)
 * - Scatta foto (download PNG) con un suono di click sintetico
 *
 * NB: la registrazione video usa MediaRecorder sul canvas quando disponibile.
 */

// ---------- Registrazione del service worker (offline) ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  });
}

// ---------- Definizione effetti (fragment shader GLSL ES 2.0) ----------
const VERT = `
  attribute vec2 aPos;
  attribute vec2 aTex;
  uniform float uZoom;
  varying vec2 vTex;
  void main() {
    vec2 tc = aTex;
    tc = (tc - 0.5) / uZoom + 0.5;   // crop centrale = focale
    vTex = tc;
    gl_Position = vec4(aPos, 0.0, 1.0);
  }
`;

const HEAD = `
  precision mediump float;
  uniform sampler2D uTex;
  uniform float uTime;
  uniform float uIntensity;
  varying vec2 vTex;
  float luma(vec3 c){ return dot(c, vec3(0.299,0.587,0.114)); }
  float rand(vec2 co){ return fract(sin(dot(co, vec2(12.9898,78.233)))*43758.5453); }
`;

// Ogni effetto restituisce "col"; alla fine si miscela con l'originale.
// Ordine: Nativa, effetti pellicola/fotocamera, Point/Shoot, poi i creativi.
const EFFECTS = [
  { name: 'Nativa', body: `vec3 col = texture2D(uTex, vTex).rgb;` },
  { name: 'Kodachrome', body: `
      vec3 col = texture2D(uTex,vTex).rgb; float lum=luma(col);
      vec3 tint = mix(vec3(0.85,0.98,1.02), vec3(1.04,1.0,0.92), smoothstep(0.2,0.8,lum));
      col*=tint; col = mix(col, mix(vec3(lum), vec3(0.72,0.70,0.66),0.5), 0.28);
      col=(col-0.5)*1.08+0.5; col+=0.03;
      float bd = clamp((col.b-max(col.r,col.g))*2.0,0.0,1.0);
      col = mix(col, vec3(0.62,0.78,0.86), bd*0.25);
      col += (rand(vTex*1024.0+uTime)-0.5)*0.06;
  `},
  { name: 'Portra', body: `
      vec3 col = texture2D(uTex,vTex).rgb; float lum=luma(col);
      col = pow(col, vec3(0.92)); col = mix(col, vec3(lum), 0.12);
      col.r*=1.06; col.g*=1.02; col.b*=0.98;
      col += vec3(0.03,0.02,0.0)*smoothstep(0.5,1.0,lum);
      col=(col-0.5)*0.95+0.5; col += (rand(vTex*1400.0+uTime)-0.5)*0.035;
  `},
  { name: 'Gold 200', body: `
      vec3 col = texture2D(uTex,vTex).rgb; float lum=luma(col);
      col.r*=1.10; col.g*=1.05; col.b*=0.85;
      col += vec3(0.05,0.035,0.0)*(1.0-lum);
      col=(col-0.5)*1.12+0.5; col=mix(vec3(lum),col,1.15);
      col += (rand(vTex*900.0+uTime)-0.5)*0.06;
  `},
  { name: 'Velvia', body: `
      vec3 col = texture2D(uTex,vTex).rgb; float lum=luma(col);
      col = mix(vec3(lum), col, 1.6);
      col=(col-0.5)*1.28+0.5; col=pow(clamp(col,0.0,1.0), vec3(1.08));
      col.g*=1.08; col.b*=1.10; col += (rand(vTex*1500.0+uTime)-0.5)*0.03;
  `},
  { name: 'CineStill', body: `
      vec2 px = vec2(1.0/720.0,1.0/1280.0);
      vec3 col = texture2D(uTex,vTex).rgb; float lum=luma(col);
      col.r*=0.95; col.b*=1.12; col += vec3(-0.01,0.0,0.03)*(1.0-lum);
      float halo=0.0;
      for(int i=-4;i<=4;i++) for(int j=-4;j<=4;j++){
        float l=luma(texture2D(uTex, vTex+vec2(float(i),float(j))*px*2.0).rgb);
        halo += smoothstep(0.75,1.0,l);
      }
      halo/=81.0; col += vec3(0.9,0.25,0.1)*halo*0.9;
      col=(col-0.5)*1.05+0.5; col += (rand(vTex*800.0+uTime)-0.5)*0.055;
  `},
  { name: 'Superia', body: `
      vec3 col = texture2D(uTex,vTex).rgb; float lum=luma(col);
      col.r*=0.96; col.g*=1.04; col.b*=1.08;
      col += vec3(-0.01,0.02,0.02)*(1.0-lum);
      col=(col-0.5)*1.14+0.5; col=mix(vec3(lum),col,1.18);
      col += (rand(vTex*1450.0+uTime)-0.5)*0.035;
  `},
  { name: 'Lomography', body: `
      vec3 col = texture2D(uTex,vTex).rgb; float lum=luma(col);
      col = mix(vec3(lum), col, 1.5); col.r*=1.08; col.g*=1.02; col.b*=0.96;
      col=(col-0.5)*1.35+0.5; col=pow(clamp(col,0.0,1.0), vec3(0.95));
      float d=distance(vTex, vec2(0.5)); col *= 1.0-d*d*0.9;
      col += (rand(vTex*700.0+uTime)-0.5)*0.09;
  `},
  { name: 'Ozarks', body: `
      vec3 col = texture2D(uTex,vTex).rgb; float lum=luma(col);
      col = mix(vec3(lum), col, 0.55);
      col.r*=0.86; col.g*=1.02; col.b*=1.06;
      col += vec3(-0.02,0.02,0.03)*(1.0-lum);
      col *= 0.92; col = pow(clamp(col,0.0,1.0), vec3(1.12));
      col=(col-0.5)*1.06+0.5; col += (rand(vTex*1300.0+uTime)-0.5)*0.03;
  `},
  { name: 'Japan', body: `
      vec3 col = texture2D(uTex,vTex).rgb; float lum=luma(col);
      col = mix(vec3(lum), col, 0.6);
      col.r*=0.97; col.g*=1.01; col.b*=1.05;
      col = col*0.94 + 0.06;
      float hi=smoothstep(0.55,1.0,lum); col = mix(col, vec3(0.95,0.96,0.97), hi*0.18);
      col=(col-0.5)*0.85+0.5; col += vec3(-0.005,0.0,0.02);
      col += (rand(vTex*1600.0+uTime)-0.5)*0.02;
  `},
  { name: 'CanonPS', body: `
      vec2 px = vec2(1.0/720.0,1.0/1280.0);
      vec3 s = texture2D(uTex,vTex).rgb*0.5;
      s += texture2D(uTex,vTex+vec2(px.x,0.0)).rgb*0.125;
      s += texture2D(uTex,vTex-vec2(px.x,0.0)).rgb*0.125;
      s += texture2D(uTex,vTex+vec2(0.0,px.y)).rgb*0.125;
      s += texture2D(uTex,vTex-vec2(0.0,px.y)).rgb*0.125;
      vec3 col=s; float lum=luma(col);
      col.r*=1.08; col.g*=1.03; col.b*=0.97; col=mix(vec3(lum),col,1.25);
      col=(col-0.5)*1.20+0.5; col += (rand(vTex*1100.0+uTime)-0.5)*0.03;
  `},
  { name: 'Iphone', body: `
      vec2 px = vec2(1.0/720.0,1.0/1280.0);
      vec3 b=vec3(0.0);
      for(int i=-1;i<=1;i++) for(int j=-1;j<=1;j++)
        b += texture2D(uTex, vTex+vec2(float(i),float(j))*px*2.5).rgb;
      b/=9.0; vec3 col=b; float lum=luma(col);
      col.r*=1.07; col.g*=1.01; col.b*=0.92;
      float hi=smoothstep(0.6,0.95,lum); col=mix(col, vec3(1.0), hi*0.35);
      col=(col-0.5)*0.92+0.5; col += vec3(0.05,0.045,0.04)*(1.0-lum);
      col += (rand(vTex*600.0+uTime)-0.5)*0.10;
  `},
  { name: 'Point/Shoot', body: `
      vec3 col = texture2D(uTex,vTex).rgb; float lum=luma(col);
      col.r*=1.10; col.g*=1.02; col.b*=0.90;
      col += vec3(0.04,0.02,0.0)*(1.0-lum);
      col=(col-0.5)*1.12+0.5; col=mix(vec3(lum),col,1.15);
      float leak = smoothstep(0.75,0.0, distance(vTex, vec2(0.95,0.05)));
      float pulse = 0.75 + 0.25*sin(uTime*0.9);
      col += vec3(1.0,0.45,0.2)*leak*0.55*pulse;
      float d=distance(vTex, vec2(0.5)); col *= 1.0-d*d*0.7;
      col += (rand(vTex*650.0+uTime)-0.5)*0.08;
      if(vTex.x>0.72 && vTex.x<0.96 && vTex.y>0.90 && vTex.y<0.955){
        float seg = step(0.5, fract(vTex.x*45.0));
        col = mix(col, vec3(1.0,0.55,0.15), 0.6*seg);
      }
  `},
  { name: 'Dream', body: `
      vec2 px = vec2(1.0/480.0,1.0/800.0);
      vec3 b = vec3(0.0);
      for(int x=-1;x<=1;x++) for(int y=-1;y<=1;y++)
        b += texture2D(uTex, vTex+vec2(float(x),float(y))*px*2.0).rgb;
      b/=9.0;
      vec3 col = mix(b, vec3(1.0), 0.25);
      float g = 0.05*sin(uTime*0.8); col += vec3(g,g*0.5,-g);
  `},
  { name: 'Glitch', body: `
      vec2 uv = vTex;
      float band = floor(uv.y*20.0);
      float jump = (rand(vec2(band, floor(uTime*12.0)))-0.5);
      float active = step(0.7, rand(vec2(band*1.7, floor(uTime*6.0))));
      uv.x += jump*0.1*active*uIntensity;
      float sh = 0.006*uIntensity;
      vec3 col = vec3(texture2D(uTex,uv+vec2(sh,0.0)).r, texture2D(uTex,uv).g, texture2D(uTex,uv-vec2(sh,0.0)).b);
      col *= 0.85+0.15*sin(uv.y*800.0);
      col *= vec3(1.1,0.9,1.2);
  `},
  { name: 'Liquid Neon', body: `
      vec2 px = vec2(1.0/720.0, 1.0/1280.0);
      float l = luma(texture2D(uTex,vTex).rgb);
      float lx = luma(texture2D(uTex,vTex+vec2(px.x,0.0)).rgb);
      float ly = luma(texture2D(uTex,vTex+vec2(0.0,px.y)).rgb);
      float edge = clamp((abs(l-lx)+abs(l-ly))*8.0,0.0,1.0);
      float wave = vTex.x*6.0 + vTex.y*3.0 + uTime*1.5;
      vec3 neon = 0.5+0.5*cos(wave+vec3(0.0,2.094,4.188));
      vec3 col = texture2D(uTex,vTex).rgb*0.15 + neon*edge*1.5;
  `},
];

// Guida agli effetti (bilingue) per il pulsante "i".
const EFFECT_INFO = [
  ['Nativa', "La resa pulita del sensore del telefono, senza filtro. Il punto di partenza neutro.",
             "The phone sensor's clean, unfiltered rendering. The neutral starting point."],
  ['Kodachrome', "Ispirato a Kodak Kodachrome e allo sguardo di Luigi Ghirri: colori tenui e 'lavati', azzurri pastello, composizione ariosa, grana finissima.",
             "Inspired by Kodak Kodachrome and Luigi Ghirri's eye: soft 'washed' colours, pastel blues, airy composition, very fine grain."],
  ['Portra', "Ispirato a Kodak Portra (160/400): toni pelle caldi e cremosi, ombre aperte, colori pastello, grana finissima.",
             "Inspired by Kodak Portra (160/400): warm creamy skin tones, open shadows, pastel colours, very fine grain."],
  ['Gold 200', "Ispirato a Kodak Gold 200 / ColorPlus: dominante giallo-dorata nostalgica, contrasto medio, grana visibile.",
             "Inspired by Kodak Gold 200 / ColorPlus: a nostalgic golden-yellow cast, medium contrast, visible grain."],
  ['Velvia', "Ispirato a Fujifilm Velvia (50/100): saturazione estrema, contrasti vibranti, verdi/blu intensi, neri profondi.",
             "Inspired by Fujifilm Velvia (50/100): extreme saturation, vibrant contrast, intense greens/blues, deep blacks."],
  ['CineStill', "Ispirato a CineStill 800T: tonalità fredde di giorno e 'halation', l'alone rosso attorno alle luci.",
             "Inspired by CineStill 800T: cool daytime tones and 'halation', the red glow around lights."],
  ['Superia', "Ispirato a Fujifilm Superia X-TRA 400: tendenza fredda, verdi ricchi, blu profondi, grana finissima. Ideale per la street.",
             "Inspired by Fujifilm Superia X-TRA 400: a cool bias, rich greens, deep blues, very fine grain. Great for street."],
  ['Lomography', "Ispirato a Lomography Color Negative 400: colori saturi e caldi, altissimo contrasto, vignettatura e grana rustica.",
             "Inspired by Lomography Color Negative 400: saturated warm colours, high contrast, vignetting and rustic grain."],
  ['Ozarks', "Ispirato al color grading delle serie noir/crime: forte dominante teal, desaturato e cupo, ombre profonde, atmosfera tesa.",
             "Inspired by noir/crime TV grading: a strong teal cast, desaturated and gloomy, deep shadows, a tense mood."],
  ['Japan', "Ispirato all'estetica giapponese (Yūgen / Mono no aware): palette muted e fredda, azzurri soffici, basso contrasto, delicatezza.",
             "Inspired by the Japanese aesthetic (Yūgen / Mono no aware): a muted cool palette, soft blues, low contrast, delicacy."],
  ['CanonPS', "Ispirato alla compatta Canon PowerShot SD1000 (metà anni 2000): colori caldi e vividi, contrasto netto, morbidezza JPEG.",
             "Inspired by the Canon PowerShot SD1000 compact (mid-2000s): warm vivid colours, crisp contrast, JPEG softness."],
  ['Iphone', "Ispirato alla fotocamera 2MP del primo iPhone (2007): dettagli morbidi, cieli bruciati, toni caldi, al chiuso nebbioso e sgranato.",
             "Inspired by the 2MP camera of the original iPhone (2007): soft detail, blown-out skies, warm tones, hazy grainy indoors."],
  ['Point/Shoot', "Ispirato alle usa-e-getta anni '90: dominante calda, grana forte, vignettatura, 'light leak' da un angolo e data impressa. Look imperfetto e nostalgico.",
             "Inspired by 1990s disposable cameras: a warm cast, strong grain, vignetting, a corner 'light leak' and a date stamp. An imperfect, nostalgic look."],
  ['Dream', "Sfocatura morbida e toni pastello per un'atmosfera sognante, come un ricordo sfumato.",
             "Soft blur and pastel tones for a dreamy mood, like a faded memory."],
  ['Glitch', "Estetica cyberpunk/digitale: aberrazione cromatica, scatti orizzontali e righe da vecchio monitor.",
             "Cyberpunk/digital aesthetic: chromatic aberration, horizontal jumps and old-monitor scanlines."],
  ['Liquid Neon', "Effetto creativo originale: i contorni si accendono di neon mentre onde di colore scorrono nel tempo.",
             "An original creative effect: edges glow with neon while colour waves flow over time."],
];

const FOCALS = [
  ['Nat', 1.0], ['30', 1.12], ['35', 1.35], ['50', 1.9], ['85', 3.2]
];

// ---------- Stato ----------
let gl, programs = [], curEffect = 0, curFocal = 0, intensity = 1.0;
let texture, video, startTime = performance.now();
let soundOn = true, gridOn = false, flashOn = false;
let recorder = null, recChunks = [];

// ---------- WebGL ----------
function compile(src, type) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src); gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    console.error(gl.getShaderInfoLog(s));
  return s;
}
function buildProgram(frag) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(VERT, gl.VERTEX_SHADER));
  gl.attachShader(p, compile(frag, gl.FRAGMENT_SHADER));
  gl.linkProgram(p);
  return p;
}
function fragFor(effect) {
  return HEAD + `void main(){ ${effect.body}
    vec3 orig = texture2D(uTex, vTex).rgb;
    gl_FragColor = vec4(mix(orig, clamp(col,0.0,1.0), uIntensity), 1.0);
  }`;
}

function initGL(canvas) {
  gl = canvas.getContext('webgl');
  programs = EFFECTS.map(e => buildProgram(fragFor(e)));

  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  // pos.xy, tex.uv  (quad a schermo intero; tex.v capovolto per il video)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1,-1, 0,1,   1,-1, 1,1,   -1,1, 0,0,   1,1, 1,0
  ]), gl.STATIC_DRAW);

  texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
}

function draw() {
  if (video && video.readyState >= 2) {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, video);
  }
  const p = programs[curEffect];
  gl.useProgram(p);

  const buf = gl.getParameter(gl.ARRAY_BUFFER_BINDING);
  const aPos = gl.getAttribLocation(p, 'aPos');
  const aTex = gl.getAttribLocation(p, 'aTex');
  gl.enableVertexAttribArray(aPos);
  gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
  gl.enableVertexAttribArray(aTex);
  gl.vertexAttribPointer(aTex, 2, gl.FLOAT, false, 16, 8);

  gl.uniform1f(gl.getUniformLocation(p, 'uTime'), (performance.now()-startTime)/1000);
  gl.uniform1f(gl.getUniformLocation(p, 'uIntensity'), intensity);
  gl.uniform1f(gl.getUniformLocation(p, 'uZoom'), FOCALS[curFocal][1]);
  gl.uniform1i(gl.getUniformLocation(p, 'uTex'), 0);

  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  requestAnimationFrame(draw);
}

// ---------- Suono click (file audio reale: shutter.ogg) ----------
function playClick() {
  if (!soundOn) return;
  try {
    const el = document.getElementById('shutterAudio');
    if (el) {
      el.currentTime = 0;      // riparte da capo a ogni scatto
      el.volume = 1.0;
      el.play();
    }
  } catch (e) {}
}

// ---------- UI ----------
function toast(msg){
  const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'),1500);
}
function buildRails(){
  const fr=document.getElementById('focals');
  FOCALS.forEach(([name],i)=>{
    const c=document.createElement('div'); c.className='chip focals'+(i===0?' active':'');
    c.textContent=name;
    c.onclick=()=>{
      curFocal=i;
      document.querySelectorAll('#focals .chip').forEach(x=>x.classList.remove('active'));
      c.classList.add('active');
      document.getElementById('lcd').textContent = i===0?'NAT':name+'mm';
    };
    fr.appendChild(c);
  });
  const er=document.getElementById('effects');
  EFFECTS.forEach((e,i)=>{
    const c=document.createElement('div'); c.className='chip'+(i===0?' active':'');
    c.textContent=e.name;
    c.onclick=()=>{
      curEffect=i;
      document.querySelectorAll('#effects .chip').forEach(x=>x.classList.remove('active'));
      c.classList.add('active');
    };
    er.appendChild(c);
  });
}
function drawGrid(){
  const g=document.getElementById('grid');
  const r=g.getBoundingClientRect(); g.width=r.width; g.height=r.height;
  const c=g.getContext('2d'); c.clearRect(0,0,g.width,g.height);
  c.strokeStyle='rgba(255,255,255,.45)'; c.lineWidth=1;
  for(const f of [1/3,2/3]){
    c.beginPath(); c.moveTo(g.width*f,0); c.lineTo(g.width*f,g.height); c.stroke();
    c.beginPath(); c.moveTo(0,g.height*f); c.lineTo(g.width,g.height*f); c.stroke();
  }
}

function capturePhoto(){
  playClick();
  // Vibrazione tattile breve allo scatto (solo foto, non video)
  if (navigator.vibrate) { try { navigator.vibrate(35); } catch(e){} }
  const canvas=document.getElementById('gl');
  canvas.toBlob(b=>{
    const a=document.createElement('a');
    a.href=URL.createObjectURL(b);
    a.download='CrudoFoto_'+Date.now()+'.png';
    a.click();
    toast('Foto salvata');
  }, 'image/png');
}

function toggleRec(){
  const canvas=document.getElementById('gl');
  const btn=document.getElementById('btnRec');
  if(!recorder){
    const stream=canvas.captureStream(30);
    recChunks=[];
    recorder=new MediaRecorder(stream,{mimeType:'video/webm'});
    recorder.ondataavailable=e=>{ if(e.data.size>0) recChunks.push(e.data); };
    recorder.onstop=()=>{
      const blob=new Blob(recChunks,{type:'video/webm'});
      const a=document.createElement('a');
      a.href=URL.createObjectURL(blob); a.download='CrudoFoto_'+Date.now()+'.webm'; a.click();
      toast('Video salvato');
    };
    recorder.start(); btn.classList.add('active'); btn.textContent='STOP';
  } else {
    recorder.stop(); recorder=null; btn.classList.remove('active'); btn.textContent='REC';
  }
}

// ---------- Guida effetti (finestra "i") ----------
let infoEnglish = false;
function renderInfoList(){
  const list = document.getElementById('infoList');
  list.innerHTML = '';
  EFFECT_INFO.forEach(([name, it, en]) => {
    const item = document.createElement('div'); item.className = 'info-item';
    const n = document.createElement('div'); n.className = 'n'; n.textContent = name;
    const d = document.createElement('div'); d.className = 'd';
    d.textContent = infoEnglish ? en : it;
    item.appendChild(n); item.appendChild(d); list.appendChild(item);
  });
  document.getElementById('infoTitle').textContent =
    infoEnglish ? 'Effects guide' : 'Guida agli effetti';
  document.getElementById('langIt').classList.toggle('active', !infoEnglish);
  document.getElementById('langEn').classList.toggle('active', infoEnglish);
}

let facingMode = 'environment';   // 'environment' = posteriore, 'user' = selfie

async function openCamera(){
  try{
    // Ferma lo stream precedente prima di aprirne uno nuovo
    if (video && video.srcObject) {
      video.srcObject.getTracks().forEach(t => t.stop());
    }
    const stream=await navigator.mediaDevices.getUserMedia({
      video:{ facingMode: facingMode }, audio:false
    });
    video.srcObject=stream; await video.play();
  }catch(e){ toast('Fotocamera non disponibile'); }
}

function flipCamera(){
  facingMode = (facingMode === 'environment') ? 'user' : 'environment';
  openCamera();
}

async function start(){
  const canvas=document.getElementById('gl');
  // dimensione interna del canvas = dimensione visibile
  const r=canvas.getBoundingClientRect();
  canvas.width=r.width; canvas.height=r.height;
  initGL(canvas);

  video=document.getElementById('video');
  await openCamera();

  requestAnimationFrame(draw);
}

// ---------- Wiring pulsanti ----------
window.addEventListener('DOMContentLoaded', ()=>{
  buildRails();
  document.getElementById('intensity').oninput=e=>{
    intensity=e.target.value/100;
    document.getElementById('intVal').textContent=e.target.value+'%';
  };
  document.getElementById('btnShot').onclick=capturePhoto;
  document.getElementById('btnRec').onclick=toggleRec;
  document.getElementById('dSound').onclick=e=>{
    soundOn=!soundOn; e.target.classList.toggle('active',soundOn);
  };
  document.getElementById('dGrid').onclick=e=>{
    gridOn=!gridOn; e.target.classList.toggle('active',gridOn);
    document.getElementById('grid').classList.toggle('on',gridOn);
    if(gridOn) drawGrid();
  };
  const flashHandler=e=>{
    flashOn=!flashOn;
    document.getElementById('dFlash').classList.toggle('active',flashOn);
    document.getElementById('btnFlash').classList.toggle('active',flashOn);
    // Nota: il flash hardware non e' controllabile in modo affidabile da web.
    toast(flashOn?'Flash: web non supporta la torcia':'Flash off');
  };
  document.getElementById('dFlash').onclick=flashHandler;
  document.getElementById('btnFlash').onclick=flashHandler;

  // Guida effetti "i"
  document.getElementById('dInfo').onclick=()=>{
    renderInfoList();
    document.getElementById('infoOverlay').classList.add('show');
  };
  document.getElementById('dFlip').onclick=()=>{ flipCamera(); };
  document.getElementById('infoClose').onclick=()=>{
    document.getElementById('infoOverlay').classList.remove('show');
  };
  document.getElementById('infoOverlay').onclick=(e)=>{
    if(e.target.id==='infoOverlay')
      document.getElementById('infoOverlay').classList.remove('show');
  };
  document.getElementById('langIt').onclick=()=>{ infoEnglish=false; renderInfoList(); };
  document.getElementById('langEn').onclick=()=>{ infoEnglish=true; renderInfoList(); };

  window.addEventListener('resize', ()=>{ if(gridOn) drawGrid(); });
  start();
});
