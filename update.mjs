import fs from 'fs';
import * as cheerio from 'cheerio';

const BASE_URL = 'https://padel-austria.at';
const PAGES = 2; // 1 = Top 50, 10 = Top 500, 20 = Top 1000
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

function getH4Value($, label) {
  let val = '';
  $('h4').each((_, el) => {
    const txt = $(el).text().trim();
    if (txt.toLowerCase().includes(label.toLowerCase())) {
      const next = $(el).next();
      if (next.length) {
        val = next.text().trim();
      } else if (txt.includes(':')) {
        val = txt.split(':')[1].trim();
      }
    }
  });
  return val;
}

function extractOldestDate($) {
  const dates = [];
  const textToScan = $('body').text();
  const matches = textToScan.match(/\b(\d{2})\.(\d{2})\.(20\d{2})\b/g) || [];
  for (const dStr of matches) {
    const [d, m, y] = dStr.split('.');
    const ts = new Date(`${y}-${m}-${d}`).getTime();
    if (!isNaN(ts)) {
      dates.push({ str: dStr, ts });
    }
  }
  if (!dates.length) return '';
  dates.sort((a, b) => a.ts - b.ts);
  return dates[0].str;
}

async function run() {
  const oldMap = new Map();
  if (fs.existsSync(DATA_FILE)) {
    try {
      const oldData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      for (const p of (oldData.players || [])) {
        if (p.url) oldMap.set(p.url, p);
      }
      console.log(`Cache geladen: ${oldMap.size} bestehende Spieler.`);
    } catch (e) {
      console.log('Keine gültige data.json gefunden, starte neu.');
    }
  }

  const seenUrls = new Set();
  const currentList = [];

  for (let page = 1; page <= PAGES; page++) {
    console.log(`Lade Rangliste Seite ${page}/${PAGES}...`);
    const html = await fetchHTML(`${BASE_URL}/rankings/males?page=${page}`);
    const $ = cheerio.load(html);
    let added = 0;

    $('table tbody tr').each((_, tr) => {
      const tds = $(tr).find('td');
      const link = $(tr).find('a[href*="/players/"]').first();
      if (tds.length >= 4 && link.length) {
        const href = link.attr('href').trim();
        const url = href.startsWith('http') ? href : `${BASE_URL}${href}`;
        if (seenUrls.has(url)) return;
        seenUrls.add(url);

        const rank = parseInt($(tds[0]).text().trim(), 10) || 0;
        const name = link.text().trim();
        const points = parseInt($(tds[3]).text().replace(/\D/g, ''), 10) || 0;

        if (name && url) {
          currentList.push({ rank, name, points, url });
          added++;
        }
      }
    });

    console.log(`Seite ${page}: ${added} eindeutige Spieler gefunden.`);
    if (added === 0) break;
    await randomDelay(1000, 1600);
  }

  const updatedPlayers = [];
  let fetchedProfiles = 0;

  for (let i = 0; i < currentList.length; i++) {
    const item = currentList[i];
    const old = oldMap.get(item.url);

    // Nur überspringen, wenn Punkte gleich sind UND alle Stammdaten (inkl. Flagge & echtes Startdatum) da sind
    if (
      old &&
      old.points === item.points &&
      old.apn !== undefined &&
      old.matches !== undefined &&
      old.seit &&
      old.seit !== '-' &&
      old.flag !== undefined
    ) {
      updatedPlayers.push({
        ...old,
        rank: item.rank,
        name: item.name
      });
      continue;
    }

    console.log(`[${i + 1}/${currentList.length}] Lade Profil: ${item.name} (${old ? old.points + ' -> ' : 'Neu: '}${item.points})`);
    try {
      const pHtml = await fetchHTML(item.url);
      const $ = cheerio.load(pHtml);

      const apnT = getH4Value($, 'APN');
      const apn = apnT ? parseFloat(apnT.replace(',', '.')) : (old?.apn ?? null);

      const mT = getH4Value($, 'Matches Gespielt');
      const matches = mT ? (parseInt(mT.replace(/\D/g, ''), 10) || 0) : (old?.matches ?? 0);

      const wT = getH4Value($, 'Matches Gewonnen');
      const wins = wT ? (parseInt(wT.replace(/\D/g, ''), 10) || 0) : (old?.wins ?? 0);

      const effT = getH4Value($, 'Effektivität');
      const eff = effT ? (parseFloat(effT.replace('%', '').replace(',', '.')) || 0) : (old?.eff ?? 0);

      // Profilbild (einmalig)
      let img = old?.img || '';
      if (!img) {
        const imgSrc = $('img[src*="/uploads/player"]').first().attr('src');
        if (imgSrc) img = imgSrc.startsWith('http') ? imgSrc : `${BASE_URL}${imgSrc}`;
      }

      // Flagge (einmalig)
      let flag = old?.flag || '';
      if (!flag) {
        const flagSrc = $('img[src*="flagcdn.com"]').first().attr('src');
        if (flagSrc) flag = flagSrc.startsWith('http') ? flagSrc : `https:${flagSrc}`;
      }

      // Aktiv seit: Höchste Seitenzahl in der Pagination ermitteln und letzte Seite laden
      let seit = (old?.seit && old.seit !== '-') ? old.seit : '';
      if (!seit) {
        let maxP = 1;
        $('.pagination a, nav a, a[href*="?page="]').each((_, a) => {
          const href = $(a).attr('href') || '';
          const m = href.match(/[?&]page=(\d+)/);
          if (m) {
            const pNum = parseInt(m[1], 10);
            if (pNum > maxP) maxP = pNum;
          }
          const txtNum = parseInt($(a).text().trim(), 10);
          if (!isNaN(txtNum) && txtNum > maxP) maxP = txtNum;
        });

        if (maxP > 1) {
          await randomDelay(900, 1500);
          const lastUrl = `${item.url}${item.url.includes('?') ? '&' : '?'}page=${maxP}`;
          const lastHtml = await fetchHTML(lastUrl);
          const $last = cheerio.load(lastHtml);
          seit = extractOldestDate($last) || extractOldestDate($) || '-';
        } else {
          seit = extractOldestDate($) || '-';
        }
      }

      updatedPlayers.push({
        rank: item.rank,
        name: item.name,
        points: item.points,
        apn,
        apnT: apnT || '-',
        matches,
        wins,
        eff,
        effT: effT || '-',
        img,
        flag,
        seit,
        url: item.url,
        prevRank: old ? old.rank : item.rank
      });

      fetchedProfiles++;
      await randomDelay(1200, 2000);
    } catch (err) {
      console.error(`Fehler bei ${item.name}:`, err.message);
      if (old) updatedPlayers.push({ ...old, rank: item.rank, points: item.points });
    }
  }

  const output = {
    updatedAt: new Date().toISOString(),
    totalPlayers: updatedPlayers.length,
    players: updatedPlayers
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2));
  console.log(`Fertig! ${fetchedProfiles} Profile aktualisiert, ${updatedPlayers.length} eindeutige Spieler gespeichert.`);
}

run();
