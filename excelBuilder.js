// excelBuilder.js — Excel generation with EXACT required columns:
// S.No | DOI No | Title | URL | Altmetric Score | Altmetrics URL
const ExcelJS = require('exceljs');

const C = {
  NAVY: '0F1F3D', BLUE: '1B4F9B', BLUE2: '2563C4',
  ACCENT: 'F59E0B', GREEN: '059669', ALT: 'F7F9FD',
  EVEN: 'FFFFFF', BORDER: 'DBE4F2',
};
const fill  = h => ({ type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + h } });
const fnt   = o => ({ name: 'Calibri', ...o });
const align = (h, v = 'middle', wrap = false) => ({ horizontal: h, vertical: v, wrapText: wrap });
const border = {
  top:    { style: 'thin', color: { argb: 'FF' + C.BORDER } },
  bottom: { style: 'thin', color: { argb: 'FF' + C.BORDER } },
  left:   { style: 'thin', color: { argb: 'FF' + C.BORDER } },
  right:  { style: 'thin', color: { argb: 'FF' + C.BORDER } },
};
function hyperlink(cell, url, display) {
  cell.value = { text: display || url, hyperlink: url };
  cell.font  = fnt({ size: 9, color: { argb: 'FF' + C.BLUE2 }, underline: true });
}

