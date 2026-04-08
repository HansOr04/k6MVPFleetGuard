/**
 * load.test.js
 * ─────────────────────────────────────────────────────────────────
 * LOAD TEST — FleetGuard MVP
 * ─────────────────────────────────────────────────────────────────
 *
 * Objetivo: Simular la carga normal esperada en producción y verificar
 *           que el sistema cumple los SLAs definidos.
 *
 * Configuración de VUs (stages):
 *   0 → 10 VUs en 2 min  (ramp-up gradual)
 *   10 VUs por 5 min     (carga sostenida)
 *   10 → 0 VUs en 1 min  (ramp-down)
 *   Total: ~8 minutos
 *
 * Thresholds (SLA):
 *   - p95 de latencia HTTP < 2000ms
 *   - Tasa de errores HTTP < 1%
 *   - Checks exitosos > 95%
 *
 * Ejecución:
 *   k6 run tests/load.test.js
 *   npm run load
 *   k6 run tests/load.test.js --out json=results/load.json
 */

import { sleep } from 'k6';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';
import { runFleetGuardFlow } from '../scenarios/fleetguard-flow.js';

// ──────────────────────────────────────────────
// Configuración del test
// ──────────────────────────────────────────────
export const options = {
  stages: [
    // Ramp-up gradual para no saturar los servicios desde el inicio
    { duration: '2m', target: 10 },
    // Carga sostenida — este es el período de medición principal
    { duration: '5m', target: 10 },
    // Ramp-down limpio
    { duration: '1m', target: 0  },
  ],

  thresholds: {
    // SLA de latencia: p95 debe ser < 2 segundos
    http_req_duration:   ['p(95)<2000'],

    // SLA de errores: máximo 1% de errores HTTP
    http_req_failed:     ['rate<0.01'],

    // Al menos 95% de los checks deben pasar
    checks:              ['rate>0.95'],

    // Tasa de errores de negocio
    biz_error_rate:      ['rate<0.05'],
  },

  tags: {
    test_type: 'load',
    project:   'fleetguard-mvp',
  },
};

// ──────────────────────────────────────────────
// Función principal del VU
// ──────────────────────────────────────────────
export default function () {
  runFleetGuardFlow({
    mileage:           5000,  // Supera la regla de 1000 km → dispara alerta
    sleepBetweenSteps: 0.3,   // 300ms entre requests para simular usuario real
  });

  // Pausa entre iteraciones (think time del usuario)
  sleep(Math.random() * 2 + 1);  // 1-3 segundos aleatorios
}

// ──────────────────────────────────────────────
// Resumen personalizado al finalizar
// ──────────────────────────────────────────────
export function handleSummary(data) {
  const metrics    = data.metrics;
  const p95        = metrics.http_req_duration?.values['p(95)']?.toFixed(0) || '?';
  const errorRate  = ((metrics.http_req_failed?.values?.rate || 0) * 100).toFixed(2);
  const checksRate = ((metrics.checks?.values?.rate || 0) * 100).toFixed(1);
  const rps        = metrics.http_reqs?.values?.rate?.toFixed(2) || '?';

  const slaOk = (
    (metrics.http_req_duration?.values['p(95)'] || 9999) < 2000 &&
    (metrics.http_req_failed?.values?.rate || 1) < 0.01
  );

  console.log('\n' + '═'.repeat(60));
  console.log(`  LOAD TEST — ${slaOk ? '✅ SLA CUMPLIDO' : '❌ SLA FALLIDO'}`);
  console.log('═'.repeat(60));
  console.log(`  Requests/sec:    ${rps} rps`);
  console.log(`  p95 Latencia:    ${p95}ms  (SLA: <2000ms)`);
  console.log(`  Tasa de errores: ${errorRate}%  (SLA: <1%)`);
  console.log(`  Checks:          ${checksRate}%  (SLA: >95%)`);
  console.log('═'.repeat(60) + '\n');

  return {
    stdout: textSummary(data, { indent: '  ', enableColors: true }),
    'results/load-summary.json': JSON.stringify(data, null, 2),
  };
}
