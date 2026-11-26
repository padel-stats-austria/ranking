import fs from 'fs';
import * as cheerio from 'cheerio';

const BASE_URL = 'https://padel-austria.at';
const PAGES = 1; // 20 Seiten x 50 Spieler = Top 1.000
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

async function run() {
    // 1. Bestehende Daten laden (falls vorhanden) für Delta-Update
    let existingPlayers = new Map();
    if (fs.existsSync(DATA_FILE)) {
        try {
            const oldData = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
            for (const p of (oldData.players || [])) {
                existingPlayers.set(p.url, p);
            }
            console.log(`Geladen: ${existingPlayers.size} bestehende Spieler aus data.json`);
        } catch (e) {
            console.log('Keine gültige alte data.json gefunden, starte kompletten Neuaufbau.');
        }
    }

    const currentList = [];

    // 2. Ranglistenseiten 1 bis 20 abrufen (nur 20 Requests)
    for (let page = 1; page <= PAGES; page++) {
        console.log(`Lade Rangliste Seite ${page}/${PAGES}...`);
        const html = await fetchHTML(`${BASE_URL}/rankings/males?page=${page}`);
        const $ = cheerio.load(html);

        $('table tbody tr').each((_, row) => {
            const cols = $(row).find('td');
            const link = $(row).find('a[href*="/players/"]');
            if (cols.length >= 2 && link.length > 0) {
                const rank = parseInt($(cols[0]).text().trim(), 10) || 0;
                const points = parseInt($(cols[1]).text().replace(/\./g, '').trim(), 10) || 0;
                const name = link.text().trim();
                const href = link.attr('href');
                const fullUrl = href.startsWith('http') ? href : `${BASE_URL}${href}`;

                currentList.push({ rank, points, name, url: fullUrl });
            }
        });

        await randomDelay(1000, 1800);
    }

    console.log(`${currentList.length} Spieler in der aktuellen Rangliste gefunden.`);

    // 3. Profile nur abrufen, wenn Spieler neu ist ODER sich die Punkte geändert haben
    const updatedPlayers = [];
    let fetchedProfiles = 0;

    for (let i = 0; i < currentList.length; i++) {
        const entry = currentList[i];
        const old = existingPlayers.get(entry.url);

        if (old && old.points === entry.points && old.apn !== undefined) {
            // Punkte unverändert -> alte Stammdaten & Stats übernehmen, kein Request nötig!
            updatedPlayers.push({
                ...old,
                rank: entry.rank,
                name: entry.name
            });
            continue;
        }

        // Punkte haben sich geändert oder Spieler ist neu -> Profil abrufen
        console.log(`[${i + 1}/${currentList.length}] Aktualisiere Profil: ${entry.name} (${old ? old.points + ' -> ' : 'Neu: '}${entry.points} Pkt)`);
        try {
            const pHtml = await fetchHTML(entry.url);
            const $ = cheerio.load(pHtml);
            const bodyText = $('body').text();

            // APN extrahieren
            const apnMatch = bodyText.match(/APN[:\s]*([0-9.,]+)/i);
            const apn = apnMatch ? parseFloat(apnMatch[1].replace(',', '.')) : (old?.apn ?? null);

            // Spiele & Siege extrahieren
            let matches = old?.matches ?? 0;
            let wins = old?.wins ?? 0;
            const statsMatch = bodyText.match(/(\d+)\s*Siege?\s*\/\s*(\d+)\s*Spiele?/i) || bodyText.match(/Spiele[:\s]*(\d+)/i);
            if (statsMatch) {
                if (statsMatch[2]) {
                    wins = parseInt(statsMatch[1], 10);
                    matches = parseInt(statsMatch[2], 10);
                } else {
                    matches = parseInt(statsMatch[1], 10);
                }
            }

            // Stammdaten (Bild & Aktiv seit) nur laden, wenn noch nicht gespeichert!
            let img = old?.img || '';
            if (!img) {
                const imgSrc = $('img[src*="/uploads/player"], img[src*="avatar"]').first().attr('src');
                if (imgSrc) img = imgSrc.startsWith('http') ? imgSrc : `${BASE_URL}${imgSrc}`;
            }

            let since = old?.since || '';
            if (!since) {
                // Datum des ältesten Eintrags auf der aktuellen Seite oder letzter Seite prüfen
                const dates = bodyText.match(/\b\d{2}\.\d{2}\.(20\d{2})\b/g);
                if (dates && dates.length > 0) {
                    since = dates[dates.length - 1];
                }
            }

            const eff = matches > 0 ? Math.round((entry.points / matches) * 10) / 10 : 0;

            updatedPlayers.push({
                rank: entry.rank,
                name: entry.name,
                points: entry.points,
                apn,
                matches,
                wins,
                eff,
                img,
                since,
                url: entry.url,
                prevRank: old ? old.rank : entry.rank,
                prevPoints: old ? old.points : entry.points
            });

            fetchedProfiles++;
            await randomDelay(1200, 2200); // Schonende Pause zwischen Profilabrufen
        } catch (err) {
            console.error(`Fehler bei ${entry.name}:`, err.message);
            if (old) updatedPlayers.push({ ...old, rank: entry.rank, points: entry.points });
        }
    }

    const output = {
        updatedAt: new Date().toISOString(),
        totalPlayers: updatedPlayers.length,
        players: updatedPlayers
    };

    fs.writeFileSync(DATA_FILE, JSON.stringify(output, null, 2));
    console.log(`Fertig! ${fetchedProfiles} Profile neu geladen, ${updatedPlayers.length - fetchedProfiles} aus Cache übernommen.`);
}

run();
