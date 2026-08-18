const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const fs = require('fs');
const path = require('path');
const moment = require('moment'); // You might need: npm install moment
const { tokenRequired } = require('../auth');

// Breathing room inside every table cell, in points. The gap that stops "12,75,670" and "12,49,706"
// printing as one number — with 0 padding a value as wide as its column touches the one beside it.
const CELL_PAD = 3;

class PDFReport {
    constructor() {
        // A4 size is roughly 595.28 x 841.89 points
        this.doc = new PDFDocument({ margin: 28, size: 'A4', bufferPages: true });
        this.pageNumber = 0;
        
        // Define margins (approx 10mm ~ 28pt)
        this.marginX = 28;
        this.marginY = 22; 
        
        // Setup listener for footers on new pages
        this.doc.on('pageAdded', () => {
            this.pageNumber++;
            this.drawFooter();
        });
    }

    drawHeader() {
        const logoPath = path.join(__dirname, '../static/assets/ecom-logo.png');
        
        // Image or Fallback Text
        if (fs.existsSync(logoPath)) {
            // FPDF: image(path, x=10, y=8, w=10) -> Approx 28pt x 22pt, width 28pt
            this.doc.image(logoPath, 28, 22, { width: 28 });
        } else {
            this.doc.font('Helvetica-Bold').fontSize(16).fillColor('black')
                .text('Ecom Central', 28, 22, { align: 'left' });
        }

        // Title
        this.doc.font('Helvetica-Bold').fontSize(20).fillColor([34, 44, 67])
            .text('Ad Set Performance Report', 0, 30, { align: 'center' }); // FPDF y=10 approx y=30pt

        // Date
        this.doc.font('Helvetica').fontSize(10).fillColor([128, 128, 128])
            .text(`Generated on: ${moment().format('MMMM DD, YYYY')}`, 0, 55, { align: 'center' });

        // Line (10mm to 200mm -> 28pt to 567pt, y=35mm -> 99pt)
        this.doc.save()
            .moveTo(28, 100)
            .lineTo(567, 100)
            .strokeColor([220, 220, 220])
            .stroke()
            .restore();
        
        this.doc.y = 120; // Set cursor after header
    }

    drawFooter() {
        // FPDF footer is usually called automatically. In PDFKit we draw it manually.
        const bottomY = this.doc.page.height - 40; // Approx -15mm
        
        this.doc.save();
        this.doc.font('Helvetica-Oblique').fontSize(8).fillColor([128, 128, 128]);
        
        // We write the page number. PDFKit buffers pages, so we can't easily get "Total Pages" during stream
        // without buffering the whole doc. Here we just print current page #.
        // If we want "Page X" we can do it at the end if bufferPages is true.
        // For streaming, we just render "Page X".
        // Note: The constructor enables bufferPages:true, so we can loop at the end if needed, 
        // but simple sequential numbering works fine here.
        this.doc.text(`Page ${this.pageNumber + 1}`, 0, bottomY, { align: 'center', width: this.doc.page.width });
        this.doc.restore();
    }

    createSummary(adsetData, since, until) {
        // 1. Aggregate Totals
        const totals = adsetData.reduce((acc, ad) => {
            acc.spend += (ad.spend || 0);
            acc.orders += (ad.totalOrders || 0);
            acc.revenue += (ad.deliveredRevenue || 0);
            acc.delivered += (ad.deliveredOrders || 0);
            acc.rto += (ad.rtoOrders || 0);
            acc.cancelled += (ad.cancelledOrders || 0);
            acc.inTransit += (ad.inTransitOrders || 0);
            return acc;
        }, { spend: 0, orders: 0, revenue: 0, delivered: 0, rto: 0, cancelled: 0, inTransit: 0 });

        // 2. Standard Metrics
        const overallRoas = totals.spend > 0 ? (totals.revenue / totals.spend) : 0;
        const denom = totals.delivered + totals.rto + totals.cancelled;
        const overallRtoPercent = denom > 0 ? ((totals.rto + totals.cancelled) / denom) : 0;

        // 3. Effective ROAS Calculation
        const globalDelAov = totals.delivered > 0 ? (totals.revenue / totals.delivered) : 0;
        const projectedRevenue = totals.revenue + (totals.inTransit * (1 - overallRtoPercent) * globalDelAov);
        const overallEffRoas = totals.spend > 0 ? (projectedRevenue / totals.spend) : 0;

        // Header
        this.doc.font('Helvetica-Bold').fontSize(12).fillColor('black').text('Report Summary', 28, this.doc.y);
        this.doc.moveDown(0.2);
        this.doc.font('Helvetica').fontSize(10).text(`Date Range: ${since} to ${until}`, 28);
        this.doc.moveDown(0.5);

        // Summary Box
        const boxX = 28;
        const boxY = this.doc.y;
        const boxW = 540; // approx 190mm
        const boxH = 96;  // approx 34mm

        this.doc.rect(boxX, boxY, boxW, boxH).fill([245, 247, 250]); // #F5F7FA

        const colW = boxW / 5;
        const labelY = boxY + 10;
        const valueY = boxY + 35;

        // Labels
        this.doc.font('Helvetica').fontSize(9).fillColor([80, 80, 80]);
        const labels = ['Total Spend', 'Total Orders', 'Overall RTO%', 'Overall ROAS', 'Eff. ROAS'];
        labels.forEach((lbl, i) => {
            this.doc.text(lbl, boxX + (colW * i), labelY, { width: colW, align: 'center' });
        });

        // Values
        this.doc.font('Helvetica-Bold').fontSize(10).fillColor('black');
        const values = [
            `Rs ${totals.spend.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`,
            totals.orders.toString(),
            (overallRtoPercent * 100).toFixed(1) + '%',
            overallRoas.toFixed(2) + 'x'
        ];

        // Draw first 4 values
        values.forEach((val, i) => {
            this.doc.text(val, boxX + (colW * i), valueY, { width: colW, align: 'center' });
        });

        // Draw Eff ROAS (Blue)
        this.doc.fillColor([67, 56, 202]); // #4338CA
        this.doc.text(overallEffRoas.toFixed(2) + 'x', boxX + (colW * 4), valueY, { width: colW, align: 'center' });

        this.doc.y = boxY + boxH + 17; // Move cursor down below box
        this.doc.fillColor('black');
    }

