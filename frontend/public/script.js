
/* ══════════════════════════════════════════════════════════════
   ARCVAULT — Script principal v2
   CAMBIOS vs v1:
   ✅ Threshold configurable (slider) — default 0.65 (antes 0.6 fijo)
   ✅ minConfidence consistente 0.4 en carga Y detección
   ✅ Augmentación: genera descriptor del flip horizontal también
   ✅ Debug panel en tiempo real (distancia, match, barra visual)
   ✅ Cooldown reducido: 2s tras fallo (antes 4s)
   ✅ Canvas se redimensiona con ResizeObserver
   ✅ Retry automático si video no está listo
   ✅ Log incluye distancia para auditoría
══════════════════════════════════════════════════════════════ */
let accesoActivo = false;
// ── CONFIGURACIÓN ─────────────────────────────────────────────
const CONFIG = {
    MIN_CONFIDENCE: 0.4,        // Confianza mínima para detectar cara (consistente)
    FACE_MATCH_THRESHOLD: 0.65, // Umbral FaceMatcher — ajustable por slider
    COOLDOWN_OK: 3000,          // ms de espera tras reconocimiento exitoso
    COOLDOWN_FAIL: 2000,        // ms de espera tras fallo (antes era 4000)
    DETECTION_INTERVAL: 500,    // ms entre frames analizados
};

// ── ESTADO GLOBAL ──────────────────────────────────────────────
const State = {
    empresaId: null,
    empresaNombre: '',
    sala: 'Ingreso',
    modelsLoaded: false,
    labeledDescriptors: [],
    stream: null,
    faceInterval: null,
    processing: false,
    lastMatchTime: 0,
    logs: [],
    permisos: null,
    puertaActualMantrab: null,        // 'principal' o 'subpuerta'
    subPuertaDesbloqueada: false,
};

// ── HELPERS: PANTALLAS ─────────────────────────────────────────
const screens = {
    main: document.getElementById('screen-main'),
    dashboard: document.getElementById('screen-dashboard'),
    mantrab: document.getElementById('screen-mantrab'),
};
function showScreen(name) {
    Object.values(screens).forEach(s => s.classList.add('hidden'));
    screens[name].classList.remove('hidden');
}

// ── HELPERS: MODALES ───────────────────────────────────────────
function openModal(id) { document.getElementById(id).classList.remove('hidden'); }
function closeModal(id) { document.getElementById(id).classList.add('hidden'); }

// ── HELPERS: LOADING ───────────────────────────────────────────
function showLoading(text = 'CARGANDO...') {
    document.getElementById('loading-text').textContent = text;
    document.getElementById('loading-overlay').classList.remove('hidden');
}
function hideLoading() {
    document.getElementById('loading-overlay').classList.add('hidden');
}

// ── HELPERS: TIME ──────────────────────────────────────────────
function nowTime() {
    const d = new Date();
    return d.getHours().toString().padStart(2, '0') + ':' + d.getMinutes().toString().padStart(2, '0');
}

// ── CAPTURAR FOTO (base64) ─────────────────────────────────────
function captureFrame() {
    const video = document.getElementById('video');
    const c = document.createElement('canvas');
    c.width = 320; c.height = 240;
    c.getContext('2d').drawImage(video, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.7);
}

// ── SLIDER THRESHOLD ──────────────────────────────────────────
const slider = document.getElementById('threshold-slider');
slider.addEventListener('input', () => {
    const val = parseFloat(slider.value);
    CONFIG.FACE_MATCH_THRESHOLD = val;
    document.getElementById('threshold-display').textContent = val.toFixed(2);
    document.getElementById('dbg-threshold').textContent = val.toFixed(2);
    // Recrear FaceMatcher con nuevo umbral si ya existe
    if (State.labeledDescriptors.length > 0) {
        window.faceMatcher = new faceapi.FaceMatcher(State.labeledDescriptors, val);
        console.log(`🔧 FaceMatcher recreado con umbral ${val}`);
    }
});

// ── DEBUG TOGGLE ──────────────────────────────────────────────
document.getElementById('debug-toggle-check').addEventListener('change', function () {
    document.getElementById('debug-panel').classList.toggle('visible', this.checked);
});

// ── UPDATE DEBUG PANEL ────────────────────────────────────────
function updateDebug(faces, label, distance) {
    if (!document.getElementById('debug-panel').classList.contains('visible')) return;

    document.getElementById('dbg-faces').textContent = faces;
    document.getElementById('dbg-label').textContent = label || '—';

    if (distance !== null && distance !== undefined) {
        const distStr = distance.toFixed(4);
        const distEl = document.getElementById('dbg-dist');
        distEl.textContent = distStr;

        const threshold = CONFIG.FACE_MATCH_THRESHOLD;
        if (distance < threshold * 0.75) {
            distEl.className = 'debug-val good';
        } else if (distance < threshold) {
            distEl.className = 'debug-val warn';
        } else {
            distEl.className = 'debug-val bad';
        }

        // Confidence bar: distance 0 = 100% match, distance >= threshold = 0%
        const confPct = Math.max(0, Math.min(100, (1 - distance / threshold) * 100));
        const bar = document.getElementById('dbg-bar');
        bar.style.width = confPct + '%';
        bar.style.background = confPct > 60 ? 'var(--success)' : confPct > 30 ? 'var(--warning)' : 'var(--danger)';
    } else {
        document.getElementById('dbg-dist').textContent = '—';
        document.getElementById('dbg-dist').className = 'debug-val';
        document.getElementById('dbg-bar').style.width = '0%';
    }
}

// ══════════════════════════════════════════════════════════════
// 1. INICIO: AUTO-CARGAR EMPRESA
// ══════════════════════════════════════════════════════════════
async function initEmpresas() {
    try {
        showLoading('CONECTANDO CON SERVIDOR...');
        const res = await fetch('/get-empresas');
        if (!res.ok) throw new Error('Server error');
        const data = await res.json();
        if (!data || data.length === 0) throw new Error('No hay empresas');

        State.empresaId = data[0].id;
        State.empresaNombre = data[0].nombre;

        document.getElementById('empresa-nombre-label').textContent =
            State.empresaNombre + ' — Verificación Biométrica';

        showLoading('CARGANDO MODELOS DE IA...');
        await loadModels();

        showLoading('CARGANDO PERFILES BIOMÉTRICOS...');
        await loadDescriptors();

    } catch (err) {
        console.error('initEmpresas error:', err);
        // No bloquear: mostrar pantalla de todas formas
    }

    hideLoading();
    showScreen('main');
}

// ══════════════════════════════════════════════════════════════
// 2. FACE-API: CARGAR MODELOS
// ══════════════════════════════════════════════════════════════
async function loadModels() {
    if (State.modelsLoaded) return;
    const MODEL_URL = '/models';
    await Promise.all([
        faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL),
    ]);
    State.modelsLoaded = true;
    console.log('✅ Modelos cargados');
}

