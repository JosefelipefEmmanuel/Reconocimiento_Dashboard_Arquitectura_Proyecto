const express = require('express');
const multer = require('multer');
const path = require('path');
const db = require('./database');

const app = express();
const port = 3001;

// ============================
// MULTER
// ============================
const storage = multer.memoryStorage();
const upload = multer({ storage });

// ============================
// MIDDLEWARE
// ============================
app.use(express.static(path.join(__dirname, '../frontend/public')));
app.use('/models', express.static(path.join(__dirname, '../frontend/public/models')));
app.use(express.json({ limit: '15mb' }));
app.use(express.urlencoded({ extended: true, limit: '15mb' }));

// ============================
// SALAS VALIDAS
// ============================
const SALAS_VALIDAS = [
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
];


// ============================
// INICIO
// ============================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

// ============================
// EMPRESAS
// ============================
app.get('/get-empresas', (req, res) => {
    db.query('SELECT id, nombre FROM empresas ORDER BY nombre ASC', (err, rows) => {
        if (err) return res.status(500).json({ error: 'Error BD' });
        res.json(rows);
    });
});

// ============================
// LABELS
// ============================
app.get('/get-labels', (req, res) => {
    const { empresaId } = req.query;

    db.query(
        'SELECT nombre FROM tabla_usuarios WHERE codigo_empresa = ?',
        [empresaId],
        (err, rows) => {
            if (err) return res.status(500).json({ error: 'Error labels' });

            res.json({
                labels: rows.map(r => r.nombre)
            });
        }
    );
});

// ============================
// IMAGEN
// ============================
app.get('/get-image', (req, res) => {
    const { name, empresaId } = req.query;

    db.query(
        'SELECT imagen FROM tabla_usuarios WHERE nombre = ? AND codigo_empresa = ? LIMIT 1',
        [name, empresaId],
        (err, results) => {
            if (err) return res.status(500).send('Error imagen');

            if (!results.length) return res.status(404).send('No encontrada');

            res.setHeader('Content-Type', 'image/jpeg');
            res.send(results[0].imagen);
        }
    );
});

// ============================
// OBTENER ID USUARIO
// ============================
// ============================
// OBTENER ID USUARIO
// ============================
app.get('/get-user-id', (req, res) => {
    const { name, empresaId } = req.query;

    db.query(
        'SELECT id, cargo, fijo FROM tabla_usuarios WHERE nombre = ? AND codigo_empresa = ? LIMIT 1',
        [name, empresaId],
        (err, results) => {
            if (err) return res.status(500).send('Error');
            if (!results.length) return res.status(404).send('No encontrado');
            res.json(results[0]);
        }
    );
});
// ============================
// SUBIR USUARIO
// ============================
app.post('/upload', upload.single('photo'), (req, res) => {
    const { name, cedula, cargo, empresaId } = req.body;

    if (!name || !cedula || !cargo || !empresaId)
        return res.status(400).send('Faltan campos');

    if (!req.file)
        return res.status(400).send('Sin imagen');

    const photo = req.file.buffer;

    // Detectar si es admin (basado solo en cargo)
    const esAdmin = cargo && cargo.toLowerCase().includes('admin');
    const fijo = esAdmin ? 1 : 0;

    db.query(
        'SELECT COUNT(*) AS count FROM tabla_usuarios WHERE cedula = ? AND codigo_empresa = ?',
        [cedula, empresaId],
        (err, result) => {
            if (err) {
                console.error('❌ Error checking user:', err);
                return res.status(500).send('Error BD');
            }

            if (result[0].count > 0)
                return res.status(400).send('Usuario ya existe');

            db.query(
                `INSERT INTO tabla_usuarios 
                (nombre, cedula, cargo, imagen, codigo_empresa, fijo) 
                VALUES (?, ?, ?, ?, ?, ?)`,
                [name, cedula, cargo, photo, empresaId, fijo],
                (err, result) => {
                    if (err) {
                        console.error('❌ Error insert user:', err);
                        return res.status(500).send('Error BD');
                    }

                    console.log(`✅ Usuario registrado: ${name} (${cargo})`);
                    res.json({ ok: true, id: result.insertId });
                }
            );
        }
    );
});