    createTable(adsetData) {
        // Column widths in POINTS, summing to 540 — sized from the widest value each column can ever
        // hold, not from an arbitrary ratio. The old ratio gave Spend and Rev 41.3pt each, but the
        // grand total "12,75,670" is ~40pt of glyphs at 9pt Helvetica-Bold, so with no padding left it
        // ran straight into the next column and printed "12,75,67012,49,706". Money columns are now
        // 48pt, and every cell is drawn inset by CELL_PAD so two full columns can never touch again.
        // Money columns get 54pt — the widest value today ("12,76,417") is 40pt, and the spare room is
        // deliberate: a month that crosses ₹1 crore adds two more characters, and this table should not
        // need re-tuning the first time that happens. Count columns are capped at 3–4 digits, so the
        // slack came from there.
        //        Name  Spend  Rev  Ord  Del  RTO  Cncl  Int  Prc  RTO%  CPO  ROAS  Eff
        const colWidths = [118,   54,  54,  31,  33,  28,   28,  30,  28,   36,  34,   33,  33];
        const availableWidth = colWidths.reduce((a, w) => a + w, 0);   // 540
        
        const headers = ["Ad Set / Source", "Spend", "Rev", "Ord", "Del", "RTO", "Cncl", "Int", "Prc", "RTO%", "CPO", "ROAS", "Eff.R"];

        const rowHeight = 28; // approx 10mm
        const fontSizeHeader = 8;
        const fontSizeBody = 8;

        // Draw Header
        let currentX = 28;
        const headerY = this.doc.y;
        
        // Header Background
        this.doc.rect(28, headerY, availableWidth, rowHeight).fill([67, 56, 202]); // Blue

        this.doc.font('Helvetica-Bold').fontSize(fontSizeHeader).fillColor('white');
        headers.forEach((h, i) => {
            // Vertical center alignment simulation: y + (h - fontH)/2
            // Or just simple padding top
            this.doc.text(h, currentX + CELL_PAD, headerY + 8, { width: colWidths[i] - CELL_PAD * 2, align: 'center' });
            currentX += colWidths[i];
        });
        // Column separators inside the header band — light, so they read as divisions of one bar
        // rather than as a second grid sitting on top of the indigo.
        this.drawGrid(headerY, rowHeight, colWidths, [255, 255, 255], 0.4, 0.35);
        this.tableTop = headerY;   // remembered so each page can close its own outer box

        this.doc.y += rowHeight;
        this.doc.fillColor('black');

        let fill = false;
        
        // Calculate Grand Totals
        const grandTotals = { spend: 0, orders: 0, delivered: 0, rto: 0, cancelled: 0, inTransit: 0, processing: 0, revenue: 0 };

        const processRowData = (data) => {
            const spend = data.spend || 0;
            const orders = data.totalOrders || 0;
            const revenue = data.deliveredRevenue || 0;
            const del = data.deliveredOrders || 0;
            const rto = data.rtoOrders || 0;
            const cncl = data.cancelledOrders || 0;
            const int = data.inTransitOrders || 0;
            const prc = data.processingOrders || 0;

            const denom = del + rto + cncl;
            const rtoRate = denom > 0 ? ((rto + cncl) / denom) : 0;
            const cpo = orders > 0 ? (spend / orders) : 0;
            const roas = spend > 0 ? (revenue / spend) : 0;

            const delAov = del > 0 ? (revenue / del) : 0;
            const projRev = revenue + (int * (1 - rtoRate) * delAov);
            const effRoas = spend > 0 ? (projRev / spend) : 0;

            return { spend, orders, revenue, del, rto, cncl, int, prc, rtoRate, cpo, roas, effRoas };
        };

        // Render Loop
        adsetData.forEach(adset => {
            // Aggregate Grand Totals
            grandTotals.spend += (adset.spend || 0);
            grandTotals.orders += (adset.totalOrders || 0);
            grandTotals.delivered += (adset.deliveredOrders || 0);
            grandTotals.rto += (adset.rtoOrders || 0);
            grandTotals.cancelled += (adset.cancelledOrders || 0);
            grandTotals.inTransit += (adset.inTransitOrders || 0);
            grandTotals.processing += (adset.processingOrders || 0);
            grandTotals.revenue += (adset.deliveredRevenue || 0);

            // Draw Adset Row
            const vals = processRowData(adset);
            this.drawRow(adset.name || 'N/A', vals, colWidths, fill, false, false);
            
            // Unattributed terms
            if (adset.id === 'unattributed' && adset.terms) {
                const terms = Array.isArray(adset.terms) ? adset.terms : Object.values(adset.terms);
                this.doc.font('Helvetica').fontSize(Math.max(6, fontSizeBody - 1));
                terms.forEach(term => {
                    const termVals = processRowData(term);
                    this.drawRow(term.name || 'term', termVals, colWidths, fill, true, false);
                });
                this.doc.font('Helvetica-Bold').fontSize(fontSizeBody);
            }
            
            fill = !fill;
        });

        // Grand Total Row
        const gtVals = processRowData({
            spend: grandTotals.spend,
            totalOrders: grandTotals.orders,
            deliveredRevenue: grandTotals.revenue,
            deliveredOrders: grandTotals.delivered,
            rtoOrders: grandTotals.rto,
            cancelledOrders: grandTotals.cancelled,
            inTransitOrders: grandTotals.inTransit,
            processingOrders: grandTotals.processing
        });
        
        this.doc.font('Helvetica-Bold').fontSize(fontSizeBody + 1);
        this.drawRow('GRAND TOTAL', gtVals, colWidths, true, false, true);

        // Signature
        this.drawSignatureBlock();
    }

