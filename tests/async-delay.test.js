/**
 * async-delay.test.js
 * ─────────────────────────────────────────────────────────────────
 * ASYNC DELAY TEST — FleetGuard MVP (RabbitMQ)
 * ─────────────────────────────────────────────────────────────────
 *
 * Objetivo: Medir el delay asíncrono entre:
 *   POST /api/vehicles/{plate}/mileage  →  fleet-service
 *             ↓ (evento MileageRegistered via RabbitMQ)
 *   rules-alerts-service consume y crea la ALERTA
 *
 * Esta es la MÉTRICA CLAVE del sistema. El delay esperado es 1-3s.
 *
 * Metodología de medición:
 *   1. Setup: Crear vehículo + regla de mantenimiento (1000 km)
 *   2. t0: Timestamp antes del POST /mileage
 *   3. POST /mileage con 5000 km (supera el umbral → dispara evento)
 *   4. t1: Timestamp después del POST /mileage (confirmación HTTP)
 *   5. Polling GET /api/alerts?status=PENDING cada 500ms
 *   6. Cuando aparece la alerta: calcula delay = tnow - t0
 *   7. Registra el delay en la Trend metric `rabbit_mq_delay`
 *
 * Métricas personalizadas:
 *   - `rabbit_mq_delay`:       Trend  — delay en ms (LA MÉTRICA PRINCIPAL)
 *   - `alert_found`:           Rate   — % de veces que se encontró la alerta
 *   - `alert_polling_count`:   Trend  — número de polls necesarios por VU
 *
 * Configuración:
 *   - 3 VUs concurrentes (para ver distribución del delay con carga mínima)
 *   - 10 iteraciones por VU (30 mediciones en total)
 *
 * Thresholds:
 *   - rabbit_mq_delay p95 < 5000ms   (alerta en menos de 5 segundos el 95% del tiempo)
 *   - rabbit_mq_delay p50 < 3000ms   (mediana bajo 3 segundos)
 *   - alert_found rate > 90%          (la alerta debe aparecer al menos 90% de las veces)
 *
 * Ejecución:
 *   k6 run tests/async-delay.test.js
 *   npm run async-delay
 */

import http  from 'k6/http';
import { sleep, check } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

import { FLEET_ENDPOINTS, RULES_ENDPOINTS, TIMEOUTS, VEHICLE_TYPE_IDS } from '../config/environments.js';
import {
  generateUniquePlate,
  generateRuleName,
  buildVehiclePayload,
  buildMileagePayload,
  buildMaintenanceRulePayload,
  buildVehicleTypeAssociationPayload,
} from '../helpers/data-generator.js';
import {
  checkStatusAndDuration,
  parseJsonSafe,
  log,
} from '../helpers/assertions.js';

// ──────────────────────────────────────────────
// Métricas personalizadas
// ──────────────────────────────────────────────

/** ⭐ MÉTRICA PRINCIPAL: Delay en ms entre POST /mileage y aparición de la alerta */
const rabbitMqDelay = new Trend('rabbit_mq_delay', true);

/** Rate: ¿Se encontró la alerta dentro del timeout máximo? */
const alertFound = new Rate('alert_found');

/** Trend: Número de intentos de polling necesarios hasta encontrar la alerta */
const pollingAttempts = new Trend('alert_polling_count');

/** Counter: Cuántas veces no apareció la alerta (timeout expirado) */
const alertTimeouts = new Counter('alert_timeout_count');

// ──────────────────────────────────────────────
// Configuración del test
// ──────────────────────────────────────────────
export const options = {
  vus:        3,    // 3 VUs concurrentes para medir distribución del delay
  iterations: 30,   // 30 mediciones totales (10 por VU aproximadamente)

  thresholds: {
    // La alerta debe aparecer en < 5 segundos el 95% del tiempo
    rabbit_mq_delay: [
      'p(95)<5000',
      'p(50)<3000',
    ],

    // La alerta debe encontrarse en al menos el 90% de los casos
    alert_found: ['rate>0.90'],

    // Errores HTTP mínimos (setup)
    http_req_failed: ['rate<0.05'],
  },

  tags: {
    test_type: 'async-delay',
    project:   'fleetguard-mvp',
  },
};

// ──────────────────────────────────────────────
// Headers comunes
// ──────────────────────────────────────────────
const JSON_HEADERS = {
  headers: {
    'Content-Type': 'application/json',
    'Accept':       'application/json',
  },
  timeout: TIMEOUTS.httpRequest,
};

// ──────────────────────────────────────────────
// Función principal del VU
// ──────────────────────────────────────────────
// Polling helper — busca la alerta por vehicleId en la lista global
// ──────────────────────────────────────────────

/**
 * Espera a que aparezca una alerta para el vehicleId dado.
 * @param {string} vehicleId
 * @param {number} t0 - timestamp de inicio (antes del POST mileage)
 * @returns {{ found: boolean, delayMs: number, attempts: number }}
 */
