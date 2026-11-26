import fs from 'fs';
import * as cheerio from 'cheerio';

const PAGES = 1; // 1 = Top 50, 10 = Top 500, 20 = Top 1000
const BASE_URL = 'https://padel-austria.at';
const DATA_FILE = './data.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randomPause = () => sleep(1500 + Math.floor(Math.random() * 1000));

async function fetchHTML(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'APU-Analytics-Viewer/1.0 (Respectful-Daily-Sync)',
      'Accept': 'text/html,application/xhtml+xml'
    }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} für ${url}`);
  return await res.text();
}

function getH4Value($, labelText) {
  let val = '';
  $('h4').each((_, el) => {
    if ($(el).text().trim().toLowerCase() === labelText.toLowerCase()) {
      const next = $(el).next('h4');
      if (next.length) val = next.text().trim();
    }
  });
  return val;
}

function extractOldestDate($) {
  const fullText = $('body').text();
  const matchSection = fullText.split('Matches')[1] || fullText;
  const regex = /(\d{2})\.(\d{2})\.(\d{4})/g;
  const dates = [];
  let m;
  while ((m = regex.exec(matchSection)) !== null) {
    const str = `${m[1]}.${m[2]}.${m[3]}`;
    const ts = new Date(`${m[3]}-${m[2]}-${m[1]}`).getTime();
    if (!isNaN(ts)) dates.push({ str, ts });
  }
  if (!dates.length) return '';
  dates.sort((a, b) => a.ts - b.ts);
  return dates[0].str;
}

function dateToTs(str) {
  const m = String(str || '').match(/(\d{2})\.(\d{2})\.(\d{4})/);
  if (!m) return 9e15;
  const ts = new Date(`${m[3]}-${m[2]}-${m[1]}`).getTime();
  return isNaN(ts) ? 9e15 : ts;
}

async function run() {
  let oldData = { data: [] };
  if (fs.existsSync(DATA_FILE)) {
    try {
      oldData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
    } catch (e) { }
  }

  const oldMap = new Map((oldData.data || oldData.players || []).map((p) => [p.url, p]));
  const seenUrls = new Set();
  const currentList = [];

  for (let page = 1; page <= PAGES; page++) {
    console.log(`Lade Rangliste Seite ${page}/${PAGES}...`);
    const html = await fetchHTML(`${BASE_URL}/rankings/males?page=${page}`);
    const $ = cheerio.load(html);
    let addedOnPage = 0;

    $('table tbody tr').each((_, tr) => {
      const tds = $(tr).find('td');
      if (tds.length < 3) return;
      const link = tds.eq(1).find('a');
      if (!link.length) return;

      const rawUrl = link.attr('href');
      if (!rawUrl) return;
      const fullUrl = rawUrl.startsWith('http') ? rawUrl : `${BASE_URL}${rawUrl}`;

      if (seenUrls.has(fullUrl)) return;
      seenUrls.add(fullUrl);

      const name = link.text().trim();
      const platz = parseInt(tds.eq(0).text().trim(), 10) || 0;
      const punkte = parseInt(tds.eq(2).text().replace(/\D/g, ''), 10) || 0;

      if (name) {
        currentList.push({ platz, name, url: fullUrl, punkte });
        addedOnPage++;
      }
    });

    if (addedOnPage === 0) break;
    await randomPause();
  }

  console.log(`${currentList.length} eindeutige Spieler gefunden.`);
  const updatedPlayers = [];
  let fetchedCount = 0;

  for (let i = 0; i < currentList.length; i++) {
    const item = currentList[i];
    const existing = oldMap.get(item.url);

    const hasCompleteCache =
      existing &&
      existing.punkte === item.punkte &&
      existing.apnT &&
      existing.seitT &&
      existing.seitV2 === true &&
      existing.flag !== undefined;

    if (hasCompleteCache) {
      updatedPlayers.push({
        ...existing,
        platz: item.platz,
        name: item.name
      });
      continue;
    }

    try {
      fetchedCount++;
      console.log(`[${i + 1}/${currentList.length}] Lade Profil: ${item.name}`);
      const pHtml = await fetchHTML(item.url);
      const $p = cheerio.load(pHtml);

      const apnT = getH4Value($p, 'APN') || existing?.apnT || '-';
      const apn = parseFloat(apnT.replace(',', '.')) || 0;

      const mT = getH4Value($p, 'Matches Gespielt') || existing?.mT || '-';
      const matches = parseInt(mT.replace(/\D/g, ''), 10) || 0;

      const effT = getH4Value($p, 'Effektivität') || existing?.effT || '-';
      const eff = parseFloat(effT.replace('%', '').replace(',', '.')) || 0;

      let bild = existing?.bild || '';
      if (!bild) {
        const imgSrc = $p('img[src*="/uploads/player"]').first().attr('src') || '';
        if (imgSrc) {
          bild = imgSrc.startsWith('http') ? imgSrc : `${BASE_URL}${imgSrc}`;
        }
      }

      let flag = existing?.flag;
      if (flag === undefined) {
        const flagSrc = $p('img[src*="flagcdn.com"]').first().attr('src') || '';
        flag = flagSrc;
      }

      let seitT = existing?.seitV2 ? existing.seitT : '';
      if (!seitT || seitT === '-') {
        let maxP = 1;
        $p('a[href*="page="]').each((_, a) => {
          const href = $p(a).attr('href') || '';
          const m = href.match(/page=(\d+)/);
          if (m) maxP = Math.max(maxP, parseInt(m[1], 10));
        });

        if (maxP > 1) {
          await randomPause();
          const lastHtml = await fetchHTML(`${item.url}?page=${maxP}`);
          const $last = cheerio.load(lastHtml);
          seitT = extractOldestDate($last) || extractOldestDate($p) || '-';
        } else {
          seitT = extractOldestDate($p) || '-';
        }
      }

      updatedPlayers.push({
        platz: item.platz,
        name: item.name,
        url: item.url,
        punkte: item.punkte,
        apnZ: apn,
        apnT,
        mZ: matches,
        mT,
        effZ: eff,
        effT,
        seitZ: dateToTs(seitT),
        seitT,
        seitV2: true,
        bild,
        flag
      });

      await randomPause();
    } catch (err) {
      console.error(`Fehler bei ${item.name}:`, err.message);
      if (existing) {
        updatedPlayers.push({ ...existing, platz: item.platz });
      }
    }
  }

  const now = new Date();
  const datum = now.toLocaleDateString('de-AT') + ' ' + now.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });

  const output = {
    datum,
    totalPlayers: updatedPlayers.length,
    data: updatedPlayers
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2));
  console.log(`Fertig: ${fetchedCount} Profile geladen, ${updatedPlayers.length} Spieler gespeichert.`);
}

run();