async function buildExcel(items, exportDateStr) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Altmetric Score Viewer';
  wb.created = new Date();

  // ── SHEET 1: Altmetric Tracker ─────────────────────────────────────────
  const ws = wb.addWorksheet('Altmetric Tracker', {
    views: [{ showGridLines: false, state: 'frozen', ySplit: 6 }],
    pageSetup: { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1 }
  });

  // Column widths — exactly 6 columns
  const COLS = [
    { header: 'S.No',            width: 6   },
    { header: 'DOI No',          width: 36  },
    { header: 'Title',           width: 58  },
    { header: 'Article URL',     width: 42  },
    { header: 'Altmetric Score', width: 16  },
    { header: 'Altmetrics URL',  width: 42  },
  ];
  COLS.forEach((col, i) => { ws.getColumn(i + 1).width = col.width; });

  // Row heights
  [1,5].forEach(r => { ws.getRow(r).height = 8; });
  ws.getRow(2).height = 40;
  ws.getRow(3).height = 18;
  ws.getRow(4).height = 10;
  ws.getRow(6).height = 30;

  // ── Banner row 1 filler
  ws.mergeCells('A1:F1'); ws.getCell('A1').fill = fill('F1F5FC');

  // ── Title banner
  ws.mergeCells('A2:F2');
  Object.assign(ws.getCell('A2'), {
    value: 'ALTMETRIC SCORE TRACKER',
    font:  fnt({ bold: true, size: 22, color: { argb: 'FFFFFFFF' } }),
    fill:  fill(C.NAVY),
    alignment: align('center'),
  });

  // ── Sub banner
  ws.mergeCells('A3:F3');
  Object.assign(ws.getCell('A3'), {
    value: `Exported: ${exportDateStr}   |   ${items.length} Article(s)`,
    font:  fnt({ size: 10, italic: true, color: { argb: 'FFFFFFFF' } }),
    fill:  fill(C.BLUE),
    alignment: align('center'),
  });

  // ── Accent line
  ws.mergeCells('A4:F4'); ws.getCell('A4').fill = fill(C.ACCENT);

  // ── Spacer
  ws.mergeCells('A5:F5'); ws.getCell('A5').fill = fill('F8FAFF');

  // ── Header row
  COLS.forEach((col, i) => {
    const cell = ws.getCell(6, i + 1);
    cell.value     = col.header;
    cell.font      = fnt({ bold: true, size: 11, color: { argb: 'FFFFFFFF' } });
    cell.fill      = fill(C.BLUE);
    cell.alignment = align('center', 'middle', true);
    cell.border    = {
      bottom: { style: 'medium', color: { argb: 'FF' + C.ACCENT } },
      right:  { style: 'thin',   color: { argb: 'FFFFFFFF' } },
    };
  });

  // ── Data rows
  items.forEach((item, i) => {
    const rowNum = 7 + i;
    ws.getRow(rowNum).height = 26;
    const bg = i % 2 === 0 ? C.ALT : C.EVEN;

    const sno       = item.sno || String(i + 1);
    const doi       = item.doi || '';
    const title     = item.title || '';
    const artUrl    = item.articleUrl || item.original || '';
    const score     = item.score != null ? Number(item.score) : null;
    const altId     = item.altmetricId || '';
    const altUrl    = item.altmetricDetailsUrl ||
      (altId ? `https://www.altmetric.com/details/${altId}`
             : doi ? `https://www.altmetric.com/details/doi/${doi}` : '');
    const doiUrl    = doi ? `https://doi.org/${doi}` : '';

    // A: S.No
    const a = ws.getCell(rowNum, 1);
    a.value = isNaN(Number(sno)) ? sno : Number(sno);
    a.font  = fnt({ bold: true, size: 10, color: { argb: 'FF' + C.BLUE } });
    a.fill  = fill(bg); a.alignment = align('center'); a.border = border;

    // B: DOI No (hyperlink)
    const b = ws.getCell(rowNum, 2);
    b.fill = fill(bg); b.alignment = align('left', 'middle'); b.border = border;
    if (doiUrl) hyperlink(b, doiUrl, doi);
    else { b.value = doi || '—'; b.font = fnt({ size: 9, color: { argb: 'FF888888' } }); }

    // C: Title
    const c = ws.getCell(rowNum, 3);
    c.value = title; c.fill = fill(bg);
    c.font  = fnt({ size: 10, color: { argb: 'FF' + C.NAVY } });
    c.alignment = align('left', 'middle', true); c.border = border;

    // D: URL (hyperlink)
    const d = ws.getCell(rowNum, 4);
    d.fill = fill(bg); d.alignment = align('left', 'middle'); d.border = border;
    if (artUrl) hyperlink(d, artUrl, artUrl);
    else { d.value = ''; d.font = fnt({ size: 9 }); }

    // // E: Altmetric Score
    // const e = ws.getCell(rowNum, 5);
    // e.value     = score;
    // e.font      = fnt({ size: 12, bold: score != null, color: { argb: score != null ? 'FF' + C.NAVY : 'FFaaaaaa' } });
    // e.fill      = fill(score != null ? 'E8F5EE' : bg);
    // e.alignment = align('center');
    // e.border    = border;
    // e.numFmt    = '#,##0.0;(#,##0.0);"-"';

    // E: Altmetric Score
      const e = ws.getCell(rowNum, 5);

      if (score != null) {
        e.value     = score;
        e.font      = fnt({ size: 12, bold: true, color: { argb: 'FF' + C.NAVY } });
        e.fill      = fill('E8F5EE');
        e.numFmt    = '#,##0.0';
      } else {
        e.value = 'N/A';
        e.font  = fnt({ size: 10, bold: true, color: { argb: 'FFDC2626' } }); // red bold
        e.fill  = fill('FEF2F2');                                               // light red bg
      }

      e.alignment = align('center');
      e.border    = border;

    // F: Altmetrics URL (hyperlink)
    const f = ws.getCell(rowNum, 6);
    f.fill = fill(bg); f.alignment = align('left', 'middle'); f.border = border;
    if (altUrl) hyperlink(f, altUrl, altUrl);
    else { f.value = ''; f.font = fnt({ size: 9 }); }
  });

  // Footer
  const fr = 7 + items.length + 1;
  ws.getRow(fr).height = 14;
  ws.mergeCells(`A${fr}:F${fr}`);
  const fc = ws.getCell(`A${fr}`);
  fc.value     = `ℹ  Generated by Altmetric Score Viewer  |  Scores fetched live from Altmetric API  |  ${exportDateStr}`;
  fc.font      = fnt({ size: 8, italic: true, color: { argb: 'FF5A6A82' } });
  fc.fill      = fill('F0F4FA');
  fc.alignment = align('center');
  fc.border    = { top: { style: 'medium', color: { argb: 'FF' + C.BLUE } } };

  // Auto-filter
  ws.autoFilter = { from: 'A6', to: 'F6' };

  // ── SHEET 2: Summary ─────────────────────────────────────────────────────
  const ws2 = wb.addWorksheet('Summary', { views: [{ showGridLines: false }] });
  ws2.getColumn(1).width = 30; ws2.getColumn(2).width = 22;
  ws2.getRow(1).height = 40;

  ws2.mergeCells('A1:B1');
  Object.assign(ws2.getCell('A1'), {
    value: 'SUMMARY DASHBOARD',
    font: fnt({ bold: true, size: 16, color: { argb: 'FFFFFFFF' } }),
    fill: fill(C.NAVY), alignment: align('center'),
  });
  ws2.getRow(2).height = 14;
  ws2.mergeCells('A2:B2'); ws2.getCell('A2').fill = fill(C.ACCENT);

  const last = 6 + items.length;
  const summaryData = [
    null,
    { section: 'Export Info' },
    { label: 'Export Date',            val: exportDateStr },
    { label: 'Total Articles',         val: { formula: `COUNTA('Altmetric Tracker'!A7:A${last})` } },
    null,
    { section: 'Score Summary' },
    { label: 'Articles with Score',    val: { formula: `COUNTIF('Altmetric Tracker'!E7:E${last},">0")` } },
    { label: 'Articles without Score', val: { formula: `COUNTBLANK('Altmetric Tracker'!E7:E${last})` } },
    { label: 'Highest Score',          val: { formula: `MAX('Altmetric Tracker'!E7:E${last})` } },
    { label: 'Lowest Score (>0)',      val: { formula: `MIN(IF('Altmetric Tracker'!E7:E${last}>0,'Altmetric Tracker'!E7:E${last}))` } },
    { label: 'Average Score',          val: { formula: `IFERROR(AVERAGEIF('Altmetric Tracker'!E7:E${last},">0"),"N/A")` } },
    { label: 'Total Score',            val: { formula: `SUM('Altmetric Tracker'!E7:E${last})` } },
  ];

  let r = 3;
  summaryData.forEach((sd, idx) => {
    ws2.getRow(r).height = 22;
    if (!sd) { r++; return; }
    if (sd.section) {
      ws2.mergeCells(`A${r}:B${r}`);
      const sc = ws2.getCell(`A${r}`);
      sc.value = sd.section;
      sc.font  = fnt({ bold: true, size: 10, color: { argb: 'FFFFFFFF' } });
      sc.fill  = fill(C.BLUE2);
      sc.alignment = { horizontal: 'left', vertical: 'middle', indent: 1 };
      r++; return;
    }
    const bg2 = idx % 2 === 0 ? C.ALT : C.EVEN;
    const lc = ws2.getCell(r, 1); const vc = ws2.getCell(r, 2);
    lc.value = sd.label; lc.font = fnt({ size: 10 }); lc.fill = fill(bg2);
    lc.alignment = { horizontal: 'left', vertical: 'middle', indent: 2 }; lc.border = border;
    vc.value = sd.val; vc.font = fnt({ bold: true, size: 10, color: { argb: 'FF' + C.NAVY } });
    vc.fill = fill(bg2); vc.alignment = align('center'); vc.border = border;
    vc.numFmt = '#,##0.0'; r++;
  });

  const buf = await wb.xlsx.writeBuffer();
  return Buffer.from(buf);
}

module.exports = { buildExcel };