// Descarga los precios oficiales de gasolina de la Comisión Nacional de Energía
// (CNE, antes CRE) y los guarda en archivos pequeños por zona, para que la app
// "Gasolina" pueda mostrar las gasolineras cercanas y sus precios.
//
// Lo corre GitHub Actions una vez al día (ver .github/workflows/actualizar.yml).
// También se puede correr a mano: node actualizar.mjs
//
// Salida (carpeta "salida"):
//   indice.json          { fecha, estaciones, zonas: ["19_-100", ...] }
//   zonas/19_-100.json   { fecha, e: [[nombre, lat, lon, magna, premium, diesel], ...] }
// Cada zona es un cuadro de 1° × 1° (unos 110 km) identificado por la latitud y
// longitud redondeadas hacia abajo.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const URL_LUGARES = 'https://publicacionexterna.azurewebsites.net/publicaciones/places';
const URL_PRECIOS = 'https://publicacionexterna.azurewebsites.net/publicaciones/prices';
const SALIDA = 'salida';

async function descargar(url) {
  for (let intento = 1; intento <= 3; intento++) {
    try {
      const respuesta = await fetch(url, { signal: AbortSignal.timeout(120_000) });
      if (!respuesta.ok) throw new Error(`HTTP ${respuesta.status}`);
      return await respuesta.text();
    } catch (e) {
      console.warn(`No se pudo descargar ${url} (intento ${intento}): ${e.message}`);
      if (intento === 3) throw e;
      await new Promise((r) => setTimeout(r, 10_000 * intento));
    }
  }
}

const entidades = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
const decodificar = (s) => s.replace(/&(amp|lt|gt|quot|apos);/g, (m) => entidades[m]).trim();

/** place_id → { nombre, lat, lon } */
function leerLugares(xml) {
  const lugares = new Map();
  const patron = /<place place_id="(\d+)">([\s\S]*?)<\/place>/g;
  for (const [, id, cuerpo] of xml.matchAll(patron)) {
    const nombre = cuerpo.match(/<name>([\s\S]*?)<\/name>/)?.[1];
    const x = Number(cuerpo.match(/<x>([^<]+)<\/x>/)?.[1]);
    const y = Number(cuerpo.match(/<y>([^<]+)<\/y>/)?.[1]);
    // Coordenadas válidas dentro de México (descarta las que vienen en 0 o al revés).
    if (!nombre || !(y > 14 && y < 33) || !(x > -119 && x < -86)) continue;
    lugares.set(id, { nombre: decodificar(nombre), lat: y, lon: x });
  }
  return lugares;
}

/** place_id → { regular, premium, diesel } */
function leerPrecios(xml) {
  const precios = new Map();
  const patron = /<place place_id="(\d+)">([\s\S]*?)<\/place>/g;
  for (const [, id, cuerpo] of xml.matchAll(patron)) {
    const p = {};
    for (const [, tipo, valor] of cuerpo.matchAll(/<gas_price type="(\w+)">([\d.]+)<\/gas_price>/g)) {
      const n = Number(valor);
      if (n > 5 && n < 100) p[tipo] = n; // descarta precios absurdos
    }
    if (Object.keys(p).length) precios.set(id, p);
  }
  return precios;
}

const redondear = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

async function main() {
  console.log('Descargando lugares y precios de la CNE…');
  const [xmlLugares, xmlPrecios] = await Promise.all([descargar(URL_LUGARES), descargar(URL_PRECIOS)]);
  const lugares = leerLugares(xmlLugares);
  const precios = leerPrecios(xmlPrecios);
  console.log(`Lugares: ${lugares.size} · con precio: ${precios.size}`);
  if (lugares.size < 1000 || precios.size < 1000) {
    throw new Error('Llegaron muy pocos datos; no se publica para no borrar los buenos.');
  }

  // Fecha en hora de México ('AAAA-MM-DD').
  const fecha = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Mexico_City' });
  const zonas = new Map();
  let estaciones = 0;
  for (const [id, lugar] of lugares) {
    const p = precios.get(id);
    if (!p) continue;
    const clave = `${Math.floor(lugar.lat)}_${Math.floor(lugar.lon)}`;
    if (!zonas.has(clave)) zonas.set(clave, []);
    zonas.get(clave).push([
      lugar.nombre,
      redondear(lugar.lat, 5),
      redondear(lugar.lon, 5),
      p.regular ?? null,
      p.premium ?? null,
      p.diesel ?? null,
    ]);
    estaciones++;
  }

  await rm(SALIDA, { recursive: true, force: true });
  await mkdir(join(SALIDA, 'zonas'), { recursive: true });
  for (const [clave, e] of zonas) {
    await writeFile(join(SALIDA, 'zonas', `${clave}.json`), JSON.stringify({ fecha, e }));
  }
  await writeFile(
    join(SALIDA, 'indice.json'),
    JSON.stringify({ fecha, estaciones, zonas: [...zonas.keys()].sort() }),
  );
  console.log(`Listo: ${estaciones} gasolineras en ${zonas.size} zonas (${fecha}).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
