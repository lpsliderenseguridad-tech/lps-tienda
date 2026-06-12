// /api/crear-preferencia.js — Vercel Serverless Function
// Crea una preferencia de Checkout Pro. Recibe {items:[{cod,qty}], cliente:{nombre,tel}}
// IMPORTANTE: los precios se recalculan acá leyendo la hoja TIENDA,
// así nadie puede manipular el monto desde el navegador.

// ⚠️ REEMPLAZAR por la MISMA URL CSV de la hoja TIENDA que pusiste en index.html:
const CSV_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vRXITeiYe4R_wUNdwtKC7reDhr7dEX36VYoV3tiHudWwb5GImdEClZPeR59VXZPmd-85KpYX7wWljVh/pub?gid=1551563351&single=true&output=csv';

function splitRow(line) {
  const c = []; let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQ = !inQ;
    else if (ch === ',' && !inQ) { c.push(cur.replace(/^"|"$/g, '').trim()); cur = ''; }
    else cur += ch;
  }
  c.push(cur.replace(/^"|"$/g, '').trim());
  return c;
}
function num(v) {
  if (!v) return 0;
  const s = String(v).replace(/[^\d.,]/g, ''); if (!s) return 0;
  const dc = s.lastIndexOf(','), dp = s.lastIndexOf('.');
  const clean = dc > dp ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  return parseFloat(clean) || 0;
}
const norm = (s) => s.toUpperCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Z_]/g, '');

async function cargarCatalogo() {
  const r = await fetch(CSV_URL + '&t=' + Date.now());
  if (!r.ok) throw new Error('No se pudo leer el catálogo');
  const lines = (await r.text()).trim().split('\n');

  // Detectar encabezados por nombre
  let hi = -1, COL = {};
  for (let i = 0; i < Math.min(5, lines.length); i++) {
    const cells = splitRow(lines[i]).map(norm);
    if (cells.includes('DESCRIPCION') && cells.includes('PRECIO_ONLINE')) {
      hi = i;
      COL = {
        publicar: cells.indexOf('PUBLICAR'), cod: cells.indexOf('COD'),
        desc: cells.indexOf('DESCRIPCION'), online: cells.indexOf('PRECIO_ONLINE'),
      };
      break;
    }
  }
  if (hi < 0) throw new Error('Encabezados de hoja TIENDA no encontrados');

  const mapa = new Map();
  for (let i = hi + 1; i < lines.length; i++) {
    const row = splitRow(lines[i]);
    const g = (x) => (x >= 0 ? (row[x] || '').trim() : '');
    if (g(COL.publicar).toUpperCase() !== 'SI') continue;
    const cod = g(COL.cod), online = num(g(COL.online));
    if (cod && online > 0) mapa.set(cod, { desc: g(COL.desc), online: Math.round(online) });
  }
  return mapa;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Método no permitido' });

  const TOKEN = process.env.MP_ACCESS_TOKEN;
  if (!TOKEN) return res.status(500).json({ error: 'Falta configurar MP_ACCESS_TOKEN en Vercel' });

  try {
    const { items, cliente } = req.body || {};
    if (!Array.isArray(items) || !items.length) return res.status(400).json({ error: 'Carrito vacío' });
    if (items.length > 50) return res.status(400).json({ error: 'Demasiados ítems' });

    const catalogo = await cargarCatalogo();
    const mpItems = [];
    for (const it of items) {
      const p = catalogo.get(String(it.cod));
      const qty = Math.min(Math.max(parseInt(it.qty) || 0, 1), 99);
      if (!p) return res.status(400).json({ error: `Producto ${it.cod} no disponible` });
      mpItems.push({
        id: String(it.cod),
        title: p.desc.slice(0, 120),
        quantity: qty,
        unit_price: p.online,         // precio propio de la hoja TIENDA
        currency_id: 'ARS',
      });
    }

    const orden = 'LPS-' + Date.now();
    const base = `https://${req.headers.host}`;
    const nombre = String(cliente?.nombre || '').slice(0, 80);
    const tel = String(cliente?.tel || '').replace(/\D/g, '').slice(0, 20);

    const pref = {
      items: mpItems,
      external_reference: orden,
      metadata: { cliente_nombre: nombre, cliente_tel: tel },
      payer: { name: nombre },
      back_urls: {
        success: `${base}/gracias.html?estado=aprobado&orden=${orden}`,
        pending: `${base}/gracias.html?estado=pendiente&orden=${orden}`,
        failure: `${base}/gracias.html?estado=fallido&orden=${orden}`,
      },
      auto_return: 'approved',
      notification_url: `${base}/api/webhook-mp`,
      statement_descriptor: 'LPS SEGURIDAD',
    };

    const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(pref),
    });
    const data = await mpRes.json();
    if (!mpRes.ok) {
      console.error('Error MP:', data);
      return res.status(502).json({ error: 'Mercado Pago rechazó la preferencia' });
    }
    return res.status(200).json({ init_point: data.init_point, orden });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'Error interno' });
  }
}
