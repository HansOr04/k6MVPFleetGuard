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
export default function () {
  const plate         = generateUniquePlate();
  const vehicleTypeId = VEHICLE_TYPE_IDS.SEDAN;
  const ruleName      = `AsyncRule-VU${__VU}-IT${__ITER}`;

  log(`[async-delay] Iniciando medición — placa: ${plate}`);

  // ── SETUP: Registrar vehículo ──────────────────────────────────
  const vehiclePayload = JSON.stringify(buildVehiclePayload(plate, vehicleTypeId));
  const vehicleRes     = http.post(FLEET_ENDPOINTS.vehicles, vehiclePayload, JSON_HEADERS);

  if (!checkStatusAndDuration(vehicleRes, 201, 5000, '[setup] POST /api/vehicles')) {
    log(`Setup fallido — no se pudo registrar vehículo: ${vehicleRes.status}`, 'error');
    alertFound.add(false);
    return;
  }

  // ── SETUP: Crear regla de mantenimiento (umbral: 1000 km) ──────
  const rulePayload = JSON.stringify(buildMaintenanceRulePayload(ruleName, 1000));
  const ruleRes     = http.post(RULES_ENDPOINTS.maintenanceRules, rulePayload, JSON_HEADERS);

  if (!checkStatusAndDuration(ruleRes, 201, 5000, '[setup] POST /api/maintenance-rules')) {
    log(`Setup fallido — no se pudo crear regla: ${ruleRes.status}`, 'error');
    alertFound.add(false);
    return;
  }

  const ruleBody = parseJsonSafe(ruleRes);
  const ruleId   = ruleBody?.id;
  if (!ruleId) {
    log(`Setup fallido — no se obtuvo ruleId del response: ${ruleRes.body}`, 'error');
    alertFound.add(false);
    return;
  }

  // ── SETUP: Asociar regla al tipo de vehículo ───────────────────
  const assocPayload = JSON.stringify(buildVehicleTypeAssociationPayload(vehicleTypeId));
  const assocRes     = http.post(RULES_ENDPOINTS.ruleVehicleTypes(ruleId), assocPayload, JSON_HEADERS);
  checkStatusAndDuration(assocRes, 200, 5000, '[setup] POST /api/maintenance-rules/{id}/vehicle-types');

  // Pequeña pausa para asegurar que el setup está persistido
  sleep(0.3);

  // ─────────────────────────────────────────────────────────────────
  // ⭐ MEDICIÓN DEL DELAY RABBITMQ
  // ─────────────────────────────────────────────────────────────────

  // t0: Capturar timestamp ANTES del POST /mileage
  const t0 = Date.now();

  // POST /mileage — 5000 km supera el umbral de 1000 km → MileageRegistered event
  const mileagePayload = JSON.stringify(buildMileagePayload(5000));
  const mileageRes     = http.post(FLEET_ENDPOINTS.mileage(plate), mileagePayload, JSON_HEADERS);

  if (!checkStatusAndDuration(mileageRes, 200, 5000, '[measure] POST /api/vehicles/{plate}/mileage')) {
    log(`Medición fallida — mileage request falló: ${mileageRes.status}`, 'error');
    alertFound.add(false);
    return;
  }

  // t1: El evento MileageRegistered fue publicado (confirmación HTTP recibida)
  const t1 = Date.now();
  log(`[async-delay] Evento publicado en ${t1 - t0}ms — iniciando polling de alerta`);

  // ── POLLING: Esperar a que aparezca la alerta ──────────────────
  const maxWaitMs      = TIMEOUTS.asyncAlertMaxWaitMs;  // 15 segundos máximo
  const pollingMs      = TIMEOUTS.asyncPollingIntervalMs; // cada 500ms
  const pollingSeconds = pollingMs / 1000;

  let alertDelayMs = -1;
  let attempts     = 0;
  let found        = false;

  while (Date.now() - t0 < maxWaitMs) {
    attempts++;

    // Calcular el elapsed ANTES del GET para mejor precisión
    const nowBeforeGet = Date.now();

    const alertsRes = http.get(RULES_ENDPOINTS.alertsPending, JSON_HEADERS);

    // Verificar que el endpoint responde
    check(alertsRes, {
      '[poll] GET /api/alerts responde 200': (r) => r.status === 200,
    });

    if (alertsRes.status === 200) {
      const alertsBody = parseJsonSafe(alertsRes);
      // El body puede ser un array o un objeto con content/data
      const alerts = Array.isArray(alertsBody)
        ? alertsBody
        : alertsBody?.content || alertsBody?.data || [];

      // Buscar una alerta que corresponda a nuestra placa
      const ourAlert = alerts.find(
        (a) => a.plate === plate || a.vehiclePlate === plate
      );

      if (ourAlert) {
        // ✅ Alerta encontrada — calcular delay
        alertDelayMs = Date.now() - t0;
        found        = true;

        log(`[async-delay] ✅ Alerta encontrada! Delay: ${alertDelayMs}ms | Intento #${attempts} | Alerta ID: ${ourAlert.id || 'N/A'}`);
        break;
      }
    }

    // No encontrada aún — esperar antes del próximo intento
    sleep(pollingSeconds);
  }

  // ── Registrar resultados en métricas ──────────────────────────
  if (found) {
    rabbitMqDelay.add(alertDelayMs);
    alertFound.add(true);
    pollingAttempts.add(attempts);

    // Check de negocio: el delay debe estar dentro del rango esperado
    check({ delay: alertDelayMs }, {
      'rabbit_mq_delay < 10000ms': (d) => d.delay < 10000,
      'rabbit_mq_delay < 5000ms':  (d) => d.delay < 5000,
      'rabbit_mq_delay < 3000ms':  (d) => d.delay < 3000,
    });
  } else {
    // ❌ Timeout — la alerta no apareció en el tiempo máximo
    alertFound.add(false);
    alertTimeouts.add(1);
    pollingAttempts.add(attempts);
    log(`[async-delay] ❌ TIMEOUT — alerta no encontrada para ${plate} en ${maxWaitMs}ms (${attempts} intentos)`, 'warn');
  }

  // Pausa entre iteraciones
  sleep(1);
}