// ============================
// REGISTRAR ENTRADA
// ============================
app.post('/register-entry', (req, res) => {
    const { usuarioId, empresaId, ubicacion, resultado_autenticacion, foto_intento } = req.body;

    if (!SALAS_VALIDAS.includes(ubicacion))
        return res.status(400).send('Sala inválida');

    // 🔥 VALIDAR PERMISOS DEL USUARIO
    db.query(
        'SELECT cargo, fijo, sala_permitida FROM tabla_usuarios WHERE id = ?',
        [usuarioId],
        (err, results) => {

            if (err) return res.status(500).send('Error');

            if (!results.length)
                return res.status(404).send('Usuario no encontrado');

            const user = results[0];

            const cargo = (user.cargo || "").toLowerCase();

            const esAdmin =
                Number(user.fijo) === 1 ||
                cargo.includes('admin');

            // 🔥 SI NO ES ADMIN → VALIDAR SALA
            if (!esAdmin && user.sala_permitida !== ubicacion) {
                return res.status(403).send('Acceso no permitido a esta sala');
            }

            // 🔥 CONTINÚA NORMAL
            const imageBuffer = foto_intento
                ? Buffer.from(foto_intento.split(',')[1], 'base64')
                : null;

            db.query(
                `INSERT INTO registro 
                (usuario_id, empresa_id, hora_entrada, ubicacion, resultado_autenticacion, foto_intento)
                SELECT ?, ?, NOW(), ?, ?, ?
                FROM DUAL
                WHERE NOT EXISTS (
                    SELECT 1 FROM registro
                    WHERE usuario_id = ? AND empresa_id = ? AND DATE(hora_entrada) = CURDATE()
                )`,
                [usuarioId, empresaId, ubicacion, resultado_autenticacion, imageBuffer, usuarioId, empresaId],
                (err, result) => {

                    if (err) return res.status(500).send('Error');

                    if (result.affectedRows === 0)
                        return res.status(409).send('Ya registrado hoy');

                    res.send('Entrada registrada');
                }
            );
        }
    );
});

// ============================
// REGISTRAR SALIDA
// ============================
// ============================
// REGISTRAR ENTRADA
// ============================
app.post('/register-entry', (req, res) => {
    const { usuarioId, empresaId, ubicacion, resultado_autenticacion, foto_intento } = req.body;

    if (!SALAS_VALIDAS.includes(ubicacion))
        return res.status(400).send('Sala inválida');

    // Validar permisos por CARGO (no por sala_permitida)
    db.query(
        'SELECT cargo, fijo FROM tabla_usuarios WHERE id = ?',
        [usuarioId],
        (err, results) => {

            if (err) return res.status(500).send('Error');

            if (!results.length)
                return res.status(404).send('Usuario no encontrado');

            const user = results[0];
            const cargo = (user.cargo || "").toLowerCase();

            const esAdmin =
                Number(user.fijo) === 1 ||
                cargo.includes('admin');

            // Determinar salas permitidas según cargo
            let salasPermitidas = [];
            if (esAdmin) {
                salasPermitidas = SALAS_VALIDAS;
            } else if (cargo.includes("recepcion")) {
                salasPermitidas = ["Recepción"];
            } else if (cargo.includes("operador")) {
                salasPermitidas = ["Mantrab"];
            } else if (cargo.includes("ti")) {
                salasPermitidas = ["Redes", "Servidores", "NOC"];
            } else if (cargo.includes("infra")) {
                salasPermitidas = ["Energía", "UPS", "Aire acondicionado"];
            } else {
                salasPermitidas = ["Recepción"];
            }

            // Validar acceso
            if (!salasPermitidas.includes(ubicacion)) {
                return res.status(403).send('Acceso no permitido a esta sala');
            }

            // Continuar con el registro
            const imageBuffer = foto_intento
                ? Buffer.from(foto_intento.split(',')[1], 'base64')
                : null;

            db.query(
                `INSERT INTO registro 
                (usuario_id, empresa_id, hora_entrada, ubicacion, resultado_autenticacion, foto_intento)
                SELECT ?, ?, NOW(), ?, ?, ?
                FROM DUAL
                WHERE NOT EXISTS (
                    SELECT 1 FROM registro
                    WHERE usuario_id = ? AND empresa_id = ? AND DATE(hora_entrada) = CURDATE()
                )`,
                [usuarioId, empresaId, ubicacion, resultado_autenticacion, imageBuffer, usuarioId, empresaId],
                (err, result) => {

                    if (err) return res.status(500).send('Error');

                    if (result.affectedRows === 0)
                        return res.status(409).send('Ya registrado hoy');

                    res.send('Entrada registrada');
                }
            );
        }
    );
});

// ============================
// CHECK ENTRY
// ============================
app.get('/check-entry', (req, res) => {
    const { usuarioId, empresaId } = req.query;

    db.query(
        `SELECT 1 FROM registro 
         WHERE usuario_id = ? AND empresa_id = ? 
         AND DATE(hora_entrada) = CURDATE()`,
        [usuarioId, empresaId],
        (err, result) => {
            if (err) return res.status(500).json({ error: true });

            res.json({ entryExists: result.length > 0 });
        }
    );
});

