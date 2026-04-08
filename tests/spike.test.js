/**
 * spike.test.js
 * ─────────────────────────────────────────────────────────────────
 * SPIKE TEST — FleetGuard MVP
 * ─────────────────────────────────────────────────────────────────
 *
 * Objetivo: Simular un pico súbito de tráfico y medir la capacidad
 *           del sistema para recuperarse después del pico.
 *
 * Casos de uso reales:
 *   - Una campaña de marketing que atrae tráfico masivo de golpe
 *   - Un proceso batch externo que registra vehículos masivamente
 *   - Una integración que envía eventos simultáneos al iniciar
 *
 * Configuración de VUs (stages):
 *   0 → 2   VUs | 30s   (baseline mínimo)
 *   2 VUs       | 1 min (establecer baseline)
 *   2 → 50  VUs | 10s   ← PICO SÚBITO (rampa muy agresiva)
 *   50 VUs      | 1 min (sostenimiento del pico)
 *   50 → 2  VUs | 10s   ← CAÍDA SÚBITA
 *   2 VUs       | 3 min (período de recuperación — CRUCIAL)
 *   2 → 0   VUs | 30s   (ramp-down final)
 *
 * Métricas clave a observar:
 *   - Latencia durante el pico vs baseline
 *   - Tiempo de recuperación después del pico
 *   - Errores 5xx durante el pico
 *
 * Ejecución:
 *   k6 run tests/spike.test.js
 *   npm run spike
 */

import { sleep } from 'k6';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';
import { runFleetGuardFlow } from '../scenarios/fleetguard-flow.js';

// ──────────────────────────────────────────────
// Configuración del test
// ──────────────────────────────────────────────
export const options = {
  stages: [
    // Fase 1: Baseline — carga mínima para establecer referencia
    { duration: '30s', target: 2  },
    { duration: '1m',  target: 2  },

    // Fase 2: PICO — 10 segundos para llegar a 50 VUs (agresivo)
    { duration: '10s', target: 50 },

    // Fase 3: Sostenimiento del pico — 1 minuto en máxima carga
    { duration: '1m',  target: 50 },

    // Fase 4: CAÍDA — 10 segundos para volver a 2 VUs
    { duration: '10s', target: 2  },

    // Fase 5: Recuperación — período crítico para verificar que el sistema se estabiliza
    { duration: '3m',  target: 2  },

    // Fase 6: Ramp-down final
    { duration: '30s', target: 0  },
  ],

  thresholds: {
    // Durante el spike se esperan latencias altas; el sistema debe recuperarse
    http_req_duration: ['p(95)<8000'],

    // Permitimos hasta 15% de errores durante el pico (realista para spike)
    http_req_failed:   ['rate<0.15'],

    // Al menos 85% de checks deben pasar (incluyendo durante el pico)
    checks:            ['rate>0.85'],
  },

  tags: {
    test_type: 'spike',
    project:   'fleetguard-mvp',
  },
};

// ──────────────────────────────────────────────
// Función principal del VU
// ──────────────────────────────────────────────
export default function () {
  runFleetGuardFlow({
    mileage:           5000,
    sleepBetweenSteps: 0.1,  // Mínimo para maximizar la presión durante el pico
  });

  // Think time muy corto durante el spike
  sleep(Math.random() * 0.5);  // 0-500ms
}

// ──────────────────────────────────────────────
// Resumen personalizado al finalizar
// ──────────────────────────────────────────────
export function handleSummary(data) {
  const metrics   = data.metrics;
  const avgMs     = metrics.http_req_duration?.values?.avg?.toFixed(0)     || '?';
  const p95Ms     = metrics.http_req_duration?.values['p(95)']?.toFixed(0) || '?';
  const maxMs     = metrics.http_req_duration?.values?.max?.toFixed(0)     || '?';
  const errorPct  = ((metrics.http_req_failed?.values?.rate || 0) * 100).toFixed(2);
  const totalReqs = metrics.http_reqs?.values?.count                       || '?';
  const rps       = metrics.http_reqs?.values?.rate?.toFixed(2)            || '?';

  console.log('\n' + '═'.repeat(65));
  console.log('  SPIKE TEST — Análisis de Pico de Tráfico');
  console.log('═'.repeat(65));
  console.log(`  Total requests:  ${totalReqs} | ${rps} rps promedio`);
  console.log('');
  console.log('  Latencia HTTP:');
  console.log(`    avg:  ${avgMs}ms`);
  console.log(`    p95:  ${p95Ms}ms`);
  console.log(`    max:  ${maxMs}ms (esperado alto durante el pico)`);
  console.log('');
  console.log(`  Tasa de errores: ${errorPct}%`);
  console.log('');
  console.log('  📊 Fases críticas a revisar en el output JSON:');
  console.log('     [0-1:30] Baseline    → latencia de referencia');
  console.log('     [1:30-2:40] Pico     → máxima degradación esperada');
  console.log('     [2:40-5:40] Recovery → ¿recupera la latencia baseline?');
  console.log('');
  console.log('  ✅ El sistema pasó el spike si:');
  console.log('     - p95 < 8000ms durante el pico');
  console.log('     - Latencia vuelve a baseline en la fase de recovery');
  console.log('     - Errores < 15%');
  console.log('═'.repeat(65) + '\n');

  return {
    stdout: textSummary(data, { indent: '  ', enableColors: true }),
    'results/spike-summary.json': JSON.stringify(data, null, 2),
  };
}
