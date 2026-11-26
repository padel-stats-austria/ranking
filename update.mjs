import fs from 'fs';
import * as cheerio from 'cheerio';

const BASE_URL = 'https://www.padel-austria.at';
const PAGES = 2; // 1 Seite = 50 Spieler zum Testen (für Top 500 auf 10, für Top 1000 auf 20 ändern)
const DATA_FILE = './data.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomDelay = (min, max) => sleep(min + Math.floor(Math.random() * (max - min)));

async function fetchHTML(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'APU-Stats-Viewer-Private/1.0 (Personal Hobby Project)',
      'Accept': 'text/html'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} bei ${url}`);
  return await res.text();
}

function getH4($, label) {
  let val = null;
  $('h4').each((_, el) => {
    if ($(el).text().trim() === label) {
      const next = $(el).next();
      if (next.length) val = next.text().trim();
    }
  });
  return val;
}

async function run() {
  let oldMap = new Map();
  if (fs.existsSync(DATA_FILE)) {
    try {
      const oldJson = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      for (const p of (oldJson.data || [])) {
        if (p.url) oldMap.set(p.url, p);
      }
      console.log(`Cache geladen: ${oldMap.size} bestehende Spieler gefunden.`);
    } catch (e) {
      console.log('Keine gültige alte data.json gefunden, starte kompletten Neuaufbau.');
    }
  }

  const currentList = [];

  for (let p = 1; p <= PAGES; p++) {
    console.log(`Lade Ranglisten-Seite ${p} von ${PAGES}...`);
    const html = await fetchHTML(`${BASE_URL}/rankings/males?page=${p}`);
    const $ = cheerio.load(html);

    $('tbody tr').each((_, tr) => {
      const td = $(tr).find('td');
      if (td.length >= 4) {
        const a = $(tr).find('a').first();
        const href = a.attr('href');
        const fullUrl = href ? (href.startsWith('http') ? href : `${BASE_URL}${href}`) : null;
        const platz = parseInt($(td[0]).text().trim(), 10) || 99999;
        const name = $(td[2]).text().trim();
        const punkte = $(td[3]).text().trim();

        if (name && fullUrl) {
          currentList.push({ platz, name, punkte, url: fullUrl });
        }
      }
    });

    await randomDelay(1000, 1800);
  }

  console.log(`${currentList.length} Spieler in der aktuellen Rangliste gefunden.`);

  const updatedList = [];
  let fetchedProfiles = 0;

  for (let i = 0; i < currentList.length; i++) {
    const item = currentList[i];
    const old = oldMap.get(item.url);

    // Delta-Check: Wenn Punkte gleich sind und Stammdaten vorhanden -> kein Profil-Abruf nötig
    if (old && old.punkte === item.punkte && old.apnT && old.apnT !== '–' && old.seitT && old.seitT !== '–') {
      updatedList.push({
        ...old,
        platz: item.platz,
        name: item.name
      });
      continue;
    }

    console.log(`[${i + 1}/${currentList.length}] Lade Profil: ${item.name} (${old ? old.punkte + ' -> ' : 'Neu: '}${item.punkte})`);
    try {
      const pHtml = await fetchHTML(item.url);
      const $p = cheerio.load(pHtml);

      // Profilbild nur holen, wenn noch nicht gespeichert
      let bild = old?.bild || '';
      if (!bild) {
        const img = $p('.col-md-3 img').first().length ? $p('.col-md-3 img').first() : $p('img[src*="/uploads/player/"]').first();
        const src = img.attr('src') || '';
        if (src && !src.includes('default')) {
          bild = src.startsWith('http') ? src : `${BASE_URL}${src}`;
        }
      }

      // APN, Matches Gespielt, Effektivität exakt wie im Original-Skript auslesen
      let apnT = '–', apnZ = -1;
      const apn = getH4($p, 'APN');
      if (apn) {
        apnT = apn;
        apnZ = parseFloat(apn.replace(',', '.')) || -1;
      }

      let mT = '–', mZ = -1;
      const m = getH4($p, 'Matches Gespielt');
      if (m) {
        mT = m;
        mZ = parseInt(m, 10) || -1;
      }

      let effT = '–', effZ = -1;
      const eff = getH4($p, 'Effektivität');
      if (eff) {
        effT = eff;
        effZ = parseFloat(eff.replace('%', '').replace(',', '.')) || -1;
      }

      // "Aktiv seit" nur abrufen, wenn noch nicht gespeichert
      let seitT = old?.seitT || '–';
      let seitZ = old?.seitZ || 9e15;

      if (!old?.seitT || old.seitT === '–') {
        let maxP = 1;
        $p('.pagination a, nav a').each((_, a) => {
          const n = parseInt($p(a).text().trim(), 10);
          if (!isNaN(n) && n > maxP) maxP = n;
        });

        let $lDoc = $p;
        if (maxP > 1) {
          await randomDelay(1000, 1600);
          const lHtml = await fetchHTML(`${item.url}?page=${maxP}`);
          $lDoc = cheerio.load(lHtml);
        }

        const smalls = $lDoc('small').toArray();
        for (let j = smalls.length - 1; j >= 0; j--) {
          const match = $lDoc(smalls[j]).text().match(/(\d{2})\.(\d{2})\.(\d{4})/);
          if (match) {
            seitT = match[0];
            seitZ = new Date(`${match[3]}-${match[2]}-${match[1]}`).getTime();
            break;
          }
        }
      }

      updatedList.push({
        platz: item.platz,
        name: item.name,
        punkte: item.punkte,
        url: item.url,
        bild,
        apnT,
        apnZ,
        mT,
        mZ,
        effT,
        effZ,
        seitT,
        seitZ
      });

      fetchedProfiles++;
      await randomDelay(1200, 2000);
    } catch (err) {
      console.error(`Fehler bei ${item.name}:`, err.message);
      updatedList.push(old ? { ...old, platz: item.platz, punkte: item.punkte } : {
        platz: item.platz,
        name: item.name,
        punkte: item.punkte,
        url: item.url,
        bild: '', apnT: '–', apnZ: -1, mT: '–', mZ: -1, effT: '–', effZ: -1, seitT: '–', seitZ: 9e15
      });
    }
  }

  const now = new Date();
  const datumStr = now.toLocaleDateString('de-AT') + ', ' + now.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Vienna' }) + ' Uhr';

  const output = {
    updatedAt: now.toISOString(),
    datum: datumStr,
    data: updatedList
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2));
  console.log(`Fertig! ${fetchedProfiles} Profile aktualisiert, ${updatedList.length} Spieler gespeichert.`);
}

run();
