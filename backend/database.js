const mysql = require('mysql2');

const pool = mysql.createPool({
    host: 'localhost',
    port: 3306,              // ← AGREGA ESTA LÍNEA
    user: 'root',
    password: '',
    database: 'reconocimiento',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

pool.on('connection', (connection) => {
    console.log('✅ Nueva conexión MySQL establecida');

    connection.on('error', (err) => {
        console.error('Error en conexión MySQL:', err);
        if (err.code === 'PROTOCOL_CONNECTION_LOST') {
            console.log('Reconectando MySQL...');
        }
    });
});

module.exports = pool;