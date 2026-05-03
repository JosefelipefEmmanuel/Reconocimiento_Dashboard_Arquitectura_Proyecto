// ======================================================
// ESP32 CLIENT
// Puente entre server.js y el ESP32
// Controla servo, sensores y futuras órdenes de hardware
// ======================================================

const axios = require('axios');

// Cambiá esta IP por la IP real del ESP32
const ESP32_BASE_URL = process.env.ESP32_URL || 'http://192.168.1.100';

class ESP32Client {

    static async abrirPuerta(origen = 'general') {
        try {
            const response = await axios.post(`${ESP32_BASE_URL}/servo/abrir`, {
                origen,
                angulo: 90
            }, {
                timeout: 3000
            });

            console.log('✅ ESP32 abrió puerta:', response.data);

            return {
                ok: true,
                mensaje: 'Puerta abierta por ESP32',
                data: response.data
            };

        } catch (error) {
            console.error('❌ Error conectando al ESP32 para abrir:', error.message);

            return {
                ok: false,
                mensaje: 'No se pudo abrir puerta con ESP32'
            };
        }
    }

    static async cerrarPuerta(origen = 'general') {
        try {
            const response = await axios.post(`${ESP32_BASE_URL}/servo/cerrar`, {
                origen,
                angulo: 0
            }, {
                timeout: 3000
            });

            console.log('✅ ESP32 cerró puerta:', response.data);

            return {
                ok: true,
                mensaje: 'Puerta cerrada por ESP32',
                data: response.data
            };

        } catch (error) {
            console.error('❌ Error conectando al ESP32 para cerrar:', error.message);

            return {
                ok: false,
                mensaje: 'No se pudo cerrar puerta con ESP32'
            };
        }
    }

    static async procesarValidacion(validado, origen = 'general') {
        if (validado === true) {
            return await this.abrirPuerta(origen);
        }

        return await this.cerrarPuerta(origen);
    }

    static async obtenerSensores() {
        try {
            const response = await axios.get(`${ESP32_BASE_URL}/sensores`, {
                timeout: 3000
            });

            return {
                ok: true,
                sensores: response.data
            };

        } catch (error) {
            console.error('❌ Error leyendo sensores ESP32:', error.message);

            return {
                ok: false,
                mensaje: 'No se pudieron leer los sensores'
            };
        }
    }
}

module.exports = ESP32Client;