// ══════════════════════════════════════════════════════════════
// 3. FACE-API: CARGAR DESCRIPTORES + AUGMENTACIÓN
// ══════════════════════════════════════════════════════════════

/**
 * Genera descriptor de una imagen.
 * augment=true también genera el flip horizontal para mejor cobertura.
 */
async function getDescriptorsFromImg(img, augment = true) {
    const opts = new faceapi.SsdMobilenetv1Options({ minConfidence: CONFIG.MIN_CONFIDENCE });
    const descriptors = [];

    // Descriptor original
    const det = await faceapi.detectSingleFace(img, opts)
        .withFaceLandmarks()
        .withFaceDescriptor();

    if (det) {
        descriptors.push(det.descriptor);
        console.log('  ✅ Descriptor original generado');
    } else {
        console.warn('  ⚠️ Sin rostro en imagen original');
    }

    // Descriptor del flip horizontal (augmentación)
    if (augment) {
        try {
            const canvas = document.createElement('canvas');
            canvas.width = img.width || img.naturalWidth || 300;
            canvas.height = img.height || img.naturalHeight || 300;
            const ctx = canvas.getContext('2d');
            ctx.translate(canvas.width, 0);
            ctx.scale(-1, 1);
            ctx.drawImage(img, 0, 0);

            const flippedImg = await faceapi.bufferToImage(await (await fetch(canvas.toDataURL())).blob());
            const detFlip = await faceapi.detectSingleFace(flippedImg, opts)
                .withFaceLandmarks()
                .withFaceDescriptor();

            if (detFlip) {
                descriptors.push(detFlip.descriptor);
                console.log('  ✅ Descriptor flip generado');
            }
        } catch (e) {
            console.warn('  ⚠️ Error generando flip:', e);
        }
    }

    return descriptors;
}

async function loadDescriptors() {
    if (!State.empresaId) return;
    State.labeledDescriptors = [];

    try {
        const res = await fetch(`/get-labels?empresaId=${State.empresaId}`);
        const { labels } = await res.json();
        console.log(`📋 ${labels.length} usuarios a cargar:`, labels);

        for (const label of labels) {
            try {
                console.log(`🔄 Procesando: ${label}`);
                const imgRes = await fetch(`/get-image?name=${encodeURIComponent(label)}&empresaId=${State.empresaId}`);
                const blob = await imgRes.blob();
                const img = await faceapi.bufferToImage(blob);

                const descriptors = await getDescriptorsFromImg(img, true);

                if (descriptors.length > 0) {
                    State.labeledDescriptors.push(
                        new faceapi.LabeledFaceDescriptors(label, descriptors)
                    );
                    console.log(`✅ ${label} — ${descriptors.length} descriptor(es) cargado(s)`);
                } else {
                    console.warn(`❌ ${label} — sin descriptores válidos`);
                }
            } catch (e) {
                console.error(`Error con ${label}:`, e);
            }
        }

        console.log(`🔥 Total: ${State.labeledDescriptors.length} usuarios con descriptores`);

        // Crear FaceMatcher con threshold configurable
        if (State.labeledDescriptors.length > 0) {
            window.faceMatcher = new faceapi.FaceMatcher(
                State.labeledDescriptors,
                CONFIG.FACE_MATCH_THRESHOLD
            );
            console.log(`✅ FaceMatcher listo (umbral: ${CONFIG.FACE_MATCH_THRESHOLD})`);
        } else {
            console.warn('⚠️ No se cargó ningún descriptor. Verifica que las imágenes tengan rostros claros.');
        }

        document.getElementById('stat-usuarios').textContent = State.labeledDescriptors.length;

    } catch (err) {
        console.error('Error cargando descriptores:', err);
    }
}

// ══════════════════════════════════════════════════════════════
// 4. CÁMARA
// ══════════════════════════════════════════════════════════════
const video = document.getElementById('video');
const faceCanvas = document.getElementById('faceCanvas');
const scanLine = document.getElementById('scanLine');
const camPlaceholder = document.getElementById('camPlaceholder');
const faceOverlay = document.getElementById('face-overlay');
const doorLabel = document.getElementById('doorLabel');

document.getElementById('btnStartCam').addEventListener('click', startCamera);
document.getElementById('btnStopCam').addEventListener('click', stopCamera);

async function startCamera() {
    try {
        State.stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: 'user',
                width: { ideal: 1280 },
                height: { ideal: 720 }
            }
        });
        video.srcObject = State.stream;
        await video.play();
        video.style.display = 'block';
        // Mejora contraste y brillo para mejor detección
        video.style.filter = 'brightness(1.15) contrast(1.1)';
        camPlaceholder.style.display = 'none';
        scanLine.style.display = 'block';

        document.getElementById('btnStartCam').style.display = 'none';
        document.getElementById('btnStopCam').style.display = 'block';
        doorLabel.textContent = 'Cámara activa — analizando rostro...';

        // Esperar a que el video tenga dimensiones válidas
        video.addEventListener('loadeddata', onVideoReady, { once: true });
        // Fallback si loadeddata ya fue disparado
        if (video.readyState >= 2) onVideoReady();

    } catch (err) {
        console.error('Error cámara:', err);
        doorLabel.textContent = '⚠️ Error al acceder a la cámara: ' + err.message;
    }
}

function stopCamera() {
    if (State.faceInterval) { clearInterval(State.faceInterval); State.faceInterval = null; }
    if (State.stream) { State.stream.getTracks().forEach(t => t.stop()); State.stream = null; }

    video.style.display = 'none';
    video.style.filter = '';
    camPlaceholder.style.display = 'flex';
    scanLine.style.display = 'none';
    faceOverlay.style.display = 'none';

    const ctx = faceCanvas.getContext('2d');
    ctx.clearRect(0, 0, faceCanvas.width, faceCanvas.height);

    document.getElementById('btnStartCam').style.display = 'block';
    document.getElementById('btnStopCam').style.display = 'none';
    doorLabel.textContent = 'Puerta asegurada — esperando verificación';
    State.processing = false;

    updateDebug(0, null, null);
}

let videoReadyRetries = 0;

function onVideoReady() {
    const w = video.videoWidth;
    const h = video.videoHeight;

    if (!w || !h) {
        videoReadyRetries++;
        if (videoReadyRetries > 20) {
            console.error('❌ Video no listo después de 20 intentos');
            return;
        }
        console.warn(`⚠️ Video no listo (intento ${videoReadyRetries}), reintentando...`);
        setTimeout(onVideoReady, 300);
        return;
    }

    videoReadyRetries = 0;
    syncCanvasToVideo();

    if (State.faceInterval) clearInterval(State.faceInterval);
    State.faceInterval = setInterval(() => runFaceDetection(), CONFIG.DETECTION_INTERVAL);
    console.log(`🎥 Video listo: ${w}x${h} — Loop iniciado`);
}

