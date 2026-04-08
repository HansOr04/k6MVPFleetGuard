# Directorio para guardar los resultados de las ejecuciones k6

Los archivos JSON y HTML generados aquí NO se guardan en git (ver .gitignore).

## Archivos generados

| Archivo | Descripción |
|---|---|
| `load.json` | Output JSON raw del load test |
| `load-summary.json` | Resumen estadístico del load test |
| `stress.json` | Output JSON raw del stress test |
| `stress-summary.json` | Resumen estadístico del stress test |
| `spike.json` | Output JSON raw del spike test |
| `spike-summary.json` | Resumen estadístico del spike test |
| `async-delay.json` | Output JSON raw del async delay test |
| `async-delay-summary.json` | ⭐ Resumen con métricas RabbitMQ |

## Ver resultados online

Los archivos JSON pueden visualizarse en:
- https://grafana.com/docs/k6/latest/results-output/
- https://app.k6.io (k6 Cloud, requiere cuenta)
