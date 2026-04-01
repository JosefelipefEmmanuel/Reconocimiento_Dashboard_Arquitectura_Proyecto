
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
};

// ── HELPERS: PANTALLAS ─────────────────────────────────────────
const screens = {
    main: document.getElementById('screen-main'),
    dashboard: document.getElementById('screen-dashboard'),
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
        State.processing = true;
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
async function handleSuccessMatch(nombreLabel, distancia) {
    accesoActivo = true;
    addLog(nombreLabel, State.sala, 'CONCEDIDO', distancia);
    stopCamera();

    let esAdmin = false;

    try {
        const idRes = await fetch(`/get-user-id?name=${encodeURIComponent(nombreLabel)}&empresaId=${State.empresaId}`);

        if (idRes.ok) {
            const { id: usuarioId, cargo, fijo } = await idRes.json();

            // Guardar permisos siempre
            State.permisos = obtenerPermisosPorRol(cargo || "Empleado");
            console.log("🔐 Permisos cargados:", State.permisos);

            // Actualizar salas en UI
            renderSalas();

            // Verificar admin
            esAdmin = Number(fijo) === 1 || (cargo && cargo.toLowerCase().includes('admin'));

            try {
                const permisosRes = await fetch(`/permisos-usuario?usuarioId=${usuarioId}`);
                if (permisosRes.ok) {
                    const permisos = await permisosRes.json();
                    if (permisos?.admin === true) esAdmin = true;
                }
            } catch (_) { }
        }

    } catch (err) {
        console.warn('No se pudo verificar rol:', err.message);
    }

    // Si quiere entrar al Dashboard
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

    // Para cualquier otra sala: acceso normal
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
document.getElementById('user-form').addEventListener('submit', async function (e) {
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

        { nombre: "Mantrab", icono: "🧪", tipo: "Operativo" },

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
            if (isLocked) { alert('⛔ No tienes acceso a esta sala'); return; }
            document.querySelectorAll('.sala-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            State.sala = sala.nombre;
            document.getElementById('salaActualLabel').textContent = sala.nombre;
        };
        grid.appendChild(btn);
    });
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
// ══════════════════════════════════════════════════════════════
// INIT
// ══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
    renderSalas();
    await initEmpresas();
    //startCamera(); // Auto-activar cámara
});
