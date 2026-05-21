require('dotenv').config();

const express        = require('express');
const fs             = require('fs');
const path           = require('path');
const https          = require('https');
const http           = require('http');
const { buildExcel } = require('./excelBuilder');

// ══════════════════════════════════════════════════════════════════
//  ENV CONFIG
// ══════════════════════════════════════════════════════════════════
const HOST         = process.env.HOST         || '0.0.0.0';
const PORT         = parseInt(process.env.PORT)         || 8011;
const BATCH_SIZE   = parseInt(process.env.BATCH_SIZE)   || 3;
const HTTP_TIMEOUT = parseInt(process.env.API_TIMEOUT)  || 8000;
const BODY_LIMIT   = process.env.MAX_FILE_SIZE
  ? `${Math.round(parseInt(process.env.MAX_FILE_SIZE)/1024/1024)}mb`
  : '10mb';

// ══════════════════════════════════════════════════════════════════
//  PROFESSIONAL CONSOLE LOGGER
// ══════════════════════════════════════════════════════════════════
const C = {
  reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m',
  cyan:'\x1b[36m', green:'\x1b[32m', yellow:'\x1b[33m',
  blue:'\x1b[34m', red:'\x1b[31m', magenta:'\x1b[35m',
  white:'\x1b[37m', gray:'\x1b[90m',
};
const pad = (s,n) => String(s).padEnd(n);
const ts  = () => new Date().toLocaleTimeString('en-US',{hour12:false});
const log = {
  info:    msg => console.log(`${C.gray}${ts()}${C.reset} ${C.cyan}ℹ${C.reset}  ${msg}`),
  success: msg => console.log(`${C.gray}${ts()}${C.reset} ${C.green}✓${C.reset}  ${msg}`),
  warn:    msg => console.log(`${C.gray}${ts()}${C.reset} ${C.yellow}⚠${C.reset}  ${msg}`),
  error:   msg => console.log(`${C.gray}${ts()}${C.reset} ${C.red}✖${C.reset}  ${msg}`),
  request: (method,url,code,ms) => {
    const badge = code<300?`${C.green}${code}${C.reset}`:code<400?`${C.yellow}${code}${C.reset}`:`${C.red}${code}${C.reset}`;
    console.log(`${C.gray}${ts()}${C.reset} ${C.bold}${C.blue}${pad(method,4)}${C.reset} ${pad(url,38)} ${badge} ${C.dim}${ms}ms${C.reset}`);
  },
  banner: () => {
    console.log('');
    console.log(`${C.cyan}${C.bold}  ╔═══════════════════════════════════════════╗${C.reset}`);
    console.log(`${C.cyan}${C.bold}  ║${C.reset}  ${C.bold}${C.white}ALTMETRIC SCORE VIEWER${C.reset}  ${C.gray}v2.0.0${C.reset}              ${C.cyan}${C.bold}║${C.reset}`);
    console.log(`${C.cyan}${C.bold}  ╚═══════════════════════════════════════════╝${C.reset}`);
    console.log('');
  }
};

const app = express();
app.use(express.urlencoded({ extended:true, limit: BODY_LIMIT }));
app.use(express.json({ limit: BODY_LIMIT }));

app.use((req,res,next) => {
  const start = Date.now();
  res.on('finish', () => log.request(req.method, req.url, res.statusCode, Date.now()-start));
  next();
});


// Add this helper
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise(resolve =>
      setTimeout(() => {
        log.warn(`Item timeout after ${ms}ms — skipping: ${label}`);
        resolve(null);
      }, ms)
    )
  ]);
}