// Sincronizar canvas con dimensiones reales del video en pantalla
function syncCanvasToVideo() {
    faceCanvas.width = video.videoWidth;
    faceCanvas.height = video.videoHeight;
    faceapi.matchDimensions(faceCanvas, { width: video.videoWidth, height: video.videoHeight });
}

// Redimensionar canvas si el contenedor cambia de tamaño
const resizeObserver = new ResizeObserver(() => {
    if (video.videoWidth) syncCanvasToVideo();
});
resizeObserver.observe(document.getElementById('camWrap'));

// ══════════════════════════════════════════════════════════════
// 5. RECONOCIMIENTO FACIAL (loop)
// ══════════════════════════════════════════════════════════════
async function runFaceDetection() {
    if (!video.readyState || video.readyState < 2) return;
    if (video.paused || video.ended) return;
    if (accesoActivo) return;

    const opts = new faceapi.SsdMobilenetv1Options({ minConfidence: CONFIG.MIN_CONFIDENCE });

    const detections = await faceapi
        .detectAllFaces(video, opts)
        .withFaceLandmarks()
        .withFaceDescriptors();

    const displaySize = { width: video.videoWidth, height: video.videoHeight };
    const resized = faceapi.resizeResults(detections, displaySize);

    const ctx = faceCanvas.getContext('2d');
    ctx.clearRect(0, 0, faceCanvas.width, faceCanvas.height);
    faceapi.draw.drawDetections(faceCanvas, resized);

    // Actualizar debug
    updateDebug(resized.length, null, null);

    // 🔥 NUEVO: Guardar cuántas personas detectó la cámara (para Mantrab)
    State.personasDetectadas = resized.length;

    if (!window.faceMatcher || resized.length === 0) return;

    const now = Date.now();
    if (State.processing) return;
    if ((now - State.lastMatchTime) < CONFIG.COOLDOWN_FAIL) return;

    // Tomar el rostro más grande (más cercano a la cámara)
    let bestDetection = resized[0];
    if (resized.length > 1) {
        bestDetection = resized.reduce((a, b) =>
            (a.detection.box.area > b.detection.box.area) ? a : b
        );
    }

    const result = window.faceMatcher.findBestMatch(bestDetection.descriptor);
    console.log(`🔍 Match: "${result.label}" | Distancia: ${result.distance.toFixed(4)} | Umbral: ${CONFIG.FACE_MATCH_THRESHOLD}`);

    updateDebug(resized.length, result.label, result.distance);

    if (result.label === 'unknown' || result.distance > CONFIG.FACE_MATCH_THRESHOLD) {
        setFaceOverlay(`❌ No reconocido (d=${result.distance.toFixed(3)})`, 'err');
        State.processing = true;
        State.lastMatchTime = now;
        await handleFailedAttempt('unknown', result.distance);

    } else {
        setFaceOverlay(`✅ ${result.label} (d=${result.distance.toFixed(3)})`, 'ok');
        State.lastMatchTime = now;
        await handleSuccessMatch(result.label, result.distance);
    }
}

function setFaceOverlay(msg, type) {
    faceOverlay.textContent = msg;
    faceOverlay.className = type === 'ok' ? 'face-ok' : type === 'warn' ? 'face-warn' : 'face-err';
    faceOverlay.style.display = 'block';
    if (type !== 'ok') {
        setTimeout(() => { faceOverlay.style.display = 'none'; }, CONFIG.COOLDOWN_FAIL);
    }
}

// ══════════════════════════════════════════════════════════════
// 6. MATCH EXITOSO
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
// 6. MATCH EXITOSO
// ══════════════════════════════════════════════════════════════
async function handleSuccessMatch(nombreLabel, distancia) {
    console.log("🔥 ENTRE A SUCCESS");

    // Marcamos como procesando para evitar múltiples llamadas
    State.processing = true;

    let usuarioId = null;
    let cargo = null;
    let fijo = 0;
    let esAdmin = false;

    // 1️⃣ Obtener datos del usuario
    try {
        const idRes = await fetch(`/get-user-id?name=${encodeURIComponent(nombreLabel)}&empresaId=${State.empresaId}`);
        if (idRes.ok) {
            const data = await idRes.json();
            usuarioId = data.id;
            cargo = data.cargo;
            fijo = data.fijo;
            esAdmin = Number(fijo) === 1 || (cargo && cargo.toLowerCase().includes('admin'));

            // Cargar permisos
            State.permisos = obtenerPermisosPorRol(cargo || "Empleado");
            console.log("🔐 Permisos cargados:", State.permisos);
            renderSalas();
        }
    } catch (err) {
        console.warn('No se pudo obtener usuario:', err.message);
    }

  // 2️⃣ Si la sala es MANTRAB → primero validar permisos, luego abrir panel
if (State.sala === 'Mantrab') {
    if (!usuarioId) {
        setFaceOverlay('❌ Usuario no encontrado en BD', 'err');
        State.processing = false;
        return;
    }

    // Verificar que tiene permiso para entrar al Mantrab
    const puedeEntrar = esAdmin ||
        (State.permisos && State.permisos.salas && State.permisos.salas.includes('Mantrab'));

    if (!puedeEntrar) {
        setFaceOverlay(`⛔ ${nombreLabel}: Sin permiso para Mantrab`, 'err');
        alert(`⛔ ACCESO DENEGADO\n\n${nombreLabel}, no tienes permisos para acceder al sistema Mantrab.`);
        State.processing = false;
        return;
    }

    // ✅ Identificación inicial OK → abrir el panel de doble puerta
    setFaceOverlay(`✅ ${nombreLabel} — Acceso autorizado al Mantrab`, 'ok');
    setTimeout(() => {
        mostrarPanelMantrab();
        State.processing = false;
    }, 1500);
    return;
}

    // 3️⃣ Para CUALQUIER OTRA sala (lógica normal de antes)
    accesoActivo = false;
    procesarAccesoESP32(nombreLabel, distancia);
    stopCamera();

    // Si quiere entrar al Dashboard, validar admin
    if (State.sala === 'Dashboard') {
        if (esAdmin) {
            setTimeout(() => {
                window.location.href = '/dashboard.html?user=' + encodeURIComponent(nombreLabel);
            }, 600);
        } else {
            document.getElementById('modal-ok-body').innerHTML =
                `<strong>${nombreLabel}</strong><br>No tienes permisos para acceder al Dashboard.`;
            openModal('modal-ok');
            State.processing = false;
        }
        return;
    }

    // Acceso normal a otras salas
    document.getElementById('modal-ok-body').innerHTML =
        `<strong>${nombreLabel}</strong><br>Acceso concedido a <strong>${State.sala}</strong>.<br>
        <span style="font-size:.72rem;color:var(--muted);">${new Date().toLocaleTimeString()}</span>`;
    openModal('modal-ok');

    document.getElementById('modal-ok-btn').onclick = () => {
        closeModal('modal-ok');
        State.processing = false;
        accesoActivo = true;
        doorLabel.textContent = '✔ Acceso concedido — esperando nueva acción';
    };
}

