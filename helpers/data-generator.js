/**
 * data-generator.js
 * Generación dinámica de datos de prueba para los tests k6 de FleetGuard.
 *
 * Payloads validados contra los DTOs reales del proyecto:
 *   - fleet-service:          RegisterVehicleRequest, RegisterMileageRequest
 *   - rules-alerts-service:   CreateMaintenanceRuleRequest, AssociateVehicleTypeRequest
 *
 * Garantiza unicidad de placas y VINs entre VUs e iteraciones usando:
 *   - __VU: ID del Virtual User actual
 *   - __ITER: número de iteración actual
 *   - Date.now(): timestamp de alta resolución
 */

import { VEHICLE_TYPE_IDS, VEHICLE_TYPES_ARRAY } from '../config/environments.js';

// ──────────────────────────────────────────────
// Generadores de placas y VINs únicos
// ──────────────────────────────────────────────

/**
 * Genera una placa única para el VU e iteración actuales.
 * Formato corto válido para evitar exceder límites del campo.
 * Ejemplo: FG001-003-A4F7
 *
 * @returns {string} Placa única
 */
export function generatePlate() {
  const vuPadded   = String(__VU).padStart(3, '0');
  const iterPadded = String(__ITER).padStart(3, '0');
  const randomHex  = Math.floor(Math.random() * 0xffff).toString(16).padStart(4, '0');
  return `FG${vuPadded}-${iterPadded}-${randomHex}`.toUpperCase();
}

/**
 * Genera una placa usando timestamp para máxima unicidad.
 * Útil en smoke tests y async-delay donde solo hay 1 VU.
 *
 * @returns {string} Placa basada en timestamp
 */
export function generateUniquePlate() {
  const ts   = Date.now().toString(36).toUpperCase().slice(-5);
  const rand = Math.floor(Math.random() * 999).toString().padStart(3, '0');
  return `FG-${ts}-${rand}`;
}

/**
 * Genera un VIN de exactamente 17 caracteres (requerido por validación del API).
 * Formato: K6[VU][ITER][TIMESTAMP][RANDOM] — siempre 17 chars alfanuméricos.
 *
 * @returns {string} VIN de 17 caracteres
 */
export function generateVin() {
  // Base determinística por VU e ITER
  const base = `K6${String(__VU).padStart(2, '0')}${String(__ITER).padStart(3, '0')}`;
  // Relleno con timestamp y random para garantizar unicidad
  const fill = Date.now().toString(36).toUpperCase() +
               Math.random().toString(36).toUpperCase().slice(2);
  // Truncar/pad a exactamente 17 chars
  const raw = (base + fill).replaceAll(/[^A-Z0-9]/gi, 'X').toUpperCase();
  return raw.slice(0, 17).padEnd(17, 'X');
}

/**
 * Genera un nombre único para una regla de mantenimiento.
 * Incluye un sufijo aleatorio para evitar conflictos entre ejecuciones.
 *
 * @param {string} [prefix='Rule'] - Prefijo identificador del contexto (ej: 'Smoke', 'AsyncRule')
 * @returns {string} Nombre único de regla
 */
export function generateRuleName(prefix = 'Rule') {
  const rand = Math.floor(Math.random() * 0xffff).toString(16).toUpperCase().padStart(4, '0');
  return `${prefix}-VU${__VU}-IT${__ITER}-${rand}`;
}

// ──────────────────────────────────────────────
// Selectores de tipos de vehículo
// ──────────────────────────────────────────────

/**
 * Retorna un tipo de vehículo aleatorio del catálogo seed.
 * @returns {string} UUID de tipo de vehículo
 */
export function randomVehicleTypeId() {
  const idx = Math.floor(Math.random() * VEHICLE_TYPES_ARRAY.length);
  return VEHICLE_TYPES_ARRAY[idx];
}

/**
 * Retorna el tipo Sedán (determinístico).
 * @returns {string} UUID del tipo Sedán
 */
export function sedanTypeId() {
  return VEHICLE_TYPE_IDS.SEDAN;
}

// ──────────────────────────────────────────────
// Constructores de payloads — fleet-service
// ──────────────────────────────────────────────

/**
 * Payload para registrar un nuevo vehículo.
 * Validado contra: RegisterVehicleRequest.java
 *
 * Campos requeridos:
 *   - plate       @NotBlank
 *   - brand       @NotBlank
 *   - model       @NotBlank
 *   - year        @NotNull
 *   - fuelType    @NotBlank
 *   - vin         @NotBlank @Size(min=17, max=17)
 *   - vehicleTypeId @NotNull UUID
 *
 * @param {string} plate - Placa generada
 * @param {string} [vehicleTypeId] - UUID del tipo (default: Sedán)
 * @returns {Object} Payload JSON para POST /api/vehicles
 */
export function buildVehiclePayload(plate, vehicleTypeId = null) {
  return {
    plate:         plate,
    brand:         'Toyota',
    model:         'Corolla',
    year:          2022,
    fuelType:      'GASOLINE',
    vin:           generateVin(),
    vehicleTypeId: vehicleTypeId || sedanTypeId(),
  };
}

/**
 * Payload para registrar kilometraje.
 * Validado contra: RegisterMileageRequest.java
 *
 * Campos requeridos:
 *   - mileageValue  @NotNull Long
 *   - recordedBy    @NotBlank String
 *
 * @param {number} [mileageValue=5000] - Kilometraje a registrar (debe superar intervalKm de la regla)
 * @returns {Object} Payload JSON para POST /api/vehicles/{plate}/mileage
 */
export function buildMileagePayload(mileageValue = 5000) {
  return {
    mileageValue: mileageValue,
    recordedBy:   `k6-vu${__VU}`,
  };
}

// ──────────────────────────────────────────────
// Constructores de payloads — rules-alerts-service
// ──────────────────────────────────────────────

/**
 * Payload para crear una regla de mantenimiento.
 * Validado contra: CreateMaintenanceRuleRequest.java
 *
 * Campos requeridos:
 *   - name              @NotBlank
 *   - maintenanceType   @NotBlank
 *   - intervalKm        @NotNull @Min(1)
 * Campos opcionales:
 *   - warningThresholdKm @Min(1)
 *
 * @param {string} name - Nombre de la regla
 * @param {number} [intervalKm=1000] - Intervalo en km (umbral para disparar alerta)
 * @returns {Object} Payload JSON para POST /api/maintenance-rules
 */
export function buildMaintenanceRulePayload(name, intervalKm = 1000) {
  return {
    name:                name || `Regla-VU${__VU}-IT${__ITER}`,
    maintenanceType:     'OIL_CHANGE',
    intervalKm:          intervalKm,
    warningThresholdKm:  Math.floor(intervalKm * 0.1),  // 10% antes del límite
  };
}

/**
 * Payload para asociar una regla a un tipo de vehículo.
 * Validado contra: AssociateVehicleTypeRequest.java
 *
 * Campos requeridos:
 *   - vehicleTypeId @NotNull UUID
 *
 * @param {string} vehicleTypeId - UUID del tipo de vehículo
 * @returns {Object} Payload JSON para POST /api/maintenance-rules/{id}/vehicle-types
 */
export function buildVehicleTypeAssociationPayload(vehicleTypeId) {
  return {
    vehicleTypeId: vehicleTypeId,
  };
}
