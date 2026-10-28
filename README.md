# Precios de gasolina (para la app Gasolina)

Cada día a las 7:00 a. m. (hora de la Ciudad de México), GitHub Actions descarga
los precios oficiales que las gasolineras reportan a la Comisión Nacional de
Energía (CNE) y los publica en GitHub Pages, divididos por zona, para que la app
muestre las gasolineras cercanas y sus precios.

- `actualizar.mjs`: descarga y procesa los datos (no necesita instalar nada).
- `.github/workflows/actualizar.yml`: la tarea diaria.
- `ultima-actualizacion.txt`: fecha de la última actualización (la escribe la tarea).

Fuente: datos abiertos de la CNE (antes CRE),
https://publicacionexterna.azurewebsites.net/publicaciones/places y `/prices`.

## Para apagarlo
En GitHub: pestaña **Actions** › **Actualizar precios** › menú **⋯** › **Disable workflow**.
