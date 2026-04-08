/**
 * fleetguard-flow.js
 * Flujo de negocio completo de FleetGuard para pruebas de rendimiento.
 *
 * Este escenario es el CORE compartido por load, stress y spike tests.
 * Implementa el flujo completo:
 *   1. Registrar vehículo (fleet-service)
 *   2. Crear regla de mantenimiento (rules-alerts-service)
 *   3. Asociar regla a tipo de vehículo (rules-alerts-service)
 *   4. Registrar kilometraje alto → dispara evento RabbitMQ (fleet-service)
 *   5. Consultar alertas generadas (rules-alerts-service)
 *
 * Cada VU genera datos únicos para evitar colisiones.
 */

import http from 'k6/http';
import { sleep } from 'k6';
import { FLEET_ENDPOINTS, RULES_ENDPOINTS, TIMEOUTS } from '../config/environments.js';
import {
  generatePlate,
  generateRuleName,
  sedanTypeId,
  buildVehiclePayload,
  buildMileagePayload,
  buildMaintenanceRulePayload,
  buildVehicleTypeAssociationPayload,
} from '../helpers/data-generator.js';
import {
  checkStatusAndDuration,
  checkSuccess,
  parseJsonSafe,
  log,
} from '../helpers/assertions.js';

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
// Flujo principal
// ──────────────────────────────────────────────

/**
 * Ejecuta el flujo completo de FleetGuard.
 * Esta función es invocada como `default function` en los test files.
 *
 * @param {Object} [opts] - Opciones opcionales
 * @param {boolean} [opts.skipRuleCreation=false] - Si true, omite crear regla (usa una ya existente)
 * @param {number} [opts.mileage=5000] - Kilometraje a registrar
 * @param {number} [opts.sleepBetweenSteps=0.5] - Segundos entre steps
 * @returns {Object} Resultado con plate, alertsCreated, etc.
 */
export function runFleetGuardFlow(opts = {}) {
  const {
    mileage           = 5000,
    sleepBetweenSteps = 0.5,
  } = opts;

  const plate         = generatePlate();
  const vehicleTypeId = sedanTypeId();
  const ruleName      = generateRuleName('Rule');

  log(`Iniciando flujo — placa: ${plate}`);

  // ── PASO 1: Registrar vehículo ─────────────────────────────────
  const vehiclePayload = JSON.stringify(buildVehiclePayload(plate, vehicleTypeId));
  const vehicleRes = http.post(FLEET_ENDPOINTS.vehicles, vehiclePayload, JSON_HEADERS);

  const vehicleOk = checkStatusAndDuration(vehicleRes, 201, 3000, 'POST /api/vehicles');
  if (!vehicleOk) {
    log(`Fallo al registrar vehículo ${plate}: ${vehicleRes.status} — ${vehicleRes.body?.substring(0, 200)}`, 'error');
    return { plate, success: false, step: 'register_vehicle' };
  }

  sleep(sleepBetweenSteps);

  // ── PASO 2: Crear regla de mantenimiento ───────────────────────
  const rulePayload = JSON.stringify(buildMaintenanceRulePayload(ruleName, 1000));
  const ruleRes     = http.post(RULES_ENDPOINTS.maintenanceRules, rulePayload, JSON_HEADERS);

  const ruleOk = checkStatusAndDuration(ruleRes, 201, 3000, 'POST /api/maintenance-rules');
  if (!ruleOk) {
    log(`Fallo al crear regla: ${ruleRes.status} — ${ruleRes.body?.substring(0, 200)}`, 'error');
    return { plate, success: false, step: 'create_rule' };
  }

  const ruleBody = parseJsonSafe(ruleRes);
  const ruleId   = ruleBody?.id;
  if (!ruleId) {
    log(`No se pudo obtener ruleId del body: ${ruleRes.body}`, 'warn');
    return { plate, success: false, step: 'parse_rule_id' };
  }

  sleep(sleepBetweenSteps);

  // ── PASO 3: Asociar regla a tipo de vehículo ───────────────────
  const assocPayload = JSON.stringify(buildVehicleTypeAssociationPayload(vehicleTypeId));
  const assocRes     = http.post(RULES_ENDPOINTS.ruleVehicleTypes(ruleId), assocPayload, JSON_HEADERS);

  checkStatusAndDuration(assocRes, 201, 3000, 'POST /api/maintenance-rules/{id}/vehicle-types');

  sleep(sleepBetweenSteps);

  // ── PASO 4: Registrar kilometraje (dispara evento RabbitMQ) ────
  const mileagePayload = JSON.stringify(buildMileagePayload(mileage));
  const mileageRes     = http.post(FLEET_ENDPOINTS.mileage(plate), mileagePayload, JSON_HEADERS);

  const mileageOk = checkStatusAndDuration(mileageRes, 201, 3000, 'POST /api/vehicles/{plate}/mileage');
  if (!mileageOk) {
    log(`Fallo al registrar mileage para ${plate}: ${mileageRes.status}`, 'error');
    return { plate, success: false, step: 'register_mileage' };
  }

  sleep(sleepBetweenSteps);

  // ── PASO 5: Consultar vehículo ─────────────────────────────────
  const getVehicleRes = http.get(FLEET_ENDPOINTS.vehicleByPlate(plate), JSON_HEADERS);
  checkStatusAndDuration(getVehicleRes, 200, 2000, 'GET /api/vehicles/{plate}');

  sleep(sleepBetweenSteps);

  // ── PASO 6: Consultar alertas (verificación post-async) ────────
  // Se espera que el evento RabbitMQ haya sido procesado.
  // En el load/stress test solo verificamos que el endpoint responde;
  // el async-delay.test.js mide el tiempo exacto.
  const alertsRes = http.get(RULES_ENDPOINTS.alertsPending, JSON_HEADERS);
  checkSuccess(alertsRes, 'GET /api/alerts responde 2xx');

  log(`Flujo completado — placa: ${plate}`);

  return {
    plate,
    ruleId,
    success: true,
    alertsStatus: alertsRes.status,
  };
}

