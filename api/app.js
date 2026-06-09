const { sql } = require('@vercel/postgres');
const nodemailer = require('nodemailer');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ADVISEUR_EMAIL = process.env.ADVISEUR_EMAIL || 'info@labelenlens.nl';
const BASE_URL = process.env.BASE_URL || 'https://opdracht.labelenlens.nl';

const CHECKLIST = [
  { k: 'facturen', t: 'Facturen t.b.v. isolatie, verbouwingen, installaties en/of zonnepanelen' },
  { k: 'bouwtek', t: 'Bouwkundige tekeningen op schaal met afmetingen' },
  { k: 'plattegronden', t: 'Met plattegronden' },
  { k: 'gevel', t: 'Gevelaanzichten' },
  { k: 'doorsnede', t: 'Dwarsdoorsnede' },
  { k: 'detailtek', t: 'Detailtekeningen van de bouwkundige constructies van het gebouw' },
  { k: 'installontw', t: 'Installatieontwerp en/of ontwerp- en installatietekeningen (verwarming, koeling en warmtapwater)' },
  { k: 'aanvraagverg', t: 'Aanvraag bouwvergunning inclusief Energieprestatieberekening' },
  { k: 'verleendverg', t: 'Verleende bouwvergunning' },
  { k: 'inregeling', t: 'Verklaring dat de installaties voor ruimteverwarming/tapwater/ruimtekoeling zijn ingeregeld' },
  { k: 'lijstinstall', t: 'Verzamellijsten met de installaties (bijv. type opwekkers voor verwarming/tapwater/koeling)' },
  { k: 'lijstkozijn', t: 'Verzamellijsten met type kozijnen/beglazing' }
];
const FIELD = { naam: [116, 471], adres: [161, 487], postcode: [95, 503], woonplaats: [105, 519], datum: [436, 586] };
const CHECKPOS = {
  facturen: [54, 201], bouwtek: [54, 213], plattegronden: [67, 224], gevel: [67, 235], doorsnede: [67, 245],
  detailtek: [54, 257], installontw: [54, 268], aanvraagverg: [54, 290], verleendverg: [54, 303],
  inregeling: [54, 315], lijstinstall: [54, 337], lijstkozijn: [54, 350], geen: [53, 396]
};

function authToken() { return crypto.createHash('sha256').update(process.env.ADMIN_PASSWORD || 'changeme').digest('hex'); }
function isAuthed(req) {
  const c = req.headers.cookie || '';
  const m = c.match(/(?:^|;\s*)llauth=([a-f0-9]+)/);
  return m && m[1] === authToken();
}
function genCode() {
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = ''; const b = crypto.randomBytes(5);
  for (let i = 0; i < 5; i++) s += a[b[i] % a.length];
  return s;
}
function transporter() {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  });
}
async function ensureTable() {
  await sql`CREATE TABLE IF NOT EXISTS orders (
    code TEXT PRIMARY KEY,
    adres TEXT, postcode TEXT, woonplaats TEXT,
    opdrachtgever_email TEXT,
    naam TEXT, bedrijf TEXT,
    checklist JSONB, geen BOOLEAN DEFAULT false,
    signature TEXT,
    status TEXT DEFAULT 'concept',
    created_at TIMESTAMPTZ DEFAULT now(),
    sent_at TIMESTAMPTZ, opened_at TIMESTAMPTZ, signed_at TIMESTAMPTZ
  )`;
}
function body(req) {
  if (!req.body) return {};
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return req.body;
}