// ══════════════════════════════════════════════════════════════
// 6.B — MANTRAB: PROCESAR PUERTA PRINCIPAL
// ══════════════════════════════════════════════════════════════
async function procesarMantrabPrincipal(usuarioId, nombreLabel) {
    // Obtener cuántas personas detectó la cámara
    const personasDetectadas = State.personasDetectadas || 1;

    try {
        const res = await fetch('/mantrap/principal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                usuario_id: usuarioId,
                personas_detectadas: personasDetectadas
            })
        });

        const data = await res.json();
        console.log('🚪 Respuesta /mantrap/principal:', data);

        // Actualizar UI con el contador
        actualizarContadoresMantrab(data);

        // Mensaje en overlay de la cámara
        if (data.completo) {
            setFaceOverlay(`✅ ${nombreLabel} — Todos identificados (${data.identificados}/${data.personas_detectadas})`, 'ok');
            // Mostrar botón de pasar a sub-puerta
            document.getElementById('btnPasarSubpuerta').classList.remove('hidden');
            // Mostrar botón de reset también por si quieren cancelar
            document.getElementById('btnResetMantrab').classList.remove('hidden');
        } else {
            setFaceOverlay(`✅ ${nombreLabel} (${data.identificados}/${data.personas_detectadas})`, 'ok');
            document.getElementById('btnResetMantrab').classList.remove('hidden');
        }

        // Cooldown corto para que pueda identificarse otra persona
        setTimeout(() => {
            State.processing = false;
        }, 1500);

    } catch (err) {
        console.error('❌ Error mantrab/principal:', err);
        setFaceOverlay('❌ Error de conexión', 'err');
        State.processing = false;
    }
}

// ══════════════════════════════════════════════════════════════
// 6.C — MANTRAB: PROCESAR SUB-PUERTA
// ══════════════════════════════════════════════════════════════
async function procesarMantrabSubpuerta(usuarioId, nombreLabel) {
    try {
        const res = await fetch('/mantrap/subpuerta', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario_id: usuarioId })
        });

        const data = await res.json();
        console.log('🔒 Respuesta /mantrap/subpuerta:', data);

        // Actualizar UI con el contador
        actualizarContadoresMantrab(data);

        if (data.autorizado) {
            // 🟢 ACCESO TOTAL — animación de puerta abriéndose
            setFaceOverlay(`🟢 ¡ACCESO AUTORIZADO! ${nombreLabel}`, 'ok');
            stopCamera();

            document.getElementById('modal-ok-body').innerHTML =
                `<strong>🟢 ACCESO AUTORIZADO</strong><br>
                Todos identificados correctamente.<br>
                Puerta abriéndose...<br>
                <span style="font-size:.72rem;color:var(--muted);">${new Date().toLocaleTimeString()}</span>`;
            openModal('modal-ok');

            // Resetear UI Mantrab tras 2 segundos
            setTimeout(() => {
                resetUIMantrab();
                State.processing = false;
            }, 2000);

       } else if (data.codigo === 'NOT_IN_PRINCIPAL') {
    // Pausar la cámara para que no siga identificando
    accesoActivo = true;
    
    document.getElementById('btnVolverPrincipalFs').classList.remove('hidden');
    
    alert(`⛔ ACCESO DENEGADO\n\n${nombreLabel}, usted no se identificó en la puerta principal.\nPresione "VOLVER A PUERTA PRINCIPAL" para identificarse.`);
} else if (data.codigo === 'PRINCIPAL_INCOMPLETE') {
            // ❌ Faltan personas por identificarse en principal
            setFaceOverlay(`⚠️ Faltan personas en principal`, 'warn');
            alert(`⛔ ACCESO DENEGADO\n\n${data.motivo}\n\nLas personas que faltaron deben volver a la puerta principal e identificarse.`);
            setTimeout(() => { State.processing = false; }, 2000);

        } else if (data.codigo === 'PARTIAL') {
            // 🟡 Identificado pero falta gente en sub-puerta
            setFaceOverlay(`✅ ${nombreLabel} (${data.identificados_subpuerta}/${data.personas_detectadas})`, 'ok');
            setTimeout(() => { State.processing = false; }, 1500);

        } else {
            // Otros casos
            setFaceOverlay(`⚠️ ${data.motivo || 'Error'}`, 'warn');
            setTimeout(() => { State.processing = false; }, 2000);
        }

    } catch (err) {
        console.error('❌ Error mantrab/subpuerta:', err);
        setFaceOverlay('❌ Error de conexión', 'err');
        State.processing = false;
    }
}

// ══════════════════════════════════════════════════════════════
// 6.D — MANTRAB: ACTUALIZAR CONTADORES EN UI
// ══════════════════════════════════════════════════════════════
function actualizarContadoresMantrab(data) {
    const principalCounter = document.getElementById('mantrab-principal-counter');
    const subCounter = document.getElementById('mantrab-sub-counter');

    if (principalCounter && data.identificados !== undefined) {
        principalCounter.textContent = `${data.identificados}/${data.personas_detectadas}`;
    }

    if (subCounter && data.identificados_subpuerta !== undefined) {
        subCounter.textContent = `${data.identificados_subpuerta}/${data.personas_detectadas}`;
    }

    // Si ya están todos en principal, marcar visualmente
    if (data.completo === true || data.subpuerta_desbloqueada === true) {
        document.getElementById('mantrab-sub-card').classList.remove('locked');
        document.getElementById('mantrab-sub-card').classList.add('unlocked');
        document.getElementById('mantrab-sub-status').textContent = '🔓 Desbloqueada — listos para pasar';
    }
}

// ══════════════════════════════════════════════════════════════
// 6.E — MANTRAB: RESETEAR UI
// ══════════════════════════════════════════════════════════════
function resetUIMantrab() {
    State.puertaActualMantrab = 'principal';
    State.subPuertaDesbloqueada = false;
    State.personasDetectadas = 0;

    document.getElementById('mantrab-principal-counter').textContent = '0/0';
    document.getElementById('mantrab-sub-counter').textContent = '0/0';

    document.getElementById('mantrab-principal-card').classList.add('active');
    document.getElementById('mantrab-sub-card').classList.remove('active', 'unlocked');
    document.getElementById('mantrab-sub-card').classList.add('locked');

    document.getElementById('mantrab-principal-status').textContent = '🟢 ACTIVA — Identifícate aquí';
    document.getElementById('mantrab-sub-status').textContent = '🔒 Bloqueada — pasa primero por la principal';

    document.getElementById('btnPasarSubpuerta').classList.add('hidden');
    document.getElementById('btnResetMantrab').classList.add('hidden');

    closeModal('modal-ok');
}