// ──────────────────────────────────────────────
// Resumen personalizado al finalizar
// ──────────────────────────────────────────────
export function handleSummary(data) {
  const metrics = data.metrics;

  // Delay RabbitMQ
  const delayAvg = metrics['rabbit_mq_delay']?.values?.avg?.toFixed(0)         || 'N/A';
  const delayP50 = metrics['rabbit_mq_delay']?.values['p(50)']?.toFixed(0)     || 'N/A';
  const delayP90 = metrics['rabbit_mq_delay']?.values['p(90)']?.toFixed(0)     || 'N/A';
  const delayP95 = metrics['rabbit_mq_delay']?.values['p(95)']?.toFixed(0)     || 'N/A';
  const delayP99 = metrics['rabbit_mq_delay']?.values['p(99)']?.toFixed(0)     || 'N/A';
  const delayMax = metrics['rabbit_mq_delay']?.values?.max?.toFixed(0)         || 'N/A';
  const delayMin = metrics['rabbit_mq_delay']?.values?.min?.toFixed(0)         || 'N/A';

  // Alertas encontradas
  const foundRate      = ((metrics['alert_found']?.values?.rate || 0) * 100).toFixed(1);
  const timeouts       = metrics['alert_timeout_count']?.values?.count           || 0;
  const avgPolls       = metrics['alert_polling_count']?.values?.avg?.toFixed(1) || '?';
  const totalIter      = (metrics['rabbit_mq_delay']?.values?.count || 0) +
                         parseInt(timeouts, 10);

  // Evaluación
  const slaOk = (
    (metrics['rabbit_mq_delay']?.values['p(95)'] || 99999) < 5000 &&
    (metrics['alert_found']?.values?.rate || 0) > 0.90
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
  if (delayP50 !== 'N/A' && parseInt(delayP50) < 2000) {
    console.log('     ✅ RabbitMQ procesando mensajes rápidamente');
  } else if (delayP50 !== 'N/A' && parseInt(delayP50) < 5000) {
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