    // Vertical column separators + the row's bottom line. Drawn AFTER the background fill and BEFORE
    // the text, so a filled row never paints over its own borders. `opacity` lets the header use faint
    // white dividers while body rows use a solid grey.
    drawGrid(y, rowH, widths, colour, lineWidth = 0.5, opacity = 1) {
        this.doc.save();
        this.doc.lineWidth(lineWidth).strokeColor(colour).strokeOpacity(opacity);
        let x = 28;
        for (let i = 0; i < widths.length; i++) {
            this.doc.moveTo(x, y).lineTo(x, y + rowH).stroke();   // left edge of every column
            x += widths[i];
        }
        this.doc.moveTo(x, y).lineTo(x, y + rowH).stroke();       // right edge of the table
        this.doc.moveTo(28, y + rowH).lineTo(x, y + rowH).stroke();
        this.doc.restore();
    }

    drawRow(name, vals, widths, fill, indent, isTotal) {
        // Pagination Check
        if (this.doc.y + 28 > this.doc.page.height - 50) {
            this.doc.addPage();
            this.drawHeader();
            this.doc.y = 120; // Reset Y
        }

        const y = this.doc.y;
        const rowH = 28;

        const tableW = widths.reduce((a, w) => a + w, 0);

        // Background
        if (isTotal) this.doc.rect(28, y, tableW, rowH).fill([220, 220, 220]);
        else if (fill) this.doc.rect(28, y, tableW, rowH).fill([243, 244, 246]);

        // Borders — every cell, over the fill and under the text.
        this.drawGrid(y, rowH, widths, [203, 208, 217], isTotal ? 0.8 : 0.5);

        this.doc.fillColor('black');
        
        // Font setup
        if (isTotal) this.doc.font('Helvetica-Bold').fontSize(9);
        else if (indent) this.doc.font('Helvetica').fontSize(7);
        else this.doc.font('Helvetica-Bold').fontSize(8);

        let curX = 28;
        const padY = 10; // Vertical centering padding

        // 1. Name — 35 chars used to cut mid-word ("…| ASC | Ad", "…| ramp 1"), which left three
        // different ad sets printing as the same string. The column wraps to two lines, so allow what
        // two lines can actually hold.
        const display = indent ? `   - ${sanitizeString(name)}` : sanitizeString(name);
        this.doc.text(display.substring(0, 50), curX + CELL_PAD, y + padY - 3, {
            width: widths[0] - CELL_PAD * 2, align: indent || !isTotal ? 'left' : 'center',
            height: rowH - 6, ellipsis: true,
        });
        curX += widths[0];

        // Helper to draw cell — inset on both sides so no two columns can ever touch.
        const drawCell = (txt, w, align='center', color='black') => {
            this.doc.fillColor(color);
            this.doc.text(txt, curX + CELL_PAD, y + padY, { width: w - CELL_PAD * 2, align: align, lineBreak: false });
            curX += w;
        };

        // 2. Spend
        drawCell(parseInt(vals.spend).toLocaleString('en-IN'), widths[1], 'right');
        // 3. Rev
        drawCell(parseInt(vals.revenue).toLocaleString('en-IN'), widths[2], 'right');
        // 4. Ord
        drawCell(vals.orders.toString(), widths[3]);
        // 5. Del
        drawCell(parseInt(vals.del).toString(), widths[4]);
        // 6. RTO
        drawCell(parseInt(vals.rto).toString(), widths[5]);
        // 7. Cncl
        drawCell(parseInt(vals.cncl).toString(), widths[6]);
        // 8. Int
        drawCell(parseInt(vals.int).toString(), widths[7]);
        // 9. Prc
        drawCell(parseInt(vals.prc).toString(), widths[8]);
        // 10. RTO%
        drawCell((vals.rtoRate * 100).toFixed(1) + '%', widths[9]);
        // 11. CPO
        drawCell(parseInt(vals.cpo).toLocaleString('en-IN'), widths[10], 'right');

        // 12. ROAS (Color Logic)
        let roasColor = 'black';
        if (!isTotal) {
            if (vals.roas >= 2.0) roasColor = [0, 128, 0]; // Green
            else if (vals.roas < 1.0) roasColor = [255, 0, 0]; // Red
        }
        drawCell(vals.roas.toFixed(2) + 'x', widths[11], 'center', roasColor);

        // 13. Eff ROAS (Color Logic)
        let effColor = 'black';
        if (!isTotal && vals.effRoas > 0) effColor = [67, 56, 202]; // Blue
        drawCell(vals.effRoas.toFixed(2) + 'x', widths[12], 'center', effColor);

        // Move cursor
        this.doc.y = y + rowH;
    }

