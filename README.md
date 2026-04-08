# 🚀 FleetGuard MVP — Performance Testing con k6

Proyecto independiente de pruebas de rendimiento para el sistema **FleetGuard MVP**, que cubre los dos microservicios REST y mide el delay asíncrono del flujo RabbitMQ.

---

## 🧱 Sistema Bajo Prueba

| Servicio | URL Base |
|---|---|
| `fleet-service` | `http://localhost:8081` |
| `rules-alerts-service` | `http://localhost:8093` |

### Endpoints Cubiertos

**fleet-service:**
- `POST /api/vehicles` — Registrar vehículo
- `POST /api/vehicles/{plate}/mileage` — Registrar kilometraje →  dispara evento RabbitMQ
- `GET /api/vehicles/{plate}` — Consultar vehículo

**rules-alerts-service:**
- `POST /api/maintenance-rules` — Crear regla de mantenimiento
- `POST /api/maintenance-rules/{id}/vehicle-types` — Asociar regla a tipo de vehículo
- `POST /api/maintenance/{plate}` — Registrar mantenimiento
- `GET /api/alerts` — Listar alertas (soporta `?status=PENDING`)

---

## 📂 Estructura del Proyecto

```
k6-fleetguard/
├── README.md
├── package.json
├── .gitignore
│
├── config/
│   └── environments.js          # URLs y configuración por ambiente
│
├── helpers/
│   ├── data-generator.js        # Generación dinámica de placas y datos de prueba
│   └── assertions.js            # Checks y thresholds reutilizables
│
├── scenarios/
│   └── fleetguard-flow.js       # Flujo completo compartido entre pruebas
│
├── tests/
│   ├── smoke.test.js            # Smoke — valida disponibilidad básica (1 VU, 1 iter)
│   ├── load.test.js             # Load — carga normal sostenida (10 VUs, 5 min)
│   ├── stress.test.js           # Stress — carga creciente hasta punto de quiebre
│   ├── spike.test.js            # Spike — pico súbito y recuperación
│   └── async-delay.test.js      # Mide delay RabbitMQ entre POST /mileage y alerta
│
└── results/                     # Outputs JSON de ejecuciones
```

---

## ⚙️ Pre-requisitos

1. **k6** instalado: [https://k6.io/docs/getting-started/installation/](https://k6.io/docs/getting-started/installation/)
2. **Docker Compose** del proyecto FleetGuard corriendo:
   ```bash
   docker compose up -d
   ```
3. (Opcional) **Node.js** para usar los scripts `npm run *`

---

## 🚀 Cómo Ejecutar

### Usando npm

```bash
# Smoke — validación rápida de disponibilidad
npm run smoke

# Load — carga sostenida normal
npm run load

# Stress — carga creciente hasta el límite
npm run stress

# Spike — pico súbito de tráfico
npm run spike

# Async Delay — medir latencia RabbitMQ
npm run async-delay

# Todas las pruebas secuencialmente
npm run all
```

### Directamente con k6

```bash
# Con output JSON para análisis
k6 run tests/load.test.js --out json=results/load.json

# Con resumen HTML (requiere k6-reporter)
k6 run tests/load.test.js --out json=results/load.json

# Con variables de entorno personalizadas
k6 run -e FLEET_URL=http://localhost:8081 -e RULES_URL=http://localhost:8093 tests/load.test.js
```

---

## 📊 Tipos de Prueba

### 🔬 Smoke Test (`smoke.test.js`)
- **Objetivo**: Verificar que los endpoints críticos responden con status 2xx
- **Carga**: 1 VU, 1 iteración
- **Duración**: ~30s
- **Cuándo usar**: Antes de cualquier prueba de carga, como sanity check

### ⚡ Load Test (`load.test.js`)
- **Objetivo**: Simular carga normal esperada en producción
- **Carga**: Ramp up 2 min → 10 VUs por 5 min → Ramp down 1 min
- **Thresholds**: p95 < 2000ms, error rate < 1%
- **Cuándo usar**: Validar el SLA en condiciones normales

### 💥 Stress Test (`stress.test.js`)
- **Objetivo**: Encontrar el punto de quiebre del sistema bajo carga creciente
- **Carga**: Escalones de 5→10→20→40→60 VUs, 2 min cada uno
- **Thresholds**: p95 < 5000ms (permisivo para detectar degradación)
- **Cuándo usar**: Capacity planning, identificar cuellos de botella

### 🌊 Spike Test (`spike.test.js`)
- **Objetivo**: Medir comportamiento ante un pico repentino de tráfico y recuperación
- **Carga**: 2 VUs → 50 VUs en 10s → 2 VUs en 10s
- **Cuándo usar**: Simular eventos de alto tráfico (campañas, integraciones batch)

### 🐇 Async Delay Test (`async-delay.test.js`)
- **Objetivo**: **MÉTRICA CLAVE** — Medir el delay RabbitMQ entre el `POST /mileage` y la creación de la alerta en `rules-alerts-service`
- **Metodología**:
  1. Registra vehículo con placa única
  2. Crea regla de mantenimiento a 1000 km
  3. Registra kilometraje superior al umbral (dispara evento `MileageRegistered`)
  4. Hace polling cada 500ms hasta encontrar la alerta (máx 15s)
  5. Calcula y registra el delay en ms
- **Métrica personalizada**: `rabbit_mq_delay` (Trend)
- **Expected range**: 1000ms – 3000ms

---

## 📈 Métricas Clave

| Métrica | Descripción | Threshold |
|---|---|---|
| `http_req_duration` | Latencia HTTP estándar | p95 < 2000ms (load) |
| `http_req_failed` | Tasa de errores HTTP | < 1% (load) |
| `rabbit_mq_delay` | ⭐ Delay RabbitMQ en ms | p95 < 5000ms |
| `alert_polling_attempts` | Intentos de polling por VU | Informativo |

---

## 🗂️ Datos de Prueba (Seeds)

Los tipos de vehículo están pre-cargados por Flyway:

| Tipo | UUID |
|---|---|
| Sedán | `c1a1d13e-b3df-4fab-9584-890b852d5311` |
| SUV | `c1a1d13e-b3df-4fab-9584-890b852d5313` |
| Pickup | `c1a1d13e-b3df-4fab-9584-890b852d5315` |

Las placas se generan dinámicamente con formato `VU{vuId}-{timestamp}-{random}` para evitar colisiones entre VUs.

---

## 📉 Interpretar Resultados

```
✓ checks.........................: 98.50%  197 out of 200
✓ http_req_duration.............: avg=154ms  p(95)=850ms
✓ rabbit_mq_delay...............: avg=1420ms p(95)=2800ms
✗ http_req_failed...............: 1.50%   3 out of 200
```

- **`rabbit_mq_delay` p95 < 3000ms** → Sistema procesando mensajes MQ en tiempo aceptable
- **`rabbit_mq_delay` p95 > 5000ms** → Revisar configuración de RabbitMQ / consumers

---

## 🛠️ Troubleshooting

### Los servicios no responden
```bash
# Verificar que Docker Compose está corriendo
docker compose ps
docker compose logs fleet-service
docker compose logs rules-alerts-service
```

### Las alertas no aparecen en async-delay
- Verificar que RabbitMQ está corriendo: `http://localhost:15672`
- Revisar los logs de `rules-alerts-service` para ver si consume los eventos
- El umbral de la regla (1000 km) debe ser menor al km registrado (5000 km en la prueba)

### Cambiar URLs de los servicios
```bash
k6 run -e FLEET_URL=http://mi-servidor:8081 -e RULES_URL=http://mi-servidor:8093 tests/load.test.js
```