async function buildPdf(o) {
  const bytes = fs.readFileSync(path.join(process.cwd(), 'blank.pdf'));
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPages()[0];
  const H = page.getHeight();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ink = rgb(0.10, 0.12, 0.14), green = rgb(0.247, 0.31, 0.275);
  const txt = (s, x, topB, size) => { if (s) page.drawText(String(s), { x, y: H - topB, size: size || 9, font, color: ink }); };
  txt(o.naam + (o.bedrijf ? '  (' + o.bedrijf + ')' : ''), FIELD.naam[0], FIELD.naam[1]);
  txt(o.adres, FIELD.adres[0], FIELD.adres[1]);
  txt(o.postcode, FIELD.postcode[0], FIELD.postcode[1]);
  txt(o.woonplaats, FIELD.woonplaats[0], FIELD.woonplaats[1]);
  const d = o.signed_at ? new Date(o.signed_at) : new Date();
  txt(d.toLocaleDateString('nl-NL'), FIELD.datum[0], FIELD.datum[1]);
  const check = (x0, top) => {
    page.drawLine({ start: { x: x0 + 0.6, y: H - (top + 5.2) }, end: { x: x0 + 2.1, y: H - (top + 7.4) }, thickness: 1.2, color: green });
    page.drawLine({ start: { x: x0 + 2.1, y: H - (top + 7.4) }, end: { x: x0 + 5.2, y: H - (top + 1.6) }, thickness: 1.2, color: green });
  };
  const checked = o.checklist || {};
  Object.keys(CHECKPOS).forEach((k) => {
    const sel = k === 'geen' ? o.geen : !!checked[k];
    if (sel) check(CHECKPOS[k][0], CHECKPOS[k][1]);
  });
  if (o.signature) {
    try {
      const png = await doc.embedPng(Buffer.from(o.signature.split(',')[1], 'base64'));
      const dim = png.scale(1); const sc = Math.min(150 / dim.width, 44 / dim.height);
      page.drawImage(png, { x: 54, y: H - (570 + dim.height * sc), width: dim.width * sc, height: dim.height * sc });
    } catch (e) {}
  }
  page.drawText('Digitaal ondertekend via Label & Lens · ' + new Date().toLocaleString('nl-NL'),
    { x: 54, y: 24, size: 6.5, font, color: rgb(0.58, 0.6, 0.58) });
  return Buffer.from(await doc.save());
}