    drawSignatureBlock() {
        const candidatePaths = [
            path.join(__dirname, '../static/assets/signature.png'),
            path.join(__dirname, '../static/assets/image.png'),
            'image.png'
        ];
        
        const sigPath = candidatePaths.find(p => fs.existsSync(p));
        
        const imgW = 113; // approx 40mm ~ 113pt
        const textH = 17; 
        const spacing = 6;
        const imgH = 42; // approx 15mm ~ 42pt
        const totalBlockH = textH + spacing + imgH + 28;

        // Dynamic Space Check
        if (this.doc.y + totalBlockH > this.doc.page.height - 50) {
            this.doc.addPage();
            this.drawHeader();
        }

        const xPos = this.doc.page.width - 28 - imgW - 28; // Right align with margin
        
        this.doc.y += 28; // Spacing from table
        const currentY = this.doc.y;

        this.doc.font('Helvetica-Bold').fontSize(9).fillColor([34, 44, 67]);
        this.doc.text('Created By', xPos, currentY, { width: imgW, align: 'center' });

        if (sigPath) {
            this.doc.image(sigPath, xPos, this.doc.y + spacing, { width: imgW });
        } else {
            // Fallback Line
            const lineY = this.doc.y + spacing + 28;
            this.doc.save()
                .moveTo(xPos, lineY)
                .lineTo(xPos + imgW, lineY)
                .strokeColor('black')
                .stroke()
                .restore();
        }
    }

    generate(adsetData, since, until) {
        this.drawHeader();
        this.createSummary(adsetData, since, until);
        this.createTable(adsetData);
        
        // Finalize
        this.doc.end();
        return this.doc;
    }
}

function sanitizeString(str) {
    if (!str) return "";
    // Remove non-standard chars that break simple PDF fonts if needed
    // For standard Helvetica, we essentially keep it simple.
    return String(str).replace(/[^\x00-\x7F]/g, ""); 
}

// --- ROUTER ---
router.post('/download-dashboard-pdf', tokenRequired, (req, res) => {
    const { since, until } = req.query;
    const adsetData = req.body;

    if (!adsetData) return res.status(400).send("No data provided");

    try {
        const report = new PDFReport();
        const doc = report.generate(adsetData, since, until);

        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=adset_report_${since}_to_${until}.pdf`);

        doc.pipe(res);

    } catch (e) {
        console.error("--- [CRITICAL PDF ERROR] ---");
        console.error(e);
        res.status(500).send("An error occurred during PDF generation.");
    }
});

module.exports = { router, PDFReport };