// ============================
// INTENTO FALLIDO (SIN CORREO)
// ============================
app.post('/register-failed-attempt', (req, res) => {
    const { cedula, nombre, empresaId, motivo, fotoIntento } = req.body;

    const imageBuffer = fotoIntento
        ? Buffer.from(fotoIntento.split(',')[1], 'base64')
        : null;

    db.query(
        'INSERT INTO intentos_fallidos (cedula, nombre, empresa_id, motivo, foto_intento) VALUES (?, ?, ?, ?, ?)',
        [cedula, nombre, empresaId, motivo, imageBuffer],
        (err) => {
            if (err) return res.status(500).send('Error');

            console.log("🚨 INTENTO FALLIDO:", nombre, motivo);

            res.send('Intento guardado');
        }
    );
});

// ============================
// LOGIN
// ============================
app.post('/login', (req, res) => {
    const { username, password } = req.body;

    db.query(
        'SELECT * FROM admin_usuarios WHERE username = ? AND password = ?',
        [username, password],
        (err, result) => {
            if (err) return res.status(500).send('Error');

            res.sendStatus(result.length > 0 ? 200 : 401);
        }
    );
});
app.get('/permisos-usuario', (req, res) => {
    const { usuarioId } = req.query;

    db.query(
        'SELECT cargo, fijo FROM tabla_usuarios WHERE id = ?',
        [usuarioId],
        (err, results) => {

            if (err) {
                console.error("❌ ERROR BD permisos:", err);
                return res.status(500).send('Error');
            }

            if (!results.length) {
                return res.json({ admin: false, salas: [] });
            }

            const user = results[0];

            const cargo = user.cargo ? String(user.cargo).toLowerCase() : "";

            const esAdmin =
                Number(user.fijo) === 1 ||
                cargo.includes('admin');

            // 🔥 ADMIN → TODAS LAS SALAS
            if (esAdmin) {
                return res.json({
                    admin: true,
                    salas: SALAS_VALIDAS
                });
            }

            // 🔥 USUARIO NORMAL → solo por rol
            let salas = [];

            if (cargo.includes("recepcion")) salas = ["Recepción"];
            else if (cargo.includes("operador")) salas = ["Mantrab"];
            else if (cargo.includes("ti")) salas = ["Redes", "Servidores", "NOC"];
            else if (cargo.includes("infra")) salas = ["Energía", "UPS", "Aire acondicionado"];
            else salas = ["Recepción"]; // default

            return res.json({
                admin: false,
                salas
            });
        }
    );
});
// ============================
// MANTRAB — DOBLE PUERTA ANTI-TAILGATING
// ============================

// Variable en memoria que guarda la sesión activa del Mantrab.
// Se resetea cuando alguien sale del mantrab o se cancela manualmente.
let sesionMantrab = {
    activa: false,
    personas_detectadas: 0,
    identificados_principal: [],   // IDs de usuarios identificados en puerta principal
    identificados_subpuerta: []    // IDs de usuarios identificados en sub-puerta
};

// ────────────────────────────────────────────────
// POST /mantrap/principal
// Body: { usuario_id, personas_detectadas }
// Registra que un usuario se identificó en la puerta principal.
// La principal SIEMPRE abre (siempre que reconozca a alguien).
// ────────────────────────────────────────────────
app.post('/mantrap/principal', (req, res) => {
    const { usuario_id, personas_detectadas } = req.body;

    if (!usuario_id || personas_detectadas == null) {
        return res.status(400).json({ ok: false, motivo: 'Faltan campos' });
    }

    // Si no hay sesión activa, crear una nueva
    if (!sesionMantrab.activa) {
        sesionMantrab = {
            activa: true,
            personas_detectadas: personas_detectadas,
            identificados_principal: [],
            identificados_subpuerta: []
        };
        console.log(`🆕 Nueva sesión Mantrab — ${personas_detectadas} personas detectadas`);
    } else {
        // Actualizar al máximo de personas detectadas (si ahora ve 3 y antes vio 2)
        sesionMantrab.personas_detectadas = Math.max(
            sesionMantrab.personas_detectadas,
            personas_detectadas
        );
    }

    // Registrar al usuario si no estaba ya
    if (!sesionMantrab.identificados_principal.includes(usuario_id)) {
        sesionMantrab.identificados_principal.push(usuario_id);
    }

    const identificados = sesionMantrab.identificados_principal.length;
    const total = sesionMantrab.personas_detectadas;
    const completo = identificados >= total;

    console.log(`🚪 Mantrab/principal — ${identificados}/${total} ${completo ? '✅' : '⏳'}`);

    res.json({
        ok: true,
        identificados: identificados,
        personas_detectadas: total,
        completo: completo,
        subpuerta_desbloqueada: completo,
        motivo: completo
            ? '✅ Todos identificados. Sub-puerta desbloqueada.'
            : `Identificado. Faltan ${total - identificados} persona(s) por identificarse.`
    });
});