// ══════════════════════════════════════════════════════════════
// 7. MATCH FALLIDO
// ══════════════════════════════════════════════════════════════
async function handleFailedAttempt(nombre, distancia) {
    addLog('Desconocido', State.sala, 'DENEGADO', distancia);

    try {
        const foto = captureFrame();
        await fetch('/register-failed-attempt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                cedula: '000000',
                nombre: 'Desconocido',
                empresaId: State.empresaId,
                motivo: `Distancia: ${distancia?.toFixed(4) || 'N/A'} — Sala: ${State.sala} — Umbral: ${CONFIG.FACE_MATCH_THRESHOLD}`,
                fotoIntento: foto,
            })
        });
    } catch (e) {
        console.warn('No se pudo registrar intento fallido:', e);
    }

    openModal('modal-err');
    setTimeout(() => {
        closeModal('modal-err');
        State.processing = false; // ← Reanudar detección tras cooldown
    }, CONFIG.COOLDOWN_FAIL);
}

document.getElementById('modal-err-btn').onclick = () => {
    closeModal('modal-err');
    State.processing = false;
};

// ══════════════════════════════════════════════════════════════
// 8. MODAL ADMIN LOGIN
// ══════════════════════════════════════════════════════════════
document.getElementById('modal-admin-cancel').onclick = () => {
    closeModal('modal-admin');
    State.processing = false;
};

document.getElementById('modal-admin-ok').onclick = async () => {
    const username = document.getElementById('admin-user').value.trim();
    const password = document.getElementById('admin-pass').value.trim();
    const errEl = document.getElementById('admin-login-error');

    if (!username || !password) { errEl.textContent = 'Complete todos los campos'; return; }

    const res = await fetch('/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
    });

    if (res.ok) {
        closeModal('modal-admin');
        showScreen('dashboard');
    } else {
        errEl.textContent = 'Credenciales incorrectas';
    }
};

document.getElementById('admin-pass').onkeydown = (e) => {
    if (e.key === 'Enter') document.getElementById('modal-admin-ok').click();
};

// ══════════════════════════════════════════════════════════════
// 9. DASHBOARD
// ══════════════════════════════════════════════════════════════
document.getElementById('btnLogout').onclick = () => showScreen('main');

// ══════════════════════════════════════════════════════════════
// 10. LOG
// ══════════════════════════════════════════════════════════════
function addLog(nombre, sala, estado, distancia) {
    State.logs.unshift({ nombre, sala, hora: nowTime(), estado, distancia });
    const concedidos = State.logs.filter(l => l.estado === 'CONCEDIDO').length;
    document.getElementById('stat-accesos').textContent = concedidos;
    document.getElementById('stat-accesos-sub').textContent = `${State.logs.length} intentos totales hoy`;
    renderLog();
}

function renderLog() {
    const body = document.getElementById('logBody');
    if (State.logs.length === 0) {
        body.innerHTML = '<tr><td colspan="5" style="color:var(--muted);text-align:center;padding:1.5rem;">Sin registros aún</td></tr>';
        return;
    }
    body.innerHTML = State.logs.slice(0, 12).map(l => `
                <tr>
                    <td>${l.nombre}</td>
                    <td>${l.sala}</td>
                    <td>${l.hora}</td>
                    <td style="color:var(--muted);font-size:.7rem;">${l.distancia != null ? l.distancia.toFixed(4) : '—'}</td>
                    <td class="${l.estado === 'CONCEDIDO' ? 'badge-ok' : 'badge-err'}">● ${l.estado}</td>
                </tr>`).join('');
}

// ══════════════════════════════════════════════════════════════
// 11. TABS
// ══════════════════════════════════════════════════════════════
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {

        // 🔥 CONTROL DE CÁMARA
        if (btn.dataset.tab === "registro") {
            stopCamera();
            accesoActivo = true; // bloquear detección
        }

        if (btn.dataset.tab === "salas") {
            accesoActivo = false;
            startCamera();
        }

        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));

        btn.classList.add('active');
        document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
    });
});

// ══════════════════════════════════════════════════════════════
// 12. FORMULARIO REGISTRO
// ══════════════════════════════════════════════════════════════
/*document.getElementById('user-form').addEventListener('submit', async function (e) {
    e.preventDefault();
    // 🔥 VALIDACIÓN DE FOTO
    if (!document.getElementById('reg-photo').value) {
        alert("⚠️ Debes tomar una foto antes de registrar");
        return;
    }
    const btn = document.getElementById('btnSubmitUser');
    const status = document.getElementById('form-status');
    btn.disabled = true;
    status.textContent = 'Enviando datos...';
    status.style.color = 'var(--muted)';

    const formData = new FormData(this);
    const rol = document.getElementById('reg-cargo').value;
    const permisos = obtenerPermisosPorRol(rol);

    formData.append('permisos', JSON.stringify(permisos));
    formData.append('empresaId', State.empresaId);

    try {
        const res = await fetch('/upload', { method: 'POST', body: formData });
        if (res.ok) {
            this.reset();
            status.textContent = '';
            openModal('modal-reg');
            loadDescriptors(); // Recargar en background
        } else {
            const txt = await res.text();
            status.textContent = '❌ ' + txt;
            status.style.color = 'var(--danger)';
        }
    } catch (err) {
        status.textContent = '❌ Error de conexión';
        status.style.color = 'var(--danger)';
    }
    btn.disabled = false;
});*/
// ══════════════════════════════════════════════════════════════
// 12. FORMULARIO REGISTRO (CORREGIDO)
// ══════════════════════════════════════════════════════════════
document.getElementById('user-form').addEventListener('submit', async function (e) {
    e.preventDefault();

    if (!document.getElementById('reg-photo').value) {
        alert("⚠️ Debes tomar una foto antes de registrar");
        return;
    }

    const btn = document.getElementById('btnSubmitUser');
    const status = document.getElementById('form-status');
    btn.disabled = true;
    status.textContent = 'Enviando datos...';

    // 1. Crear FormData desde el formulario
    const formData = new FormData(this);
    
    // 2. Obtener el rol y definir la SALA (esto quita el Error 400)
    const rol = document.getElementById('reg-cargo').value;
    
    // IMPORTANTE: Tu server.js espera 'sala_permitida' como un campo de texto
    // Si no es Admin, enviamos una sala por defecto o la primera de sus permisos
    const esAdmin = rol.toLowerCase().includes('admin');
    formData.append('sala_permitida', esAdmin ? 'ALL' : 'Recepción'); 
    
    formData.append('empresaId', State.empresaId || 1);

    // 3. Convertir el Base64 de la foto a un archivo real para Multer
    const base64Photo = document.getElementById('reg-photo').value;
    const blob = await fetch(base64Photo).then(r => r.blob());
    formData.set('photo', blob, 'usuario.jpg'); // 'photo' debe coincidir con upload.single('photo')

    try {
        // ENVIAR SOLO AL BACKEND (Sin tocar el ESP32)
        const res = await fetch('/upload', { method: 'POST', body: formData });
        
        if (res.ok) {
            this.reset();
            status.textContent = '';
            openModal('modal-reg');
            if (typeof loadDescriptors === 'function') loadDescriptors(); 
        } else {
            const txt = await res.text();
            status.textContent = '❌ ' + txt;
            status.style.color = 'var(--danger)';
        }
    } catch (err) {
        console.error(err);
        status.textContent = '❌ Error de conexión con el servidor';
        status.style.color = 'var(--danger)';
    } finally {
        btn.disabled = false;
    }
});


