// Descarga los precios oficiales de gasolina de la Comisión Nacional de Energía
// (CNE, antes CRE) y los guarda en archivos pequeños por zona, para que la app
// "Gasolina" pueda mostrar las gasolineras cercanas y sus precios.
//
// Lo corre GitHub Actions una vez al día (ver .github/workflows/actualizar.yml).
// También se puede correr a mano: node actualizar.mjs
//
// Salida (carpeta "salida"):
//   indice.json          { fecha, estaciones, zonas: ["19_-100", ...] }
//   zonas/19_-100.json   { fecha, e: [[nombre, lat, lon, magna, premium, diesel, marca], ...] }
// Cada zona es un cuadro de 1° × 1° (unos 110 km) identificado por la latitud y
// longitud redondeadas hacia abajo.
//
// La CNE no dice la marca (Pemex, Shell, BP…). Se toma de OpenStreetMap
// (© colaboradores de OpenStreetMap, licencia ODbL) buscando la gasolinera que
// está en el mismo lugar. No todas la tienen; entonces la marca va en null.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const URL_LUGARES = 'https://publicacionexterna.azurewebsites.net/publicaciones/places';
const URL_PRECIOS = 'https://publicacionexterna.azurewebsites.net/publicaciones/prices';
const SERVIDORES_OSM = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
];
const CONSULTA_OSM =
  '[out:json][timeout:240];area["ISO3166-1"="MX"][admin_level=2]->.mx;nwr["amenity"="fuel"]["brand"](area.mx);out center tags;';
const DISTANCIA_MAXIMA_M = 80; // a más de esto no se considera la misma gasolinera
const SALIDA = 'salida';

// Mismas marcas escritas de distintas formas en OpenStreetMap.
const MARCAS = {
  pemex: 'Pemex',
  oxxo: 'Oxxo Gas',
  'oxxo gas': 'Oxxo Gas',
  bp: 'BP',
  'british petroleum': 'BP',
  'gasolinera g500': 'G500',
  hidrosima: 'Hidrosina',
  mobil: 'Mobil',
  g500: 'G500',
  shell: 'Shell',
  chevron: 'Chevron',
  arco: 'Arco',
  total: 'TotalEnergies',
  totalenergies: 'TotalEnergies',
  'petro seven': 'Petro-7',
  'petro 7': 'Petro-7',
  'petro-7': 'Petro-7',
  'la gas': 'La Gas',
  lagas: 'La Gas',
  gulf: 'Gulf',
  repsol: 'Repsol',
  valero: 'Valero',
  hidrosina: 'Hidrosina',
  rendichicas: 'Rendichicas',
  akron: 'Akron',
};

function nombreMarca(texto) {
  const limpio = texto.trim();
  const conocida = MARCAS[limpio.toLowerCase()];
  if (conocida) return conocida;
  // Otras marcas se dejan como vienen, salvo cosas que no parecen marca.
  return /[a-z]{2,}/i.test(limpio) && limpio.length <= 25 ? limpio : null;
}

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

/**
 * Gasolineras de México con marca en OpenStreetMap, en una rejilla de ~1 km
 * para buscar rápido. Si OpenStreetMap no responde, se publica sin marcas.
 */
async function leerMarcasOsm() {
  for (const servidor of SERVIDORES_OSM) {
    try {
      const r = await fetch(servidor, {
        method: 'POST',
        headers: { 'User-Agent': 'gasolina-precios (github.com/warehauss/gasolina-precios)' },
        body: new URLSearchParams({ data: CONSULTA_OSM }),
        signal: AbortSignal.timeout(300_000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { elements } = await r.json();
      const rejilla = new Map();
      for (const e of elements) {
        const lat = e.lat ?? e.center?.lat;
        const lon = e.lon ?? e.center?.lon;
        const marca = nombreMarca(e.tags?.brand ?? '');
        if (lat === undefined || lon === undefined || !marca) continue;
        const clave = celda(lat, lon);
        if (!rejilla.has(clave)) rejilla.set(clave, []);
        rejilla.get(clave).push({ lat, lon, marca });
      }
      console.log(`OpenStreetMap: ${elements.length} gasolineras con marca (${servidor})`);
      return rejilla;
    } catch (e) {
      console.warn(`OpenStreetMap no respondió en ${servidor}: ${e.message}`);
    }
  }
  console.warn('Se publica sin marcas.');
  return new Map();
}

const celda = (lat, lon) => `${Math.floor(lat * 100)}_${Math.floor(lon * 100)}`;

function metros(a, b) {
  const dy = (a.lat - b.lat) * 111_320;
  const dx = (a.lon - b.lon) * 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/** Marca de la gasolinera de OpenStreetMap más cercana (a menos de 80 m), o null. */
function buscarMarca(rejilla, lugar) {
  const la = Math.floor(lugar.lat * 100);
  const lo = Math.floor(lugar.lon * 100);
  let mejor = null;
  let distancia = DISTANCIA_MAXIMA_M;
  for (let i = -1; i <= 1; i++) {
    for (let j = -1; j <= 1; j++) {
      for (const e of rejilla.get(`${la + i}_${lo + j}`) ?? []) {
        const d = metros(lugar, e);
        if (d < distancia) {
          distancia = d;
          mejor = e.marca;
        }
      }
    }
  }
  return mejor;
}

const redondear = (n, d) => Math.round(n * 10 ** d) / 10 ** d;

async function main() {
  console.log('Descargando lugares y precios de la CNE…');
  const [xmlLugares, xmlPrecios, marcas] = await Promise.all([
    descargar(URL_LUGARES),
    descargar(URL_PRECIOS),
    leerMarcasOsm(),
  ]);
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
  let conMarca = 0;
  for (const [id, lugar] of lugares) {
    const p = precios.get(id);
    if (!p) continue;
    const clave = `${Math.floor(lugar.lat)}_${Math.floor(lugar.lon)}`;
    if (!zonas.has(clave)) zonas.set(clave, []);
    const marca = buscarMarca(marcas, lugar);
    zonas.get(clave).push([
      lugar.nombre,
      redondear(lugar.lat, 5),
      redondear(lugar.lon, 5),
      p.regular ?? null,
      p.premium ?? null,
      p.diesel ?? null,
      marca,
    ]);
    estaciones++;
    if (marca) conMarca++;
  }
  console.log(`Con marca: ${conMarca} de ${estaciones}.`);

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
