/**
 * stress.test.js
 * ─────────────────────────────────────────────────────────────────
 * STRESS TEST — FleetGuard MVP
 * ─────────────────────────────────────────────────────────────────
 *
 * Objetivo: Determinar el límite de capacidad del sistema aumentando
 *           la carga progresivamente en escalones hasta identificar
 *           el punto de quiebre o degradación significativa.
 *
 * Configuración de VUs (stages):
 *   0 → 5   VUs | 2 min  (baseline)
 *   5 → 10  VUs | 2 min  (carga baja)
 *   10 → 20 VUs | 2 min  (carga media)
 *   20 → 40 VUs | 2 min  (carga alta)
 *   40 → 60 VUs | 2 min  (stress)
 *   60 → 0  VUs | 2 min  (ramp-down)
 *   Total: ~12 minutos
 *
 * Thresholds (más permisivos que load — buscamos el límite):
 *   - p95 de latencia HTTP < 5000ms
 *   - Tasa de errores HTTP < 10%
 *
 * Ejecución:
 *   k6 run tests/stress.test.js
 *   npm run stress
 */

import { sleep } from 'k6';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';
import { runFleetGuardFlow } from '../scenarios/fleetguard-flow.js';

// ──────────────────────────────────────────────
// Configuración del test
// ──────────────────────────────────────────────
export const options = {
  stages: [
    // Escalón 1: Baseline — comportamiento en baja carga
    { duration: '2m', target: 5  },
    // Escalón 2: Carga baja
    { duration: '2m', target: 10 },
    // Escalón 3: Carga media — zona normal de operación
    { duration: '2m', target: 20 },
    // Escalón 4: Carga alta — empezamos a presionar
    { duration: '2m', target: 40 },
    // Escalón 5: Stress — buscamos el punto de quiebre
    { duration: '2m', target: 60 },
    // Ramp-down para ver recuperación
    { duration: '2m', target: 0  },
  ],

  thresholds: {
    // Threshold permisivo — queremos detectar CUÁNDO se degrada, no FALLAR la prueba
    http_req_duration:   ['p(95)<5000'],

    // Hasta 10% de errores antes de considerar que el sistema "cayó"
    http_req_failed:     ['rate<0.10'],

    // Al menos 90% de checks exitosos
    checks:              ['rate>0.90'],
  },

  tags: {
    test_type: 'stress',
    project:   'fleetguard-mvp',
  },
};

// ──────────────────────────────────────────────
// Función principal del VU
// ──────────────────────────────────────────────
export default function () {
  runFleetGuardFlow({
    mileage:           5000,
    sleepBetweenSteps: 0.2,  // Menos pausa para generar más presión
  });

  // Think time más corto en stress para aumentar la presión
  sleep(Math.random() * 1 + 0.5);  // 0.5-1.5 segundos
}

// ──────────────────────────────────────────────
// Resumen personalizado al finalizar
// ──────────────────────────────────────────────
export function handleSummary(data) {
  const metrics   = data.metrics;
  const avgMs     = metrics.http_req_duration?.values?.avg?.toFixed(0)           || '?';
  const p50Ms     = metrics.http_req_duration?.values['p(50)']?.toFixed(0)       || '?';
  const p90Ms     = metrics.http_req_duration?.values['p(90)']?.toFixed(0)       || '?';
  const p95Ms     = metrics.http_req_duration?.values['p(95)']?.toFixed(0)       || '?';
  const p99Ms     = metrics.http_req_duration?.values['p(99)']?.toFixed(0)       || '?';
  const maxMs     = metrics.http_req_duration?.values?.max?.toFixed(0)           || '?';
  const errorPct  = ((metrics.http_req_failed?.values?.rate || 0) * 100).toFixed(2);
  const totalReqs = metrics.http_reqs?.values?.count || '?';
  const rps       = metrics.http_reqs?.values?.rate?.toFixed(2)                  || '?';

  console.log('\n' + '═'.repeat(60));
  console.log('  STRESS TEST — Análisis de Capacidad');
  console.log('═'.repeat(60));
  console.log(`  Total requests:  ${totalReqs} (${rps} rps)`);
  console.log('');
  console.log('  Distribución de latencia HTTP:');
  console.log(`    avg:  ${avgMs}ms`);
  console.log(`    p50:  ${p50Ms}ms`);
  console.log(`    p90:  ${p90Ms}ms`);
  console.log(`    p95:  ${p95Ms}ms`);
  console.log(`    p99:  ${p99Ms}ms`);
  console.log(`    max:  ${maxMs}ms`);
  console.log('');
  console.log(`  Tasa de errores: ${errorPct}%`);
  console.log('');
  console.log('  ℹ️  Revisar el gráfico de VUs vs latencia para');
  console.log('      identificar el punto de quiebre.');
  console.log('═'.repeat(60) + '\n');

  return {
    stdout: textSummary(data, { indent: '  ', enableColors: true }),
    'results/stress-summary.json': JSON.stringify(data, null, 2),
  };
}