// ── Helpers ────────────────────────────────────────────────────────────────
// AFTER
// ── 1. normaliseInput ──────────────────────────────────────────────────────
function normaliseInput(raw) {
  let s = raw.trim();
 
  // Strip doi.org resolver prefixes → bare DOI
  s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  s = s.replace(/^doi:\s*/i, '');
 
  // Universal: extract DOI from anywhere in the string
  const m = s.match(/\b(10\.\d{4,}\/[^\s?#"'<>]+)/);
  if (m) {
    let doi = m[1].replace(/[.,;)]+$/, '');
    doi = doi.replace(/\/(html|full|abstract|pdf|epdf|full-text|htm)$/i, '');
    if (isValidDoi(doi)) return doi;
  }
 
  // ── Nature / Springer Nature / BioMedCentral slug → DOI ──────────────────
  // Handles:
  //   https://www.nature.com/articles/s41392-024-02060-3
  //   https://www.nature.com/articles/s41392-025-02150-w
  //   https://www.biomedcentral.com/articles/10.1186/s13059-...  (caught above)
  //   https://link.springer.com/article/10.1007/s00401-...       (caught above)
  const natureSlugMatch = s.match(/(?:nature\.com|springernature\.com|biomedcentral\.com)\/articles\/(s\d{5}-\d{3,4}-\d{5}-[\w-]+)/i);
  if (natureSlugMatch) 
  {

    const doi = `10.1038/${natureSlugMatch[1]}`;

    log.info(`Nature slug match: "${natureSlugMatch[1]}" → DOI: ${doi}`);

    if (isValidDoi(doi)) return doi;

    log.warn(`Nature DOI failed validation: ${doi}`);

  } 
  // No DOI found — return as-is (handled by resolveDoi / Crossref fallback)
  return s;
}
 
 
function isValidDoi(s) { return /^10\.\d{4,}\/.+/.test(String(s||'')); }
function extractAltmetricId(raw) {
  const m = String(raw).match(/altmetric\.com\/details\/(\d+)/i);
  return m ? m[1] : '';
}

// ── Generic HTTP GET with timeout → string ─────────────────────────────────
function httpGet(url, timeoutMs = HTTP_TIMEOUT) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (val) => { if (!settled) { settled = true; resolve(val); } };

    const mod = url.startsWith('https') ? https : http;

    const req = mod.get(url, {
      headers: { 'User-Agent': 'AltmetricViewer/2.0', 'Accept': 'application/json,text/html' },
    }, (res) => {
      // Follow redirects
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
        res.resume(); // drain and discard
        return httpGet(res.headers.location, timeoutMs).then(done);
      }

      let body = '';
      const bodyTimer = setTimeout(() => {
        req.destroy();
        log.warn(`Body read timeout: ${url.slice(0, 80)}`);
        done(null);
      }, timeoutMs);

      res.on('data', c => {
        body += c;
        if (body.length > 200000) { req.destroy(); }
      });
      res.on('end', () => {
        clearTimeout(bodyTimer);
        done({ status: res.statusCode, body });
      });
      res.on('error', () => { clearTimeout(bodyTimer); done(null); });
    });

    // Hard connection timeout
    const connTimer = setTimeout(() => {
      req.destroy(new Error('connect timeout'));
      log.warn(`Connect timeout: ${url.slice(0, 80)}`);
      done(null);
    }, timeoutMs);

    req.on('socket', (socket) => {
      socket.setTimeout(timeoutMs);
      socket.on('timeout', () => {
        req.destroy();
        log.warn(`Socket timeout: ${url.slice(0, 80)}`);
        done(null);
      });
    });

    req.on('error', () => { clearTimeout(connTimer); done(null); });
    req.on('close', () => clearTimeout(connTimer));
  });
}



