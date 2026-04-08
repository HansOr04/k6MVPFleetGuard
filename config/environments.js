/**
 * environments.js
 * Configuración de URLs y parámetros por ambiente para las pruebas k6 de FleetGuard.
 *
 * Las variables de entorno tienen prioridad sobre los valores por defecto,
 * permitiendo apuntar a distintos ambientes sin modificar el código.
 *
 * Uso:
 *   k6 run -e FLEET_URL=http://staging:8081 -e RULES_URL=http://staging:8093 tests/load.test.js
 */

// ──────────────────────────────────────────────
// URLs base de los microservicios
// ──────────────────────────────────────────────
export const FLEET_BASE_URL = __ENV.FLEET_URL || 'http://localhost:8081';
export const RULES_BASE_URL = __ENV.RULES_URL || 'http://localhost:8093';

// ──────────────────────────────────────────────
// Endpoints fleet-service
// ──────────────────────────────────────────────
export const FLEET_ENDPOINTS = {
  vehicles:         `${FLEET_BASE_URL}/api/vehicles`,
  vehicleByPlate:   (plate) => `${FLEET_BASE_URL}/api/vehicles/${plate}`,
  mileage:          (plate) => `${FLEET_BASE_URL}/api/vehicles/${plate}/mileage`,
};

// ──────────────────────────────────────────────
// Endpoints rules-alerts-service
// ──────────────────────────────────────────────
export const RULES_ENDPOINTS = {
  maintenanceRules:         `${RULES_BASE_URL}/api/maintenance-rules`,
  ruleVehicleTypes:         (ruleId) => `${RULES_BASE_URL}/api/maintenance-rules/${ruleId}/vehicle-types`,
  maintenance:              (plate)  => `${RULES_BASE_URL}/api/maintenance/${plate}`,
  alerts:                   `${RULES_BASE_URL}/api/alerts`,
  alertsPending:            `${RULES_BASE_URL}/api/alerts?status=PENDING`,
};

// ──────────────────────────────────────────────
// Datos semilla (Flyway V2) — IDs de tipos de vehículo
// ──────────────────────────────────────────────
export const VEHICLE_TYPE_IDS = {
  SEDAN:  'c1a1d13e-b3df-4fab-9584-890b852d5311',
  SUV:    'c1a1d13e-b3df-4fab-9584-890b852d5313',
  PICKUP: 'c1a1d13e-b3df-4fab-9584-890b852d5315',
};

export const VEHICLE_TYPES_ARRAY = Object.values(VEHICLE_TYPE_IDS);

// ──────────────────────────────────────────────
// Configuración de timeouts y delays
// ──────────────────────────────────────────────
export const TIMEOUTS = {
  // Timeout HTTP por defecto para todas las peticiones
  httpRequest: '10s',

  // Tiempo máximo esperado para que aparezca la alerta (flujo async RabbitMQ)
  asyncAlertMaxWaitMs: 15000,

  // Intervalo de polling para verificar alertas en async-delay test
  asyncPollingIntervalMs: 500,
};

// ──────────────────────────────────────────────
// Thresholds compartidos (referencia para tests)
// ──────────────────────────────────────────────
export const THRESHOLD_DEFAULTS = {
  // Latencia HTTP aceptable en carga normal
  http_req_duration_p95_load: 2000,

  // Latencia HTTP aceptable en stress (más permisiva)
  http_req_duration_p95_stress: 5000,

  // Tasa de error máxima aceptable
  http_req_failed_rate: 0.01,

  // Delay RabbitMQ máximo esperado en p95
  rabbit_mq_delay_p95: 5000,
};
