import fs from 'fs';
import * as cheerio from 'cheerio';

const BASE_URL = 'https://padel-austria.at';
const PAGES = 1; // 1 = Top 50 zum Testen | 10 = Top 500 | 20 = Top 1.000
const DATA_FILE = './data.json';

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const randomDelay = (min, max) => sleep(min + Math.random() * (max - min));

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
    let existingPlayers = new Map();
    if (fs.existsSync(DATA_FILE)) {
        try {
            const oldData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
            for (const p of (oldData.players || [])) {
                existingPlayers.set(p.url, p);
            }
        } catch (e) {}
    }

    const currentList = [];

    for (let page = 1; page <= PAGES; page++) {
        console.log(`Lade Rangliste Seite ${page}/${PAGES}...`);
        const html = await fetchHTML(`${BASE_URL}/rankings/males?page=${page}`);
        const $ = cheerio.load(html);

        $('tbody tr').each((_, tr) => {
            const td = $(tr).find('td');
            if (td.length >= 4) {
                const a = $(tr).find('a');
                const href = a.attr('href');
                const fullUrl = href ? (href.startsWith('http') ? href : `${BASE_URL}${href}`) : null;
                currentList.push({
                    platz: parseInt($(td[0]).text().trim(), 10) || 99999,
                    name: $(td[2]).text().trim(),
                    punkte: $(td[3]).text().trim(),
                    url: fullUrl
                });
            }
        });

        await randomDelay(1000, 1800);
    }

    const updatedPlayers = [];
    let fetchedProfiles = 0;

    for (let i = 0; i < currentList.length; i++) {
        const item = currentList[i];
        const old = item.url ? existingPlayers.get(item.url) : null;

        // Delta-Sync: Wenn Punkte unverändert und Stammdaten da sind -> kein Profil-Abruf nötig
        if (old && old.punkte === item.punkte && old.apnT !== '–' && old.seitT !== '–') {
            updatedPlayers.push({
                ...old,
                platz: item.platz,
                name: item.name
            });
            continue;
        }

        const sp = {
            platz: item.platz,
            name: item.name,
            punkte: item.punkte,
            url: item.url,
            bild: old?.bild || '',
            apnT: old?.apnT || '–',
            apnZ: old?.apnZ ?? -1,
            mT: old?.mT || '–',
            mZ: old?.mZ ?? -1,
            effT: old?.effT || '–',
            effZ: old?.effZ ?? -1,
            seitT: old?.seitT || '–',
            seitZ: old?.seitZ ?? 9e15
        };

        if (sp.url) {
            try {
                console.log(`[${i + 1}/${currentList.length}] Lade Profil: ${sp.name}`);
                const pHtml = await fetchHTML(sp.url);
                const $p = cheerio.load(pHtml);

                // Bild nur holen, wenn noch nicht vorhanden
                if (!sp.bild) {
                    const imgEl = $p('.col-md-3 img').first().length ? $p('.col-md-3 img').first() : $p('img[src*="/uploads/player/"]').first();
                    const src = imgEl.attr('src');
                    if (src && !src.includes('default')) {
                        sp.bild = src.startsWith('http') ? src : `${BASE_URL}${src}`;
                    }
                }

                const apn = getH4($p, 'APN');
                if (apn) { sp.apnT = apn; sp.apnZ = parseFloat(apn.replace(',', '.')) || -1; }

                const m = getH4($p, 'Matches Gespielt');
                if (m) { sp.mT = m; sp.mZ = parseInt(m, 10) || -1; }

                const eff = getH4($p, 'Effektivität');
                if (eff) { sp.effT = eff; sp.effZ = parseFloat(eff.replace('%', '').replace(',', '.')) || -1; }

                // "Aktiv seit" nur laden, wenn noch nicht gespeichert
                if (sp.seitT === '–') {
                    let maxP = 1;
                    $p('.pagination a, nav a').each((_, a) => {
                        const n = parseInt($p(a).text().trim(), 10);
                        if (!isNaN(n) && n > maxP) maxP = n;
                    });

                    let $lDoc = $p;
                    if (maxP > 1) {
                        await randomDelay(1000, 1600);
                        const lUrl = new URL(sp.url);
                        lUrl.searchParams.set('page', maxP);
                        $lDoc = cheerio.load(await fetchHTML(lUrl.toString()));
                    }

                    const smalls = $lDoc('small').toArray();
                    for (let j = smalls.length - 1; j >= 0; j--) {
                        const match = $lDoc(smalls[j]).text().match(/(\d{2})\.(\d{2})\.(\d{4})/);
                        if (match) {
                            sp.seitT = match[0];
                            sp.seitZ = new Date(`${match[3]}-${match[2]}-${match[1]}`).getTime();
                            break;
                        }
                    }
                }

                fetchedProfiles++;
                await randomDelay(1200, 2200);
            } catch (err) {
                console.error(`Fehler bei ${sp.name}:`, err.message);
            }
        }

        updatedPlayers.push(sp);
    }

    const output = {
        updatedAt: new Date().toISOString(),
        totalPlayers: updatedPlayers.length,
        players: updatedPlayers
    };

    fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2));
    console.log(`Fertig! ${fetchedProfiles} Profile aktualisiert, ${updatedPlayers.length} Spieler gespeichert.`);
}

run();
