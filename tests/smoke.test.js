/**
 * smoke.test.js
 * ─────────────────────────────────────────────────────────────────
 * SMOKE TEST — FleetGuard MVP
 * ─────────────────────────────────────────────────────────────────
 *
 * Objetivo: Validar que todos los endpoints críticos están disponibles
 *           y responden con los status HTTP correctos.
 *
 * Configuración:
 *   - VUs: 1
 *   - Iteraciones: 1
 *   - Duración estimada: ~30s
 *
 * Cuándo usar:
 *   - Antes de cualquier prueba de carga como sanity check
 *   - Después de despliegues para verificar disponibilidad
 *   - En pipelines CI/CD como gate de calidad
 *
 * Ejecución:
 *   k6 run tests/smoke.test.js
 *   npm run smoke
 */

import { sleep } from 'k6';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';
import { runSmokeFlow } from '../scenarios/fleetguard-flow.js';

// ──────────────────────────────────────────────
// Configuración del test
// ──────────────────────────────────────────────
export const options = {
  vus:        1,
  iterations: 1,

  thresholds: {
    // Todos los checks deben pasar
    checks: ['rate==1.0'],

    // Los endpoints deben responder en menos de 5 segundos
    http_req_duration: ['p(95)<5000'],

    // Cero errores HTTP
    http_req_failed: ['rate==0'],
  },

  // Tags para identificar esta ejecución en los reportes
  tags: {
    test_type: 'smoke',
    project:   'fleetguard-mvp',
  },
};

// ──────────────────────────────────────────────
// Función principal del VU
// ──────────────────────────────────────────────
export default function () {
  runSmokeFlow();
  sleep(1);
}

// ──────────────────────────────────────────────
// Resumen personalizado al finalizar
// ──────────────────────────────────────────────
export function handleSummary(data) {
  const passed = data.metrics.checks?.values?.rate === 1;
  const status = passed ? '✅ SMOKE PASSED' : '❌ SMOKE FAILED';

  console.log('\n' + '═'.repeat(60));
  console.log(`  ${status}`);
  console.log('═'.repeat(60));
  console.log(`  Checks:          ${(data.metrics.checks?.values?.rate * 100).toFixed(1)}%`);
  console.log(`  HTTP Errors:     ${data.metrics.http_req_failed?.values?.rate?.toFixed(4) || '0'}`);
  console.log(`  Avg Duration:    ${data.metrics.http_req_duration?.values?.avg?.toFixed(0) || '?'}ms`);
  console.log(`  p95 Duration:    ${data.metrics.http_req_duration?.values['p(95)']?.toFixed(0) || '?'}ms`);
  console.log('═'.repeat(60) + '\n');

  return {
    stdout: textSummary(data, { indent: '  ', enableColors: true }),
  };
}
