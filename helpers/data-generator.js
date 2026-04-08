/**
 * data-generator.js
 * Generación dinámica de datos de prueba para los tests k6 de FleetGuard.
 *
 * Garantiza unicidad de placas entre VUs e iteraciones usando:
 * - __VU: ID del Virtual User actual
 * - __ITER: número de iteración actual
 * - Date.now(): timestamp de alta resolución
 * - Sufijo aleatorio para evitar colisiones en ejecuciones paralelas
 */

import { VEHICLE_TYPE_IDS, VEHICLE_TYPES_ARRAY } from '../config/environments.js';

// ──────────────────────────────────────────────
// Generadores de placas
// ──────────────────────────────────────────────

/**
 * Genera una placa única para el VU e iteración actuales.
 * Formato: FG{VU_ID}-{ITER}-{RANDOM_HEX}
 * Ejemplo: FG12-003-a4f7
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
  const ts   = Date.now().toString(36).toUpperCase();
  const rand = Math.floor(Math.random() * 999).toString().padStart(3, '0');
  return `FG-${ts}-${rand}`;
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
 * Usado cuando se necesita consistencia en los datos.
 * @returns {string} UUID del tipo Sedán
 */
export function sedanTypeId() {
  return VEHICLE_TYPE_IDS.SEDAN;
}

// ──────────────────────────────────────────────
// Constructores de payloads
// ──────────────────────────────────────────────

/**
 * Payload para registrar un nuevo vehículo.
 *
 * @param {string} plate - Placa generada
 * @param {string} [vehicleTypeId] - UUID del tipo (default: aleatorio)
 * @returns {Object} Payload JSON para POST /api/vehicles
 */
export function buildVehiclePayload(plate, vehicleTypeId = null) {
  return {
    plate:         plate,
    vehicleTypeId: vehicleTypeId || randomVehicleTypeId(),
    brand:         'Toyota',
    model:         'Corolla',
    year:          2022,
    initialMileage: 0,
  };
}

/**
 * Payload para registrar kilometraje.
 * Por defecto usa 5000 km para superar cualquier regla de mantenimiento.
 *
 * @param {number} [mileage=5000] - Kilometraje a registrar
 * @returns {Object} Payload JSON para POST /api/vehicles/{plate}/mileage
 */
export function buildMileagePayload(mileage = 5000) {
  return {
    mileage: mileage,
  };
}

/**
 * Payload para crear una regla de mantenimiento.
 * Por defecto crea una regla a 1000 km para facilitar el disparo de alertas.
 *
 * @param {string} name - Nombre de la regla
 * @param {number} [mileageThreshold=1000] - Umbral en km
 * @returns {Object} Payload JSON para POST /api/maintenance-rules
 */
export function buildMaintenanceRulePayload(name, mileageThreshold = 1000) {
  return {
    name:             name || `Regla-VU${__VU}-${Date.now()}`,
    description:      'Regla generada por k6 performance test',
    mileageThreshold: mileageThreshold,
    alertMessage:     'Mantenimiento requerido',
  };
}

/**
 * Payload para asociar una regla a un tipo de vehículo.
 *
 * @param {string} vehicleTypeId - UUID del tipo de vehículo
 * @returns {Object} Payload JSON para POST /api/maintenance-rules/{id}/vehicle-types
 */
export function buildVehicleTypeAssociationPayload(vehicleTypeId) {
  return {
    vehicleTypeId: vehicleTypeId,
  };
}

/**
 * Payload para registrar un mantenimiento completado.
 *
 * @param {string} plate - Placa del vehículo
 * @returns {Object} Payload JSON para POST /api/maintenance/{plate}
 */
export function buildMaintenancePayload(plate) {
  return {
    plate:       plate,
    description: 'Mantenimiento completado — k6 test',
    mileage:     1000,
    date:        new Date().toISOString().split('T')[0],
  };
}