document.getElementById('modal-reg-btn').onclick = () => closeModal('modal-reg');
document.getElementById('modal-already-btn').onclick = () => closeModal('modal-already');

// ══════════════════════════════════════════════════════════════
// 13. SALAS
// ══════════════════════════════════════════════════════════════
function renderSalas() {
    const salas = [
        { nombre: "Dashboard", icono: "📊", tipo: "Admin" },
        { nombre: "Recepción", icono: "🚪", tipo: "General" },
        { nombre: "Mantrab", icono: "🧪", tipo: "Operativo", esMantrab: true },
        { nombre: "Sala de comunicaciones", icono: "🏢", tipo: "Admin" },
        { nombre: "Redes", icono: "🌐", tipo: "TI" },
        { nombre: "Servidores", icono: "🗄️", tipo: "TI" },
        { nombre: "Energía", icono: "🔋", tipo: "Infraestructura" },
        { nombre: "UPS", icono: "⚡", tipo: "Infraestructura" },
        { nombre: "NOC", icono: "🖥️", tipo: "Monitoreo" },
        { nombre: "Aire acondicionado", icono: "❄️", tipo: "Infraestructura" }
    ];

    const grid = document.getElementById('salaGrid');
    grid.innerHTML = '';

    salas.forEach(sala => {
        const isAdmin = State.permisos?.admin === true;
        let isLocked = false;

        if (State.permisos && !isAdmin) {
            isLocked = !Array.isArray(State.permisos.salas) ||
                !State.permisos.salas.includes(sala.nombre);
        }

        const btn = document.createElement('button');
        btn.className = 'sala-btn' + (State.sala === sala.nombre ? ' active' : '') + (isLocked ? ' locked' : '');
        btn.dataset.sala = sala.nombre;
        btn.innerHTML = `
                    <span class="sala-ico">${sala.icono}</span>
                    <span class="sala-name">${sala.nombre}</span>
                    <span class="sala-status">● ${isLocked ? 'Bloqueado' : sala.tipo}</span>
                `;
        
        btn.onclick = () => {
    if (isLocked) {
        alert('⛔ No tienes acceso a esta sala');
        return;
    }

    document.querySelectorAll('.sala-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    State.sala = sala.nombre;
    document.getElementById('salaActualLabel').textContent = sala.nombre;
    document.getElementById("btnSalirSala").style.display = "inline-block";

    // 🔥 NUEVO: Si selecciona Mantrab, NO va directo al panel.
    // Solo activa la cámara para identificación. Cuando sea reconocido,
    // handleSuccessMatch detectará State.sala === 'Mantrab' y abrirá el panel.
    if (sala.esMantrab) {
        alert('🔐 Identifíquese frente a la cámara para acceder al sistema Mantrab');
        // Activar cámara automáticamente si no está activa
        if (!State.stream) {
            startCamera();
        }
    }
};
        grid.appendChild(btn);
    });
}

// 🔥 NUEVO: Mostrar Mantrab a PANTALLA COMPLETA
function mostrarPanelMantrab() {
    // Detener cámara principal (la del screen-main)
    try { stopCamera(); } catch (e) { }

    // Cambiar a la pantalla de Mantrab
    showScreen('mantrab');

    // Estado inicial
    State.subPuertaDesbloqueada = false;
    State.puertaActualMantrab = 'principal';

    // Resetear UI
    resetUIMantrabFullscreen();

    // Iniciar cámara de la pantalla Mantrab tras pequeño delay
    setTimeout(() => {
        startCameraMantrab();
    }, 300);

    // Conectar botón "PASAR A SUB-PUERTA"
    const btnPasar = document.getElementById('btnPasarSubpuertaFs');
    if (btnPasar) {
        btnPasar.onclick = () => {
            console.log('▶ Pasando a sub-puerta...');
            State.puertaActualMantrab = 'subpuerta';

            document.getElementById('mantrab-principal-card-fs').classList.remove('active');
            document.getElementById('mantrab-sub-card-fs').classList.add('active');
            document.getElementById('mantrab-sub-card-fs').classList.remove('locked');
            document.getElementById('mantrab-principal-status-fs').textContent = '✅ Completada';
            document.getElementById('mantrab-sub-status-fs').textContent = '🟢 ACTIVA — Identifícate aquí';

            btnPasar.classList.add('hidden');
            alert('✅ Ahora identifíquense en la SUB-PUERTA.');
        };
    }

    // 🔥 Conectar botón "VOLVER A PUERTA PRINCIPAL"
const btnVolverPrincipal = document.getElementById('btnVolverPrincipalFs');
if (btnVolverPrincipal) {
    btnVolverPrincipal.onclick = () => {
        console.log('↩ Volviendo a puerta principal...');
        State.puertaActualMantrab = 'principal';

        // Restaurar UI
        document.getElementById('mantrab-principal-card-fs').classList.add('active');
        document.getElementById('mantrab-sub-card-fs').classList.remove('active');
        document.getElementById('mantrab-principal-status-fs').textContent = '🟢 ACTIVA — Identifíquense aquí';
        document.getElementById('mantrab-sub-status-fs').textContent = '🔒 Bloqueada — completen la principal primero';

        btnVolverPrincipal.classList.add('hidden');

        // 🔥 FIX: LIBERAR los flags que bloquean la detección
        accesoActivo = false;
        State.processing = false;
        State.lastMatchTime = 0;  // resetear cooldown para que pueda matchear de inmediato

        // 🔥 FIX: LIMPIAR el canvas para que no queden cuadros fantasma
        const canvasMantrab = document.getElementById('faceCanvasMantrab');
        if (canvasMantrab) {
            const ctx = canvasMantrab.getContext('2d');
            ctx.clearRect(0, 0, canvasMantrab.width, canvasMantrab.height);
        }

        // 🔥 FIX: Ocultar overlay de mensaje anterior
        const overlayMantrab = document.getElementById('face-overlay-mantrab');
        if (overlayMantrab) overlayMantrab.style.display = 'none';

        alert('↩ De vuelta a la puerta principal. Las personas que faltaron deben identificarse aquí.');
    };
}
    // Conectar botón "REINICIAR"
    const btnReset = document.getElementById('btnResetMantrabFs');
    if (btnReset) {
        btnReset.onclick = async () => {
            if (!confirm('¿Reiniciar la sesión del Mantrab?')) return;
            try {
                await fetch('/mantrap/reset', { method: 'POST' });
                resetUIMantrabFullscreen();
                State.puertaActualMantrab = 'principal';
            } catch (err) {
                alert('❌ Error al reiniciar');
            }
        };
    }

   // Conectar botón "VOLVER A SALAS"
const btnVolver = document.getElementById('btnVolverSalas');
if (btnVolver) {
    btnVolver.onclick = async () => {
        try { await fetch('/mantrap/reset', { method: 'POST' }); } catch (e) { }
        stopCameraMantrab();

        // 🔥 NUEVO: Resetear todo para que el siguiente usuario tenga que identificarse
        State.sala = 'Ingreso';
        State.permisos = null;             // Borrar permisos del usuario actual
        State.puertaActualMantrab = null;
        State.subPuertaDesbloqueada = false;
        State.processing = false;

        // Actualizar UI: salas vuelven a estar todas disponibles (sin bloqueo)
        document.getElementById('salaActualLabel').textContent = '—';
        document.getElementById('btnSalirSala').style.display = 'none';
        renderSalas();   // Re-pintar las cards sin bloqueos

        showScreen('main');
    };
}
}

function ocultarPanelMantrab() {
    // Ya no se usa, queda vacía por compatibilidad
}

// ══════════════════════════════════════════════════════════════
// CÁMARA Y RECONOCIMIENTO EN PANTALLA MANTRAB
// ══════════════════════════════════════════════════════════════
let streamMantrab = null;
let intervalMantrab = null;

async function startCameraMantrab() {
    const videoMantrab = document.getElementById('videoMantrab');
    const canvasMantrab = document.getElementById('faceCanvasMantrab');
    const scanLineMantrab = document.getElementById('scanLineMantrab');

    try {
        streamMantrab = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }
        });
        videoMantrab.srcObject = streamMantrab;
        await videoMantrab.play();
        videoMantrab.style.filter = 'brightness(1.15) contrast(1.1)';
        if (scanLineMantrab) scanLineMantrab.style.display = 'block';

        videoMantrab.addEventListener('loadeddata', () => {
            canvasMantrab.width = videoMantrab.videoWidth;
            canvasMantrab.height = videoMantrab.videoHeight;
            faceapi.matchDimensions(canvasMantrab, {
                width: videoMantrab.videoWidth,
                height: videoMantrab.videoHeight
            });

            if (intervalMantrab) clearInterval(intervalMantrab);
            intervalMantrab = setInterval(() => runFaceDetectionMantrab(), CONFIG.DETECTION_INTERVAL);
            console.log(`🎥 Cámara Mantrab activa: ${videoMantrab.videoWidth}x${videoMantrab.videoHeight}`);
        }, { once: true });

    } catch (err) {
        console.error('Error cámara Mantrab:', err);
        alert('⚠️ Error al acceder a la cámara');
    }
}