function pollForAlert(vehicleId, t0) {
  const maxWaitMs      = TIMEOUTS.asyncAlertMaxWaitMs;
  const pollingSeconds = TIMEOUTS.asyncPollingIntervalMs / 1000;

  let attempts = 0;

  while (Date.now() - t0 < maxWaitMs) {
    attempts++;

    const alertsRes = http.get(RULES_ENDPOINTS.alertsPending, JSON_HEADERS);
    check(alertsRes, {
      '[poll] GET /api/alerts responde 200': (r) => r.status === 200,
    });

    if (alertsRes.status === 200) {
      const body   = parseJsonSafe(alertsRes);
      const alerts = Array.isArray(body) ? body : body?.content || body?.data || [];
      const hit    = alerts.find((a) => a.vehicleId === vehicleId);

      if (hit) {
        return { found: true, delayMs: Date.now() - t0, attempts };
      }
    }

    sleep(pollingSeconds);
  }

  return { found: false, delayMs: -1, attempts };
}

// ──────────────────────────────────────────────
// Función principal del VU
// ──────────────────────────────────────────────
export default function vuMain() {
  const plate         = generateUniquePlate();
  const vehicleTypeId = VEHICLE_TYPE_IDS.SEDAN;

  log(`[async-delay] Iniciando medición — placa: ${plate}`);

  // ── SETUP: Crear regla de mantenimiento ────────────────────────
  // intervalKm=5000, warningThresholdKm=500 (10%) → PENDING cuando kmRemaining ≤ 500
  const ruleName = generateRuleName('AsyncDelay');
  const ruleRes  = http.post(
    RULES_ENDPOINTS.maintenanceRules,
    JSON.stringify(buildMaintenanceRulePayload(ruleName, 5000)),
    JSON_HEADERS,
  );
  if (!checkStatusAndDuration(ruleRes, 201, 5000, '[setup] POST /api/maintenance-rules')) {
    log(`Setup fallido — regla: ${ruleRes.status} ${ruleRes.body}`, 'error');
    alertFound.add(false);
    return;
  }

  const ruleId = parseJsonSafe(ruleRes)?.id;
  if (!ruleId) {
    log(`Setup fallido — sin ruleId en response: ${ruleRes.body}`, 'error');
    alertFound.add(false);
    return;
  }

  // ── SETUP: Asociar regla al tipo de vehículo ───────────────────
  const assocRes = http.post(
    RULES_ENDPOINTS.ruleVehicleTypes(ruleId),
    JSON.stringify(buildVehicleTypeAssociationPayload(vehicleTypeId)),
    JSON_HEADERS,
  );
  if (!checkStatusAndDuration(assocRes, 201, 5000, '[setup] POST /api/maintenance-rules/{id}/vehicle-types')) {
    log(`Setup fallido — asociación regla-tipo: ${assocRes.status} ${assocRes.body}`, 'error');
    alertFound.add(false);
    return;
  }
  log(`[async-delay] Regla creada: ${ruleName} (id: ${ruleId})`);

  // ── SETUP: Registrar vehículo (tipo SEDAN) ─────────────────────
  const vehicleRes = http.post(
    FLEET_ENDPOINTS.vehicles,
    JSON.stringify(buildVehiclePayload(plate, vehicleTypeId)),
    JSON_HEADERS,
  );
  if (!checkStatusAndDuration(vehicleRes, 201, 5000, '[setup] POST /api/vehicles')) {
    log(`Setup fallido — vehículo: ${vehicleRes.status}`, 'error');
    alertFound.add(false);
    return;
  }

  const vehicleId = parseJsonSafe(vehicleRes)?.id;
  if (!vehicleId) {
    log(`Setup fallido — sin vehicleId en response: ${vehicleRes.body}`, 'error');
    alertFound.add(false);
    return;
  }
  log(`[async-delay] vehicleId: ${vehicleId}`);

  // ── SETUP: Registro warmup de kilometraje ──────────────────────
  // El rules-alerts-service solo genera alertas en actualizaciones (UPDATE),
  // no en el primer registro de un vehículo nuevo (INSERT).
  const warmupRes = http.post(
    FLEET_ENDPOINTS.mileage(plate),
    JSON.stringify(buildMileagePayload(100)),
    JSON_HEADERS,
  );
  if (!checkStatusAndDuration(warmupRes, 201, 5000, '[setup] POST /api/vehicles/{plate}/mileage (warmup)')) {
    log(`Setup fallido — warmup mileage: ${warmupRes.status}`, 'error');
    alertFound.add(false);
    return;
  }
  sleep(0.5);

  // ─────────────────────────────────────────────────────────────────
  // ⭐ MEDICIÓN DEL DELAY RABBITMQ
  // ─────────────────────────────────────────────────────────────────
  const t0 = Date.now();

  // 4700 km → kmRemaining = 5000 - 4700 = 300 ≤ warningThresholdKm(500) → zona PENDING
  const mileageRes = http.post(
    FLEET_ENDPOINTS.mileage(plate),
    JSON.stringify(buildMileagePayload(4700)),
    JSON_HEADERS,
  );
  if (!checkStatusAndDuration(mileageRes, 201, 5000, '[measure] POST /api/vehicles/{plate}/mileage')) {
    log(`Medición fallida — mileage: ${mileageRes.status}`, 'error');
    alertFound.add(false);
    return;
  }

  log(`[async-delay] Evento publicado en ${Date.now() - t0}ms — iniciando polling`);

  // ── POLLING ────────────────────────────────────────────────────
  const { found, delayMs, attempts } = pollForAlert(vehicleId, t0);

  // ── Registrar resultados en métricas ──────────────────────────
  pollingAttempts.add(attempts);

  if (found) {
    rabbitMqDelay.add(delayMs);
    alertFound.add(true);
    log(`[async-delay] ✅ Alerta encontrada! Delay: ${delayMs}ms | Intento #${attempts}`);
    check({ delay: delayMs }, {
      'rabbit_mq_delay < 10000ms': (d) => d.delay < 10000,
      'rabbit_mq_delay < 5000ms':  (d) => d.delay < 5000,
      'rabbit_mq_delay < 3000ms':  (d) => d.delay < 3000,
    });
  } else {
    alertFound.add(false);
    alertTimeouts.add(1);
    log(`[async-delay] ❌ TIMEOUT — vehicleId: ${vehicleId} (${plate}) en ${TIMEOUTS.asyncAlertMaxWaitMs}ms (${attempts} intentos)`, 'warn');
  }

  sleep(1);
}