// ────────────────────────────────────────────────
// POST /mantrap/subpuerta
// Body: { usuario_id }
// Valida las reglas anti-tailgating:
//   1) El usuario DEBE haberse identificado en principal
//   2) TODOS los detectados DEBEN haberse identificado en principal
//   3) Cuando todos se identifican en sub-puerta → AUTORIZADO
// ────────────────────────────────────────────────
app.post('/mantrap/subpuerta', (req, res) => {
    const { usuario_id } = req.body;

    if (!usuario_id) {
        return res.status(400).json({ ok: false, motivo: 'Falta usuario_id' });
    }

    // Verificar que hay una sesión activa
    if (!sesionMantrab.activa) {
        return res.status(403).json({
            ok: false,
            autorizado: false,
            codigo: 'NO_SESSION',
            motivo: '⛔ No hay sesión activa. Identifíquese primero en la puerta principal.'
        });
    }

    // REGLA 1: ¿el usuario se identificó en principal?
    if (!sesionMantrab.identificados_principal.includes(usuario_id)) {
        console.log(`🔴 Mantrab/subpuerta — Usuario ${usuario_id} NO estuvo en principal`);
        return res.status(403).json({
            ok: false,
            autorizado: false,
            codigo: 'NOT_IN_PRINCIPAL',
            motivo: '⛔ ACCESO DENEGADO. Usted no se identificó en la puerta principal.'
        });
    }

    // REGLA 2: ¿todos los detectados se identificaron en principal?
    const identificadosPrincipal = sesionMantrab.identificados_principal.length;
    const totalDetectados = sesionMantrab.personas_detectadas;

    if (identificadosPrincipal < totalDetectados) {
        const faltan = totalDetectados - identificadosPrincipal;
        console.log(`🟡 Mantrab/subpuerta — Faltan ${faltan} en principal`);
        return res.status(403).json({
            ok: false,
            autorizado: false,
            codigo: 'PRINCIPAL_INCOMPLETE',
            motivo: `⛔ ACCESO DENEGADO. Hay ${faltan} persona(s) que no se identificó en la puerta principal. Deben volver a identificarse.`,
            identificados_principal: identificadosPrincipal,
            personas_detectadas: totalDetectados
        });
    }

    // Registrar identificación en sub-puerta
    if (!sesionMantrab.identificados_subpuerta.includes(usuario_id)) {
        sesionMantrab.identificados_subpuerta.push(usuario_id);
    }

    const identificadosSub = sesionMantrab.identificados_subpuerta.length;
    const autorizado = identificadosSub >= totalDetectados;

    if (autorizado) {
        console.log(`🟢 Mantrab AUTORIZADO — Todos identificados en ambas puertas`);
        // Resetear sesión porque ya pasaron todos
        const sesionFinal = { ...sesionMantrab };
        sesionMantrab = {
            activa: false,
            personas_detectadas: 0,
            identificados_principal: [],
            identificados_subpuerta: []
        };

        return res.json({
            ok: true,
            autorizado: true,
            codigo: 'AUTHORIZED',
            motivo: '✅ ¡ACCESO AUTORIZADO! Puerta abriéndose.',
            identificados_subpuerta: sesionFinal.identificados_subpuerta.length,
            personas_detectadas: sesionFinal.personas_detectadas
        });
    } else {
        const faltan = totalDetectados - identificadosSub;
        console.log(`🟡 Mantrab/subpuerta — ${identificadosSub}/${totalDetectados} (faltan ${faltan})`);
        return res.json({
            ok: true,
            autorizado: false,
            codigo: 'PARTIAL',
            motivo: `Identificado. Esperando ${faltan} persona(s) más.`,
            identificados_subpuerta: identificadosSub,
            personas_detectadas: totalDetectados
        });
    }
});

// ────────────────────────────────────────────────
// POST /mantrap/reset
// Limpia la sesión activa (al salir del mantrab o cancelar)
// ────────────────────────────────────────────────
app.post('/mantrap/reset', (req, res) => {
    sesionMantrab = {
        activa: false,
        personas_detectadas: 0,
        identificados_principal: [],
        identificados_subpuerta: []
    };
    console.log('🔴 Sesión Mantrab reiniciada');
    res.json({ ok: true });
});

// ────────────────────────────────────────────────
// GET /mantrap/estado
// Devuelve el estado actual de la sesión (para debug / sincronizar UI)
// ────────────────────────────────────────────────
app.get('/mantrap/estado', (req, res) => {
    res.json({
        ok: true,
        ...sesionMantrab,
        principal_completa:
            sesionMantrab.activa &&
            sesionMantrab.identificados_principal.length >= sesionMantrab.personas_detectadas
    });
});
// ============================
// KEEP ALIVE DB
// ============================
setInterval(() => {
    db.query("SELECT 1");
}, 10000);

// ============================
// SERVER
// ============================
app.listen(port, () => {
    console.log(`🚀 Servidor en http://localhost:${port}`);
});