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
    "Ingreso",
    "Laboratorio",
    "Gerencia",
    "Redes",
    "Servidores",
    "UPS",
    "Climatización"
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
    const { name, cedula, cargo, empresaId, sala_permitida } = req.body;

    if (!name || !cedula || !cargo || !empresaId)
        return res.status(400).send('Faltan campos');

    if (!req.file)
        return res.status(400).send('Sin imagen');

    // 🔥 VALIDACIÓN ANTES DE TODO
    const esAdmin = cargo && cargo.toLowerCase().includes('admin');

    if (!esAdmin && !sala_permitida) {
        return res.status(400).send('Debe seleccionar una sala');
    }

    if (!esAdmin && !SALAS_VALIDAS.includes(sala_permitida)) {
        return res.status(400).send('Sala inválida');
    }

    const photo = req.file.buffer;

    db.query(
        'SELECT COUNT(*) AS count FROM tabla_usuarios WHERE cedula = ? AND codigo_empresa = ?',
        [cedula, empresaId],
        (err, result) => {
            if (err) return res.status(500).send('Error');

            if (result[0].count > 0)
                return res.status(400).send('Usuario ya existe');

            // 🔥 DEFINIR ADMIN
            const fijo = esAdmin ? 1 : 0;

            // 🔥 DEFINIR SALA
            const salaFinal = esAdmin ? 'ALL' : sala_permitida;

            db.query(
                `INSERT INTO tabla_usuarios 
                (nombre, cedula, cargo, imagen, codigo_empresa, sala_permitida, fijo) 
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [name, cedula, cargo, photo, empresaId, salaFinal, fijo],
                (err, result) => {
                    if (err) return res.status(500).send('Error BD');

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

            const esAdmin =
                Number(user.fijo) === 1 ||
                user.cargo.toLowerCase().includes('admin');

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
app.post('/register-exit', (req, res) => {
    const { usuarioId, empresaId } = req.body;

    db.query(
        `UPDATE registro
         SET hora_salida = NOW()
         WHERE usuario_id = ? AND empresa_id = ? 
         AND DATE(hora_entrada) = CURDATE()
         AND hora_salida IS NULL`,
        [usuarioId, empresaId],
        (err, result) => {
            if (err) return res.status(500).send('Error');

            if (result.affectedRows === 0)
                return res.status(409).send('No hay entrada');

            res.send('Salida registrada');
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
        'SELECT cargo, fijo, sala_permitida FROM tabla_usuarios WHERE id = ?',
        [usuarioId],
        (err, results) => {

            if (err) return res.status(500).send('Error');

            if (!results.length) {
                return res.json({ admin: false, salas: [] });
            }

            const user = results[0];

            // 🔥 ADMIN (fijo = 1)
            if (Number(user.fijo) === 1 || user.cargo.toLowerCase().includes('admin')) {
                return res.json({
                    admin: true,
                    salas: SALAS_VALIDAS
                });
            }

            // 🔥 USUARIO NORMAL
            return res.json({
                admin: false,
                salas: [user.sala_permitida]
            });
        }
    );
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