/**
 * Flujo simplificado para smoke test.
 * Solo verifica disponibilidad de los endpoints principales.
 */
export function runSmokeFlow() {
  const plate         = generatePlate();
  const vehicleTypeId = sedanTypeId();

  // POST vehicle
  const vehiclePayload = JSON.stringify(buildVehiclePayload(plate, vehicleTypeId));
  const vehicleRes     = http.post(FLEET_ENDPOINTS.vehicles, vehiclePayload, JSON_HEADERS);
  checkStatusAndDuration(vehicleRes, 201, 5000, '[SMOKE] POST /api/vehicles');

  if (vehicleRes.status !== 201) return;

  // GET vehicle
  const getRes = http.get(FLEET_ENDPOINTS.vehicleByPlate(plate), JSON_HEADERS);
  checkStatusAndDuration(getRes, 200, 3000, '[SMOKE] GET /api/vehicles/{plate}');

  // POST mileage
  const mileagePayload = JSON.stringify(buildMileagePayload(100));
  const mileageRes     = http.post(FLEET_ENDPOINTS.mileage(plate), mileagePayload, JSON_HEADERS);
  checkStatusAndDuration(mileageRes, 201, 3000, '[SMOKE] POST /api/vehicles/{plate}/mileage');

  // POST maintenance rule
  const rulePayload = JSON.stringify(buildMaintenanceRulePayload(generateRuleName('Smoke'), 50000));
  const ruleRes     = http.post(RULES_ENDPOINTS.maintenanceRules, rulePayload, JSON_HEADERS);
  checkStatusAndDuration(ruleRes, 201, 3000, '[SMOKE] POST /api/maintenance-rules');

  // GET alerts
  const alertsRes = http.get(RULES_ENDPOINTS.alertsPending, JSON_HEADERS);
  checkStatusAndDuration(alertsRes, 200, 3000, '[SMOKE] GET /api/alerts');

  log(`Smoke flow OK — placa: ${plate}`);
}