// ── Crossref: fetch title + metadata by DOI ────────────────────────────────
async function fetchCrossrefMeta(doi) {
  if (!isValidDoi(doi)) return null;
  const mailto = process.env.CROSSREF_MAILTO || 'altmetric-viewer@app';
  const base   = process.env.CROSSREF_BASE_URL || 'https://api.crossref.org';
  const url = `${base}/works/${doi}?mailto=${mailto}`;
  const res = await httpGet(url);
  if (!res || res.status !== 200) return null;
  try {
    const w = JSON.parse(res.body).message;
    if (!w) return null;
    const titleArr = w.title || w['short-title'] || [];
    const title    = (Array.isArray(titleArr) ? titleArr[0] : titleArr) || '';
    const journal  = (w['container-title']||[])[0] || '';
    let publishedOn = '';
    const dp = w.published?.['date-parts']?.[0];
    if (dp?.[0]) publishedOn = new Date(dp[0],(dp[1]||1)-1,dp[2]||1)
      .toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'});
    const authors = (w.author||[]).slice(0,5)
      .map(a=>a.name||[a.given,a.family].filter(Boolean).join(' ')).join(', ')
      + ((w.author||[]).length>5?' et al.':'');
    return { title, journal, publishedOn, authors, doi: w.DOI||doi };
  } catch { return null; }
}

// ── Crossref: PII → DOI ────────────────────────────────────────────────────
async function crossrefByPii(pii) {
  const mailto = process.env.CROSSREF_MAILTO || 'altmetric-viewer@app';
  const base   = process.env.CROSSREF_BASE_URL || 'https://api.crossref.org';
  const url = `${base}/works?filter=alternative-id:${pii}&rows=1&mailto=${mailto}`;
  log.info(`Crossref PII → ${pii}`);
  const res = await httpGet(url);
  if (!res || res.status !== 200) return null;
  try {
    const doi = JSON.parse(res.body).message?.items?.[0]?.DOI;
    if (doi) log.success(`Crossref PII resolved → ${doi}`);
    return doi ? doi.toLowerCase() : null;
  } catch { return null; }
}