module.exports = async (req, res) => {
  const action = (req.query && req.query.action) || '';
  try {
    await ensureTable();

    if (action === 'login' && req.method === 'POST') {
      const { password } = body(req);
      if (password && password === (process.env.ADMIN_PASSWORD || '')) {
        res.setHeader('Set-Cookie', `llauth=${authToken()}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
        return res.json({ ok: true });
      }
      return res.status(401).json({ ok: false, error: 'Onjuist wachtwoord' });
    }

    if (action === 'me') { return res.json({ authed: isAuthed(req) }); }

    if (action === 'create' && req.method === 'POST') {
      if (!isAuthed(req)) return res.status(401).json({ error: 'Niet ingelogd' });
      const b = body(req);
      if (!b.adres) return res.status(400).json({ error: 'Adres verplicht' });
      let code;
      for (let i = 0; i < 6; i++) {
        code = genCode();
        const ex = await sql`SELECT 1 FROM orders WHERE code=${code}`;
        if (ex.rowCount === 0) break;
      }
      await sql`INSERT INTO orders (code, adres, postcode, woonplaats, opdrachtgever_email, status)
                VALUES (${code}, ${b.adres}, ${b.postcode || ''}, ${b.woonplaats || ''}, ${b.email || ''}, 'concept')`;
      const url = `${BASE_URL}/woning/${code}`;
      let mailed = false;
      if (b.email && process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
        try {
          await transporter().sendMail({
            from: `Label & Lens <${process.env.GMAIL_USER}>`,
            to: b.email,
            subject: 'Opdrachtbevestiging energielabel — ' + b.adres,
            text: `Beste,\n\nVoor de energielabel-opname op ${b.adres} vragen wij u de opdrachtbevestiging digitaal te ondertekenen.\n\nOpen deze link, vul uw gegevens in en onderteken (kost een minuut):\n${url}\n\nLet op: zonder ondertekening kan het energielabel niet worden afgemeld.\n\nMet vriendelijke groet,\nLabel & Lens Vastgoed`,
            html: `<p>Beste,</p><p>Voor de energielabel-opname op <b>${b.adres}</b> vragen wij u de opdrachtbevestiging digitaal te ondertekenen.</p><p><a href="${url}" style="background:#3f4f46;color:#fff;padding:11px 18px;border-radius:8px;text-decoration:none;display:inline-block">Opdrachtbevestiging openen &amp; ondertekenen</a></p><p style="color:#666;font-size:13px">Of kopieer deze link: ${url}</p><p style="color:#b3261e;font-size:13px">Zonder ondertekening kan het energielabel niet worden afgemeld.</p><p>Met vriendelijke groet,<br>Label &amp; Lens Vastgoed</p>`
          });
          mailed = true;
          await sql`UPDATE orders SET status='verzonden', sent_at=now() WHERE code=${code}`;
        } catch (e) { mailed = false; }
      }
      return res.json({ ok: true, code, url, mailed });
    }

    if (action === 'list' && req.method === 'GET') {
      if (!isAuthed(req)) return res.status(401).json({ error: 'Niet ingelogd' });
      const r = await sql`SELECT code, adres, postcode, woonplaats, opdrachtgever_email, naam, status,
                          created_at, sent_at, opened_at, signed_at FROM orders ORDER BY created_at DESC`;
      return res.json({ orders: r.rows });
    }

    if (action === 'order' && req.method === 'GET') {
      const code = (req.query.code || '').toUpperCase();
      const r = await sql`SELECT code, adres, postcode, woonplaats, status FROM orders WHERE code=${code}`;
      if (r.rowCount === 0) return res.status(404).json({ error: 'Niet gevonden' });
      await sql`UPDATE orders SET status=CASE WHEN status IN ('concept','verzonden') THEN 'geopend' ELSE status END,
                opened_at=COALESCE(opened_at, now()) WHERE code=${code}`;
      return res.json({ order: r.rows[0] });
    }

    if (action === 'sign' && req.method === 'POST') {
      const b = body(req);
      const code = (b.code || '').toUpperCase();
      if (!code || !b.naam || !b.signature) return res.status(400).json({ error: 'Onvolledig' });
      const r = await sql`SELECT * FROM orders WHERE code=${code}`;
      if (r.rowCount === 0) return res.status(404).json({ error: 'Niet gevonden' });
      await sql`UPDATE orders SET naam=${b.naam}, bedrijf=${b.bedrijf || ''},
                adres=${b.adres || r.rows[0].adres}, postcode=${b.postcode || ''}, woonplaats=${b.woonplaats || ''},
                checklist=${JSON.stringify(b.checked || {})}, geen=${!!b.geen}, signature=${b.signature},
                status='ondertekend', signed_at=now() WHERE code=${code}`;
      const o = (await sql`SELECT * FROM orders WHERE code=${code}`).rows[0];
      let pdf;
      try { pdf = await buildPdf(o); } catch (e) { pdf = null; }
      if (pdf && process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) {
        try {
          await transporter().sendMail({
            from: `Label & Lens <${process.env.GMAIL_USER}>`,
            to: ADVISEUR_EMAIL,
            subject: 'Getekende opdrachtbevestiging — ' + o.adres,
            text: `Ondertekend door ${o.naam}${o.bedrijf ? ' (' + o.bedrijf + ')' : ''}\nAdres: ${o.adres}\n${o.postcode || ''} ${o.woonplaats || ''}\nCode: ${code}\n\nDe getekende PDF zit als bijlage.`,
            attachments: [{ filename: 'Opdrachtbevestiging_' + code + '.pdf', content: pdf }]
          });
        } catch (e) {}
      }
      return res.json({ ok: true });
    }

    if (action === 'pdf' && req.method === 'GET') {
      if (!isAuthed(req)) return res.status(401).json({ error: 'Niet ingelogd' });
      const code = (req.query.code || '').toUpperCase();
      const r = await sql`SELECT * FROM orders WHERE code=${code}`;
      if (r.rowCount === 0) return res.status(404).end('Niet gevonden');
      const pdf = await buildPdf(r.rows[0]);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="Opdrachtbevestiging_${code}.pdf"`);
      return res.end(pdf);
    }

    return res.status(404).json({ error: 'Onbekende actie' });
  } catch (e) {
    return res.status(500).json({ error: 'Serverfout', detail: String(e && e.message || e) });
  }
};