function stopCameraMantrab() {
    if (intervalMantrab) { clearInterval(intervalMantrab); intervalMantrab = null; }
    if (streamMantrab) { streamMantrab.getTracks().forEach(t => t.stop()); streamMantrab = null; }
    const videoMantrab = document.getElementById('videoMantrab');
    if (videoMantrab) videoMantrab.srcObject = null;
}

async function runFaceDetectionMantrab() {
    const videoMantrab = document.getElementById('videoMantrab');
    const canvasMantrab = document.getElementById('faceCanvasMantrab');
    const overlayMantrab = document.getElementById('face-overlay-mantrab');

    if (!videoMantrab.readyState || videoMantrab.readyState < 2) return;
    if (!window.faceMatcher) return;
    if (State.processing) return;

    const opts = new faceapi.SsdMobilenetv1Options({ minConfidence: CONFIG.MIN_CONFIDENCE });
    const detections = await faceapi.detectAllFaces(videoMantrab, opts)
        .withFaceLandmarks()
        .withFaceDescriptors();

    const displaySize = { width: videoMantrab.videoWidth, height: videoMantrab.videoHeight };
    const resized = faceapi.resizeResults(detections, displaySize);

    const ctx = canvasMantrab.getContext('2d');
    ctx.clearRect(0, 0, canvasMantrab.width, canvasMantrab.height);
    faceapi.draw.drawDetections(canvasMantrab, resized);

    State.personasDetectadas = resized.length;

    if (resized.length === 0) return;

    const now = Date.now();
    if ((now - State.lastMatchTime) < CONFIG.COOLDOWN_FAIL) return;

    let bestDetection = resized[0];
    if (resized.length > 1) {
        bestDetection = resized.reduce((a, b) =>
            (a.detection.box.area > b.detection.box.area) ? a : b
        );
    }

    const result = window.faceMatcher.findBestMatch(bestDetection.descriptor);
    console.log(`🔍 [MANTRAB] Match: "${result.label}" | Distancia: ${result.distance.toFixed(4)}`);

    if (result.label === 'unknown' || result.distance > CONFIG.FACE_MATCH_THRESHOLD) {
        overlayMantrab.textContent = `❌ No reconocido (d=${result.distance.toFixed(3)})`;
        overlayMantrab.className = 'face-err';
        overlayMantrab.style.display = 'block';
        State.lastMatchTime = now;
        return;
    }

    overlayMantrab.textContent = `✅ ${result.label} (d=${result.distance.toFixed(3)})`;
    overlayMantrab.className = 'face-ok';
    overlayMantrab.style.display = 'block';
    State.lastMatchTime = now;
    State.processing = true;

    try {
        const idRes = await fetch(`/get-user-id?name=${encodeURIComponent(result.label)}&empresaId=${State.empresaId}`);
        if (idRes.ok) {
            const data = await idRes.json();
            const usuarioId = data.id;

            if (State.puertaActualMantrab === 'principal') {
                await procesarMantrabPrincipalFs(usuarioId, result.label);
            } else if (State.puertaActualMantrab === 'subpuerta') {
                await procesarMantrabSubpuertaFs(usuarioId, result.label);
            }
        }
    } catch (err) {
        console.error('Error procesando Mantrab:', err);
        State.processing = false;
    }
}

