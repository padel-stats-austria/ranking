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
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'de-AT,de;q=0.9,en;q=0.8'
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
  const parts = fullText.split(/Matches\b/);
  const matchSection = parts.length > 1 ? parts[parts.length - 1] : fullText;
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
    } catch (e) {}
  }

  const oldMap = new Map((oldData.data || oldData.players || []).map((p) => [p.url, p]));
  const seenUrls = new Set();
  const currentList = [];

  for (let page = 1; page <= PAGES; page++) {
    console.log(`Lade Rangliste Seite ${page}/${PAGES}...`);
    const html = await fetchHTML(`${BASE_URL}/rankings/males?page=${page}`);
    const $ = cheerio.load(html);
    let addedOnPage = 0;

    $('a[href*="/players/"]').each((_, a) => {
      const link = $(a);
      const rawUrl = link.attr('href');
      if (!rawUrl) return;
      const fullUrl = rawUrl.startsWith('http') ? rawUrl : `${BASE_URL}${rawUrl}`;

      if (seenUrls.has(fullUrl)) return;
      const name = link.text().trim();
      if (!name) return;

      const row = link.closest('tr').length ? link.closest('tr') : link.parent().parent();
      const cells = row.children();

      let platz = 0;
      let punkte = 0;

      if (cells.length >= 3) {
        platz = parseInt(cells.eq(0).text().replace(/\D/g, ''), 10) || 0;
        punkte = parseInt(cells.eq(cells.length - 1).text().replace(/\D/g, ''), 10) || 0;
      } else {
        const nums = row.text().match(/\d+/g)?.map(Number) || [];
        if (nums.length >= 2) {
          platz = nums[0];
          punkte = nums[nums.length - 1];
        }
      }

      if (!platz) platz = (page - 1) * 50 + addedOnPage + 1;

      seenUrls.add(fullUrl);
      currentList.push({ platz, name, url: fullUrl, punkte });
      addedOnPage++;
    });

    console.log(`Seite ${page}: ${addedOnPage} Spieler gelesen.`);
    if (addedOnPage === 0) break;
    await randomPause();
  }

  console.log(`${currentList.length} eindeutige Spieler gefunden.`);
  const updatedPlayers = [];
  let fetchedCount = 0;

  for (let i = 0; i < currentList.length; i++) {
    const item = currentList[i];
    const existing = oldMap.get(item.url);

    const hasValidSeit = existing?.seitT && /\d{2}\.\d{2}\.\d{4}/.test(existing.seitT);

    const hasCompleteCache =
      existing &&
      existing.punkte === item.punkte &&
      existing.apnT &&
      hasValidSeit &&
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

      let seitT = hasValidSeit ? existing.seitT : '';
      let maxP = 1;
      if (!seitT) {
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

      console.log(`   -> ${item.name}: APN=${apnT}, Matches=${mT}, Aktiv seit=${seitT} (Seiten: ${maxP})`);

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
  const datum =
    now.toLocaleDateString('de-AT') +
    ' ' +
    now.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' });

  const output = {
    datum,
    totalPlayers: updatedPlayers.length,
    data: updatedPlayers
  };

  fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2));
  console.log(`Fertig: ${fetchedCount} Profile geladen, ${updatedPlayers.length} Spieler gespeichert.`);
}

run();
