/**
 * assertions.js
 * Checks y helpers de verificación reutilizables para los tests k6 de FleetGuard.
 *
 * Centraliza la lógica de validación para mantener DRY los archivos de test
 * y tener un único punto de cambio para los thresholds de latencia.
 */

import { check, fail } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// ──────────────────────────────────────────────
// Métricas personalizadas globales
// ──────────────────────────────────────────────

/** Tasa de errores de negocio (distinto a errores HTTP) */
export const bizErrorRate = new Rate('biz_error_rate');

/** Trend del delay RabbitMQ: tiempo entre POST /mileage y creación de alerta */
export const rabbitMqDelay = new Trend('rabbit_mq_delay', true);

/** Trend de duración del flujo completo (registro vehículo → alerta) */
export const fullFlowDuration = new Trend('full_flow_duration', true);

// ──────────────────────────────────────────────
// Helpers de check HTTP
// ──────────────────────────────────────────────

/**
 * Verifica que una respuesta HTTP tenga el status esperado.
 * Registra el resultado en bizErrorRate automáticamente.
 *
 * @param {Object} response - Respuesta de k6 http
 * @param {number} expectedStatus - Código HTTP esperado
 * @param {string} label - Descripción del check (para el reporte)
 * @returns {boolean} true si el check pasó
 */
export function checkStatus(response, expectedStatus, label) {
  const checkLabel = label || `status es ${expectedStatus}`;
  const passed = check(response, {
    [checkLabel]: (r) => r.status === expectedStatus,
  });
  bizErrorRate.add(!passed);
  return passed;
}

/**
 * Verifica que una respuesta HTTP sea exitosa (2xx).
 *
 * @param {Object} response - Respuesta de k6 http
 * @param {string} label - Descripción del check
 * @returns {boolean} true si es 2xx
 */
export function checkSuccess(response, label) {
  const checkLabel = label || 'respuesta exitosa 2xx';
  const passed = check(response, {
    [checkLabel]: (r) => r.status >= 200 && r.status < 300,
  });
  bizErrorRate.add(!passed);
  return passed;
}

/**
 * Verifica status HTTP y tiempo de respuesta juntos.
 *
 * @param {Object} response - Respuesta de k6 http
 * @param {number} expectedStatus - Código HTTP esperado
 * @param {number} maxDurationMs - Tiempo máximo aceptable en ms
 * @param {string} endpoint - Nombre del endpoint (para los labels)
 * @returns {boolean} true si ambos checks pasan
 */
export function checkStatusAndDuration(response, expectedStatus, maxDurationMs, endpoint) {
  const name = endpoint || 'endpoint';
  const passed = check(response, {
    [`[${name}] status ${expectedStatus}`]:   (r) => r.status === expectedStatus,
    [`[${name}] duración < ${maxDurationMs}ms`]: (r) => r.timings.duration < maxDurationMs,
  });
  bizErrorRate.add(!passed);
  return passed;
}

// ──────────────────────────────────────────────
// Helpers de parsing de respuestas
// ──────────────────────────────────────────────

/**
 * Parsea el body JSON de una respuesta de forma segura.
 * Retorna null si el parsing falla, evitando que el test rompa.
 *
 * @param {Object} response - Respuesta de k6 http
 * @returns {Object|null} JSON parseado o null
 */
export function parseJsonSafe(response) {
  try {
    return response.json();
  } catch (e) {
    console.warn(`⚠️  No se pudo parsear JSON del body: ${response.body?.substring(0, 200)}`);
    return null;
  }
}

/**
 * Extrae el campo 'id' del body JSON de una respuesta.
 * Usado para capturar IDs de recursos recién creados.
 *
 * @param {Object} response - Respuesta de k6 http
 * @returns {string|null} El ID o null si no se encontró
 */
export function extractId(response) {
  const body = parseJsonSafe(response);
  return body?.id || null;
}

// ──────────────────────────────────────────────
// Helpers de logging
// ──────────────────────────────────────────────

/**
 * Log formateado con VU e iteración para debugging.
 *
 * @param {string} message - Mensaje a loguear
 * @param {'info'|'warn'|'error'} level - Nivel de log
 */
export function log(message, level = 'info') {
  const prefix = `[VU${__VU}|IT${__ITER}]`;
  if (level === 'error') {
    console.error(`${prefix} ❌ ${message}`);
  } else if (level === 'warn') {
    console.warn(`${prefix} ⚠️  ${message}`);
  } else {
    console.log(`${prefix} ℹ️  ${message}`);
  }
}

/**
 * Aborta el test si una respuesta crítica falla.
 * Usar solo en smoke tests o pasos de setup.
 *
 * @param {Object} response - Respuesta de k6 http
 * @param {number} expectedStatus - Status esperado
 * @param {string} message - Mensaje de error
 */
export function assertCritical(response, expectedStatus, message) {
  if (response.status !== expectedStatus) {
    fail(`${message} — status ${response.status}, body: ${response.body?.substring(0, 300)}`);
  }
}