async function procesarMantrabPrincipalFs(usuarioId, nombreLabel) {
    const personasDetectadas = State.personasDetectadas || 1;

    try {
        const res = await fetch('/mantrap/principal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario_id: usuarioId, personas_detectadas: personasDetectadas })
        });
        const data = await res.json();
        console.log('🚪 Respuesta principal:', data);

        document.getElementById('mantrab-principal-counter-fs').textContent =
            `${data.identificados}/${data.personas_detectadas}`;

        if (data.completo) {
            document.getElementById('mantrab-sub-card-fs').classList.remove('locked');
            document.getElementById('mantrab-sub-card-fs').classList.add('unlocked');
            document.getElementById('mantrab-sub-status-fs').textContent = '🔓 Desbloqueada — listos para pasar';
            document.getElementById('btnPasarSubpuertaFs').classList.remove('hidden');
        }

        document.getElementById('btnResetMantrabFs').classList.remove('hidden');

    } catch (err) {
        console.error('Error principal:', err);
    }

    setTimeout(() => { State.processing = false; }, 1500);
}

async function procesarMantrabSubpuertaFs(usuarioId, nombreLabel) {
    try {
        const res = await fetch('/mantrap/subpuerta', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuario_id: usuarioId })
        });
        const data = await res.json();
        console.log('🔒 Respuesta subpuerta:', data);

        if (data.identificados_subpuerta !== undefined) {
            document.getElementById('mantrab-sub-counter-fs').textContent =
                `${data.identificados_subpuerta}/${data.personas_detectadas}`;
        }

        if (data.autorizado) {
            stopCameraMantrab();
            document.getElementById('modal-ok-body').innerHTML =
                `<strong>🟢 ACCESO AUTORIZADO</strong><br>
                Todos identificados correctamente.<br>
                Puerta abriéndose...<br>
                <span style="font-size:.72rem;color:var(--muted);">${new Date().toLocaleTimeString()}</span>`;
            openModal('modal-ok');

            setTimeout(() => {
                resetUIMantrabFullscreen();
                State.processing = false;
            }, 2000);

       } else if (data.codigo === 'NOT_IN_PRINCIPAL') {
    // Pausar la cámara para que no siga identificando en bucle
    accesoActivo = true;
    
    // Mostrar botón para regresar a principal
    document.getElementById('btnVolverPrincipalFs').classList.remove('hidden');
    
    alert(`⛔ ACCESO DENEGADO\n\n${nombreLabel}, usted no se identificó en la puerta principal.\nPresione "VOLVER A PUERTA PRINCIPAL" para identificarse.`);
    
    // NO reanudamos State.processing — el botón "Volver a puerta principal" se encarga
} else if (data.codigo === 'PRINCIPAL_INCOMPLETE') {
    // Pausar la cámara para que no siga identificando
    accesoActivo = true;  // bloquea la detección
    
    document.getElementById('btnVolverPrincipalFs').classList.remove('hidden');
    
    alert(`⛔ ACCESO DENEGADO\n\n${data.motivo}\n\nPresione "VOLVER A PUERTA PRINCIPAL" para que los que faltaron se identifiquen.`);
    
    // NO reanudamos State.processing aquí — solo se reanuda al presionar el botón
} else {
            setTimeout(() => { State.processing = false; }, 1500);
        }

    } catch (err) {
        console.error('Error subpuerta:', err);
        State.processing = false;
    }
}

function resetUIMantrabFullscreen() {
    State.puertaActualMantrab = 'principal';
    State.subPuertaDesbloqueada = false;
    State.personasDetectadas = 0;

    document.getElementById('mantrab-principal-counter-fs').textContent = '0/0';
    document.getElementById('mantrab-sub-counter-fs').textContent = '0/0';

    document.getElementById('mantrab-principal-card-fs').classList.add('active');
    document.getElementById('mantrab-sub-card-fs').classList.remove('active', 'unlocked');
    document.getElementById('mantrab-sub-card-fs').classList.add('locked');

    document.getElementById('mantrab-principal-status-fs').textContent = '🟢 ACTIVA — Identifícate aquí';
    document.getElementById('mantrab-sub-status-fs').textContent = '🔒 Bloqueada — pasa primero por la principal';

    document.getElementById('btnPasarSubpuertaFs').classList.add('hidden');
document.getElementById('btnResetMantrabFs').classList.add('hidden');
document.getElementById('btnVolverPrincipalFs').classList.add('hidden');  // ← NUEVA

    closeModal('modal-ok');
}

//////////////////////////////////////////////
//Tomar foto en formulario//////////////////////

document.getElementById('btnCaptureMain').onclick = () => {
    const video = document.getElementById('video');

    if (!video || video.videoWidth === 0) {
        alert("⚠️ Primero activa la cámara");
        return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;

    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, 0, 0);

    const base64 = canvas.toDataURL('image/jpeg', 0.8);

    document.getElementById('reg-photo').value = base64;

    alert("✅ Foto capturada correctamente");
};

//////////////////////////////////////////////////////////////



function obtenerPermisosPorRol(rol) {

    // 🔥 ADMIN = ACCESO TOTAL AUTOMÁTICO
    if (rol === "Admin") {
        return {
            admin: true,
            salas: [
                "Dashboard",
                "Recepción",
                "Mantrab",
                "Sala de comunicaciones",
                "Redes",
                "Servidores",
                "Energía",
                "UPS",
                "NOC",
                "Aire acondicionado"
            ]
        };
    }

    switch (rol) {

        case "Recepcionista":
            return {
                admin: false,
                salas: ["Recepción"]
            };

        case "Operador":
            return {
                admin: false,
                salas: ["Mantrab"]
            };

        case "TI":
            return {
                admin: false,
                salas: ["Redes", "Servidores", "NOC"]
            };

        case "Infraestructura":
            return {
                admin: false,
                salas: ["Energía", "UPS", "Aire acondicionado"]
            };

        default:
            return {
                admin: false,
                salas: ["Recepción"]
            };
    }
}



function salirSistema() {
    try {
        stopCamera();
    } catch (e) { }

    // 🔥 NUEVO: Si estaba en Mantrab, resetear la sesión en el backend
    if (State.sala === 'Mantrab') {
        fetch('/mantrap/reset', { method: 'POST' }).catch(() => { });
    }

    window.location.href = "index.html";
}


function procesarAccesoESP32(nombreLabel, distancia) {
    console.log("🔥 PROCESANDO ACCESO ESP32");

    addLog(nombreLabel, State.sala, 'CONCEDIDO', distancia);

    console.log("📡 Simulación envío a ESP32...");

    fetch("http://192.168.1.100/abrir")
        .then(() => console.log("🚀 ESP32 activado"))
        .catch(() => {
            console.warn("⚠️ ESP32 no disponible (modo simulación)");
        });
}
// ══════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
    renderSalas();
    await initEmpresas();
    //startCamera(); // Auto-activar cámara
});