// ──────────────────────────────────────────────
// Resumen personalizado al finalizar
// ──────────────────────────────────────────────
export function handleSummary(data) {
  const metrics = data.metrics;

  // Delay RabbitMQ
  // Native histogram Trends usan 'med' para la mediana en lugar de 'p(50)'
  const delayVals = metrics['rabbit_mq_delay']?.values || {};
  const delayAvg  = delayVals.avg?.toFixed(0)                                  || 'N/A';
  const delayP50  = (delayVals['p(50)'] ?? delayVals.med)?.toFixed(0)          || 'N/A';
  const delayP90  = delayVals['p(90)']?.toFixed(0)                             || 'N/A';
  const delayP95  = delayVals['p(95)']?.toFixed(0)                             || 'N/A';
  const delayP99  = delayVals['p(99)']?.toFixed(0)                             || 'N/A';
  const delayMax  = delayVals.max?.toFixed(0)                                  || 'N/A';
  const delayMin  = delayVals.min?.toFixed(0)                                  || 'N/A';

  // Alertas encontradas
  const foundRate      = ((metrics['alert_found']?.values?.rate || 0) * 100).toFixed(1);
  const timeouts       = metrics['alert_timeout_count']?.values?.count           || 0;
  const avgPolls       = metrics['alert_polling_count']?.values?.avg?.toFixed(1) || '?';
  // Rate metric expone passes + fails = total iteraciones
  const alertPasses    = metrics['alert_found']?.values?.passes || 0;
  const alertFails     = metrics['alert_found']?.values?.fails  || 0;
  const totalIter      = alertPasses + alertFails;

  // Evaluación
  const slaOk = (
    (metrics['rabbit_mq_delay']?.values['p(95)'] || 99999) < 5000 &&
    (metrics['alert_found']?.values?.rate || 0) > 0.9
  );

  console.log('\n' + '═'.repeat(65));
  console.log(`  ⭐ ASYNC DELAY TEST — RabbitMQ Latency`);
  console.log(`  Flujo: POST /mileage → [MileageRegistered] → alerta`);
  console.log('═'.repeat(65));
  console.log('');
  console.log(`  RESULTADO: ${slaOk ? '✅ DENTRO DEL SLA' : '❌ FUERA DEL SLA'}`);
  console.log('');
  console.log('  📊 Distribución del delay RabbitMQ:');
  console.log(`     min:  ${delayMin}ms`);
  console.log(`     avg:  ${delayAvg}ms`);
  console.log(`     p50:  ${delayP50}ms  ← mediana`);
  console.log(`     p90:  ${delayP90}ms`);
  console.log(`     p95:  ${delayP95}ms  ← SLA objetivo: < 5000ms`);
  console.log(`     p99:  ${delayP99}ms`);
  console.log(`     max:  ${delayMax}ms`);
  console.log('');
  console.log('  📈 Estadísticas de polling:');
  console.log(`     Mediciones:      ${totalIter} total`);
  console.log(`     Alertas found:   ${foundRate}%  (SLA: > 90%)`);
  console.log(`     Timeouts:        ${timeouts}`);
  console.log(`     Polls promedio:  ${avgPolls} intentos por medición`);
  console.log('');
  console.log('  🐰 Interpretación:');
  if (delayP50 !== 'N/A' && Number.parseInt(delayP50) < 2000) {
    console.log('     ✅ RabbitMQ procesando mensajes rápidamente');
  } else if (delayP50 !== 'N/A' && Number.parseInt(delayP50) < 5000) {
    console.log('     ⚠️  RabbitMQ dentro de rango, pero revisar si hay backpressure');
  } else {
    console.log('     ❌ RabbitMQ con alta latencia — revisar consumers y queues');
  }
  console.log('═'.repeat(65) + '\n');

  return {
    stdout: textSummary(data, { indent: '  ', enableColors: true }),
    'results/async-delay-summary.json': JSON.stringify(data, null, 2),
  };
}
