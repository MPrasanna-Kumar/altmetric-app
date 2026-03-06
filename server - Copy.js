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
const PORT         = parseInt(process.env.PORT)         || 8010;
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

// ── Helpers ────────────────────────────────────────────────────────────────
function normaliseInput(raw) {
  let s = raw.trim();
  s = s.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '');
  s = s.replace(/^doi:\s*/i, '');
  const m = s.match(/\b(10\.\d{4,}\/[^\s?#"'<>]+)/);
  return m ? m[1].replace(/[.,;)]+$/, '') : s;
}
function isValidDoi(s) { return /^10\.\d{4,}\/.+/.test(String(s||'')); }
function extractAltmetricId(raw) {
  const m = String(raw).match(/altmetric\.com\/details\/(\d+)/i);
  return m ? m[1] : '';
}

// ── Generic HTTP GET with timeout → string ─────────────────────────────────
function httpGet(url, timeoutMs = HTTP_TIMEOUT) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, {
      headers:{ 'User-Agent':'AltmetricViewer/2.0', 'Accept':'application/json,text/html' },
      timeout: timeoutMs
    }, (res) => {
      if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location)
        return httpGet(res.headers.location, timeoutMs).then(resolve);
      let body = '';
      res.on('data', c => { body += c; if(body.length>200000) req.destroy(); });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
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

// ── Resolve URL → DOI via HTML scraping ───────────────────────────────────
async function resolveDoi(articleUrl) {
  if (!articleUrl || !articleUrl.startsWith('http')) return null;
  const pii = articleUrl.match(/\/pii\/(S[A-Z0-9]+)/i);
  if (pii) { const d = await crossrefByPii(pii[1]); if(d) return d; }
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
      const doi = m[1].replace(/^https?:\/\/(dx\.)?doi\.org\//i,'').trim().replace(/[.,;)]+$/,'');
      if (isValidDoi(doi)) return doi;
    }
  }
  const fb = html.match(/\b(10\.\d{4,}\/[^\s"'<>]+)/);
  return fb ? fb[1].replace(/[.,;)]+$/,'') : null;
}

// ── Fully resolve one item ─────────────────────────────────────────────────
async function resolveItem(item) {
  let doi = isValidDoi(item.doi) ? item.doi : '';

  if (!doi && item.articleUrl && item.articleUrl.startsWith('http')) {
    doi = await resolveDoi(item.articleUrl) || '';
  }

  if (doi) {
    const cr = await fetchCrossrefMeta(doi);
    if (cr) return { ...item, ...cr, doi, score: null,
      altmetricId: item.altmetricId || '',
      detailsUrl: `https://www.altmetric.com/details/doi/${doi}` };
  }

  return { ...item, doi, score: null, title: item.title || '',
           altmetricId: item.altmetricId || '', detailsUrl: '' };
}

// ── Build article card HTML ────────────────────────────────────────────────
function buildRow(item, index) {
  const { doi, altmetricId, articleUrl, original, score, title,
          journal, publishedOn, authors, pubmedId, detailsUrl } = item;
  const valid    = isValidDoi(doi);
  const viewUrl  = articleUrl || original || (valid ? `https://doi.org/${doi}` : '#');
  const altUrl   = detailsUrl || (altmetricId
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
  <div class="article-card${valid?'':' invalid'}" data-index="${index}">
    <div class="card-sno">${index+1}</div>

    <div class="card-badge">
      ${valid
        ? `<div class="altmetric-embed"
               data-badge-type="medium-donut" data-badge-popover="right"
               data-hide-no-mentions="false" data-link-target="_blank"
               ${altmetricId?`data-altmetric-id="${altmetricId}"`:`data-doi="${doi}"`}></div>`
        : `<div class="badge-ph"><svg width="26" height="26" fill="none" stroke="#c0cce0" stroke-width="1.5" viewBox="0 0 24 24">
             <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg></div>`}
    </div>

    <div class="card-body">
      <div class="card-top">
        <div class="card-title-block">
          <div class="card-title">${title || '<span style="color:#b8c4d8;font-style:italic;font-weight:400">Title not available</span>'}</div>
          <div class="card-doi">
            ${valid
              ? `<span class="doi-chip">DOI</span><a href="https://doi.org/${doi}" target="_blank">${doi}</a>`
              : `<span class="invalid-doi">⚠ No DOI — <em>${(articleUrl||'').slice(0,80)}</em></span>`}
          </div>
        </div>
        <div class="card-score-wrap">
          <div class="score-badge loading">
            <div class="score-num loading">…</div>
            <div class="score-lbl">Score</div>
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
            <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
          </svg>View Article</a>
        <a class="card-link alink" href="${altUrl}" target="_blank">
          <svg width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
            <circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>
          </svg>Altmetric Details</a>
      </div>` : ''}
    </div>
  </div>`;
}

// ── Routes ─────────────────────────────────────────────────────────────────
app.get('/', (req,res) => {
  log.info('Serving index page');
  res.send(fs.readFileSync(path.join(__dirname,'views/index.html'),'utf8'));
});

app.post('/results', async (req,res) => {
  const raw  = req.body.dois || '';
  const seen = new Set();

  const lines = raw.split(/[\n\r]+/).flatMap(line => {
    const tokens = line.trim().split(/\s+/);
    return (tokens.length>1 && tokens.every(t=>t.startsWith('http'))) ? tokens : [line.trim()];
  }).filter(Boolean);

  let items = lines.map(line => {
    const altmetricId = extractAltmetricId(line);
    const cleaned     = line.replace(/https?:\/\/www\.altmetric\.com\/details\/\d+/gi,'').trim();
    const doi         = normaliseInput(cleaned||line);
    const articleUrl  = cleaned||line;
    return { original:line, articleUrl, doi, altmetricId, score:null,
             title:'', journal:'', publishedOn:'', authors:'', pubmedId:'', detailsUrl:'' };
  }).filter(item => {
    const key = item.doi||item.articleUrl;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });

  if (!items.length) return res.redirect('/');

  log.info(`Processing ${items.length} article(s) — resolving metadata…`);

  for (let i=0; i<items.length; i+=BATCH_SIZE) {
    const chunk   = items.slice(i, i+BATCH_SIZE);
    const resolved = await Promise.all(chunk.map(item => resolveItem(item)));
    for (let j=0; j<chunk.length; j++) items[i+j] = resolved[j];
  }

  const withScore = items.filter(it => typeof it.score==='number' && isFinite(it.score)).length;
  log.success(`Done — ${withScore}/${items.length} articles have Altmetric scores`);

  const rowsHtml   = items.map((item,i) => buildRow(item,i)).join('\n');
  const exportData = items.map((item,i) => ({
    sno:         String(i+1),
    title:       item.title || '',
    original:    item.original,
    articleUrl:  item.articleUrl||item.original,
    doi:         isValidDoi(item.doi) ? item.doi : '',
    altmetricId: item.altmetricId||'',
    score:       item.score,
    doiUrl:      isValidDoi(item.doi) ? `https://doi.org/${item.doi}` : '',
    altmetricDetailsUrl: item.detailsUrl||
      (item.altmetricId ? `https://www.altmetric.com/details/${item.altmetricId}`
       : isValidDoi(item.doi) ? `https://www.altmetric.com/details/doi/${item.doi}` : '')
  }));

  let html = fs.readFileSync(path.join(__dirname,'views/results.html'),'utf8');
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