// ── 2. crossrefByUrl  (NEW — add this after crossrefByPii) ────────────────
// Resolves any article page URL → DOI via Crossref query.
// Works for Nature, Springer, Wiley, Taylor & Francis, etc.
// Does NOT scrape the publisher site, so it is never blocked.
async function crossrefByUrl(articleUrl) {
  if (!articleUrl || !articleUrl.startsWith('http')) return null;
 
  const mailto = process.env.CROSSREF_MAILTO || 'altmetric-viewer@app';
  const base   = process.env.CROSSREF_BASE_URL || 'https://api.crossref.org';
 
  // Extract the slug/identifier at the end of the URL path for verification
  // e.g. "s41392-024-02060-3" or "nature12345"
  const slugMatch = articleUrl.match(/\/articles?\/([\w.-]+)\/?$/i)
                 || articleUrl.match(/\/(?:full|abstract|html)?\/([\w.-]+)\/?$/i);
  const slug = slugMatch ? slugMatch[1] : '';
 
  // Query Crossref with the full URL as a free-text query
  const encoded = encodeURIComponent(articleUrl);
  const url = `${base}/works?query=${encoded}&rows=3&mailto=${mailto}`;
 
  log.info(`Crossref URL lookup → ${articleUrl}`);
  const res = await httpGet(url);
  if (!res || res.status !== 200) return null;
 
  try {
    const items = JSON.parse(res.body).message?.items || [];
    for (const item of items) {
      if (!item.DOI) continue;
      const doi = item.DOI.toLowerCase();
 
      // Primary check: DOI suffix should contain the URL slug
      if (slug && doi.includes(slug.toLowerCase())) {
        log.success(`Crossref URL resolved → ${doi}`);
        return doi;
      }
 
      // Fallback: check if Crossref's registered links match the domain
      const links = [
        ...(item.link || []).map(l => l.URL || ''),
        ...(item.resource?.primary ? [item.resource.primary.URL] : []),
      ];
      const domain = articleUrl.replace(/^https?:\/\//i, '').split('/')[0];
      if (links.some(l => l && l.includes(domain))) {
        log.success(`Crossref URL resolved (link match) → ${doi}`);
        return doi;
      }
    }
    return null;
  } catch {
    return null;
  }
}
 

// ── Resolve URL → DOI via HTML scraping ───────────────────────────────────
// AFTER (add these lines at the top of resolveDoi, before the PII check)

// ── 3. resolveDoi ─────────────────────────────────────────────────────────
async function resolveDoi(articleUrl) {
  if (!articleUrl || !articleUrl.startsWith('http')) return null;
 
  // ── De Gruyter: DOI is in the URL path ───────────────────────────────────
  // e.g. https://www.degruyterbrill.com/document/doi/10.1515/gps-2024-0233/html
  const dgMatch = articleUrl.match(/\/doi\/(10\.\d{4,}\/[^/?#"'<>\s]+)/i);
  if (dgMatch) {
    const doi = dgMatch[1].replace(/[.,;)\/]+$/, '');
    if (isValidDoi(doi)) {
      log.success(`De Gruyter URL → DOI extracted: ${doi}`);
      return doi;
    }
  }
 
  // ── ScienceDirect PII ─────────────────────────────────────────────────────
  const pii = articleUrl.match(/\/pii\/(S[A-Z0-9]+)/i);
  if (pii) {
    const d = await crossrefByPii(pii[1]);
    if (d) return d;
  }
 
  // ── Crossref URL lookup (Nature, Springer, Wiley, T&F, BMC, etc.) ─────────
  // Preferred over HTML scraping — publishers block bots, Crossref never does.
  const crDoi = await crossrefByUrl(articleUrl);
  if (crDoi) return crDoi;
 
  // ── Generic HTML meta tag scrape (last resort) ────────────────────────────
  const res = await httpGet(articleUrl, HTTP_TIMEOUT);
  if (!res || res.status !== 200) return null;
  const html = res.body;
  const patterns = [
    /<meta[^>]+name=["']citation_doi["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']citation_doi["']/i,
    /<meta[^>]+name=["']dc\.identifier["'][^>]+content=["'](10\.[^"']+)["']/i,
  ];
  for (const pat of patterns) {
    const m = html.match(pat);
    if (m) {
      const doi = m[1]
        .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
        .trim()
        .replace(/[.,;)]+$/, '');
      if (isValidDoi(doi)) return doi;
    }
  }
 
  // Last-ditch: bare DOI anywhere in the HTML body
  const fb = html.match(/\b(10\.\d{4,}\/[^\s"'<>]+)/);
  return fb ? fb[1].replace(/[.,;)]+$/, '') : null;
}



// ── Fully resolve one item ─────────────────────────────────────────────────
// Already exists — but add per-item logging in resolveItem:
async function resolveItem(item) {
  log.info(`resolveItem start → ${item.doi || item.articleUrl}`);
  let doi = isValidDoi(item.doi) ? item.doi : '';

  if (!doi && item.articleUrl && item.articleUrl.startsWith('http')) {
    doi = await resolveDoi(item.articleUrl) || '';
  }

  if (doi) {
    log.info(`fetchCrossrefMeta → ${doi}`);
    const cr = await fetchCrossrefMeta(doi);
    log.info(`fetchCrossrefMeta done → ${doi} — title: ${cr?.title?.slice(0,40) || 'null'}`);
    if (cr) return { ...item, ...cr, doi, score: null,
      altmetricId: item.altmetricId || '',
      detailsUrl: `https://www.altmetric.com/details/doi/${doi}` };
  }

  log.warn(`resolveItem fallback (no metadata) → ${doi || item.articleUrl}`);
  return { ...item, doi, score: null, title: item.title || '',
           altmetricId: item.altmetricId || '', detailsUrl: '' };
}

function buildRow(item, index) {
  const { doi, altmetricId, articleUrl, original, score, title,
          journal, publishedOn, authors, pubmedId, detailsUrl } = item;
  const valid   = isValidDoi(doi);
  const viewUrl = articleUrl || original || (valid ? `https://doi.org/${doi}` : '#');
  const altUrl  = detailsUrl || (altmetricId
    ? `https://www.altmetric.com/details/${altmetricId}`
    : valid ? `https://www.altmetric.com/details/doi/${doi}` : '#');

  const hasScore = typeof score === 'number' && isFinite(score);
  const scoreDisplay = hasScore
    ? (Number.isInteger(score) ? String(score) : Number(score).toFixed(1))
    : '—';

  const chips = [];
  if (journal)     chips.push(`<span class="chip-tag journal">📖 ${journal}</span>`);
  if (publishedOn) chips.push(`<span class="chip-tag date">📅 ${publishedOn}</span>`);
  if (pubmedId)    chips.push(`<span class="chip-tag pmid">PMID ${pubmedId}</span>`);

  return `
  <div class="article-card${valid ? '' : ' invalid'}" data-index="${index}">
    <div class="card-sno">${index + 1}</div>

    <div class="card-badge">
      ${valid
        ? `<div class="altmetric-embed"
               data-badge-type="medium-donut"
               data-badge-popover="right"
               data-hide-no-mentions="false"
               data-link-target="_blank"
               ${altmetricId ? `data-altmetric-id="${altmetricId}"` : `data-doi="${doi}"`}></div>`
        : `<div class="badge-ph">
             <svg width="26" height="26" fill="none" stroke="#c0cce0" stroke-width="1.5" viewBox="0 0 24 24">
               <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
             </svg>
           </div>`}
    </div>

    <div class="card-body">
      <div class="card-top">
        <div class="card-title-block">
          <div class="card-title">
            ${title || '<span style="color:#b8c4d8;font-style:italic;font-weight:400">Title not available</span>'}
          </div>
          <div class="card-doi">
            ${valid
              ? `<span class="doi-chip">DOI</span>
                 <a href="https://doi.org/${doi}" target="_blank">${doi}</a>`
              : `<span class="invalid-doi">⚠ No DOI — <em>${(articleUrl || '').slice(0, 80)}</em></span>`}
          </div>
        </div>

        <!-- Score badge — shows live value if server resolved it, else loading -->
        <div class="card-score-wrap">
          <div class="score-badge${hasScore ? '' : ' loading'}" data-score-badge="${index}">
            <div class="score-num${hasScore ? '' : ' loading'}" data-score-num="${index}">
              ${hasScore ? scoreDisplay : '…'}
            </div>
            <div class="score-lbl">
              ${hasScore ? 'Score' : 'Score'}
            </div>
          </div>
        </div>
      </div>

      ${chips.length ? `<div class="card-meta">${chips.join('')}</div>` : ''}
      ${authors ? `<div class="chip-authors">👥 ${authors}</div>` : ''}

      ${valid ? `
      <div class="card-links">
        <a class="card-link" href="${viewUrl}" target="_blank">
          <svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
            <polyline points="15 3 21 3 21 9"/>
            <line x1="10" y1="14" x2="21" y2="3"/>
          </svg>View Article
        </a>
        <a class="card-link alink" href="${altUrl}" target="_blank">
          <svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
          </svg>Altmetric Details
        </a>
        <button class="card-link skip-btn" data-index="${index}"
          onclick="skipCard(this)"
          style="background:none;border:none;cursor:pointer;padding:0;font-family:inherit">
          <svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>Skip
        </button>
      </div>` : ''}
    </div>
  </div>`;
}

// ── Routes ─────────────────────────────────────────────────────────────────
app.get('/', (req,res) => {
  log.info('Serving index page');
  res.send(fs.readFileSync(path.join(__dirname,'views/index.html'),'utf8'));
});

app.post('/results', async (req, res) => {
  const raw  = req.body.dois || '';
  const seen = new Set();

  const lines = raw.split(/[\n\r]+/).flatMap(line => {
    const tokens = line.trim().split(/\s+/);
    return (tokens.length > 1 && tokens.every(t => t.startsWith('http'))) ? tokens : [line.trim()];
  }).filter(Boolean);

  let items = lines.map(line => {
    const altmetricId = extractAltmetricId(line);
    const cleaned     = line.replace(/https?:\/\/www\.altmetric\.com\/details\/\d+/gi, '').trim();
    const doi         = normaliseInput(cleaned || line);
    const articleUrl  = cleaned || line;
    return {
      original: line, articleUrl, doi, altmetricId, score: null,
      title: '', journal: '', publishedOn: '', authors: '', pubmedId: '', detailsUrl: ''
    };
  }).filter(item => {
    const key = item.doi || item.articleUrl;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });

  if (!items.length) return res.redirect('/');

  log.info(`Processing ${items.length} article(s) — resolving metadata…`);

  // ── Batch loop — all awaits are INSIDE this async handler ────────────────
  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const chunk    = items.slice(i, i + BATCH_SIZE);
    const resolved = await Promise.all(
      chunk.map(item =>
        withTimeout(
          resolveItem(item),
          20000,                              // 20s max per article
          item.doi || item.articleUrl
        ).then(r => r || {                    // timed-out → return bare item
          ...item,
          score:       null,
          title:       item.title || '',
          altmetricId: item.altmetricId || '',
          detailsUrl:  ''
        })
      )
    );
    for (let j = 0; j < chunk.length; j++) items[i + j] = resolved[j];
  }

  const withScore = items.filter(it => typeof it.score === 'number' && isFinite(it.score)).length;
  log.success(`Done — ${withScore}/${items.length} articles have Altmetric scores`);

  const rowsHtml   = items.map((item, i) => buildRow(item, i)).join('\n');
  const exportData = items.map((item, i) => ({
    sno:         String(i + 1),
    title:       item.title || '',
    original:    item.original,
    articleUrl:  item.articleUrl || item.original,
    doi:         isValidDoi(item.doi) ? item.doi : '',
    altmetricId: item.altmetricId || '',
    score:       item.score,
    doiUrl:      isValidDoi(item.doi) ? `https://doi.org/${item.doi}` : '',
    altmetricDetailsUrl: item.detailsUrl ||
      (item.altmetricId
        ? `https://www.altmetric.com/details/${item.altmetricId}`
        : isValidDoi(item.doi)
          ? `https://www.altmetric.com/details/doi/${item.doi}`
          : '')
  }));

  let html = fs.readFileSync(path.join(__dirname, 'views/results.html'), 'utf8');
  html = html.replace('{{ROWS}}', rowsHtml);
  html = html.replace('{{EXPORT_DATA}}', JSON.stringify(exportData));
  res.send(html);
});

app.post('/export', async (req,res) => {
  let items;
  try { items = JSON.parse(req.body.data||'[]'); }
  catch(e) { return res.status(400).send('Invalid data'); }

  log.info(`Generating Excel for ${items.length} item(s)…`);
  const now     = new Date();
  const dateStr = now.toLocaleDateString('en-GB',{day:'2-digit',month:'long',year:'numeric'});
  const fileDate= now.toISOString().slice(0,10);
  try {
    const buf = await buildExcel(items, dateStr);
    log.success(`Excel generated (${(buf.length/1024).toFixed(1)} KB) → altmetric-tracker-${fileDate}.xlsx`);
    res.setHeader('Content-Disposition',`attachment; filename="altmetric-tracker-${fileDate}.xlsx"`);
    res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch(err) {
    log.error(`Excel generation failed: ${err.message}`);
    res.status(500).send('Excel generation failed: '+err.message);
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, HOST, () => {
  log.banner();
  log.success(`Server running on ${C.bold}${C.cyan}http://${HOST}:${PORT}${C.reset}`);
  log.info(`Network:  ${C.cyan}http://192.168.1.139:${PORT}${C.reset}`);
  log.info(`Local:    ${C.cyan}http://localhost:${PORT}${C.reset}`);
  log.info(`Views:    ${path.join(__dirname,'views')}`);
  log.info('Press Ctrl+C to stop');
  console.log('');
});