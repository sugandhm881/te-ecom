const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const fs = require('fs-extra');
const moment = require('moment');
const config = require('../../config');
const helpers = require('./helpers'); // helpers must export normalizeStatus, getOrderSourceTerm, getFacebookAds
const { tokenRequired } = require('../auth');

router.get('/download-excel-report', tokenRequired, async (req, res) => {
    const { since, until, date_filter_type = 'order_date' } = req.query;
    const startDate = moment(since);
    const endDate = moment(until);

    try {
        if (!fs.existsSync(config.MASTER_DATA_FILE)) return res.status(500).send("Master data missing.");
        
        const allOrders = fs.readJsonSync(config.MASTER_DATA_FILE);
        const filteredOrders = allOrders.filter(o => {
            // Simplified logic matching picking date
            let d = o.created_at;
            if (date_filter_type === 'shipped_date') d = o.shipped_at || d;
            if (date_filter_type === 'delivered_date') d = o.delivered_at;
            
            return d && moment(d).isBetween(startDate, endDate, 'day', '[]');
        });

        const fbAds = await helpers.getFacebookAds(since, until); // Ensure this is exported in helpers.js or adset_performance
        const fbAdMap = {};
        fbAds.forEach(ad => fbAdMap[ad.ad_id] = ad);

        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Detailed Order Report');

        const headers = [
            "Order ID", "Order Date", "Shipped Date", "Delivered Date",
            "Order Amount", "Normalized Status", "Raw Shipment Status",
            "AWB Number", "Courier", "Customer Name", "Email", "Phone",
            "City", "State", "Pincode", "Products (SKU x Qty)",
            "Attribution Source", "UTM Term", "Ad Set Name", "Ad Name", "Campaign Name"
        ];
        
        const headerRow = sheet.addRow(headers);
        headerRow.eachCell(cell => {
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4338CA' } };
            cell.alignment = { horizontal: 'center' };
        });

        filteredOrders.forEach(order => {
            // Logic ported from helpers
            // const [source, term] = helpers.getOrderSourceTerm(order); 
            // NOTE: You need to ensure getOrderSourceTerm is accessible. 
            // Copying getOrderSourceTerm logic here if not exported:
            const noteAttrs = {};
            (order.note_attributes || []).forEach(attr => noteAttrs[attr.name] = attr.value);
            let source = 'direct', term = 'direct';
            if (noteAttrs.utm_content && !isNaN(noteAttrs.utm_content)) { source='facebook_ad'; term=noteAttrs.utm_content; }
            else if (noteAttrs.utm_term) { source=noteAttrs.utm_source||'unknown'; term=noteAttrs.utm_term; }
            // ... (rest of logic same as adset_performance.js) ...

            const rawStatus = order.raw_rapidshyp_status || order.fulfillment_status || 'Unfulfilled';
            const status = helpers.normalizeStatus ? helpers.normalizeStatus(order, rawStatus) : 'Processing';

            let adSetName = "N/A", adName = "N/A", campName = "N/A";
            if (source === 'facebook_ad') {
                const ad = fbAdMap[term];
                if (ad) {
                    adSetName = ad.adset_name;
                    adName = ad.ad_name;
                    campName = ad.campaign_name;
                }
            }

            const addr = order.shipping_address || {};
            const products = (order.line_items || []).map(i => `${i.sku || 'N/A'} x ${i.quantity}`).join(', ');
            const courier = (order.fulfillments || []).find(f => f.tracking_company)?.tracking_company;

            const formatDate = (d) => d ? moment(d).format('YYYY-MM-DD HH:mm') : 'N/A';

            sheet.addRow([
                order.name, formatDate(order.created_at), formatDate(order.shipped_at), formatDate(order.delivered_at),
                parseFloat(order.total_price || 0), status, rawStatus,
                order.awb, courier,
                `${addr.first_name || ''} ${addr.last_name || ''}`,
                order.email, addr.phone, addr.city, addr.province, addr.zip,
                products,
                source === 'facebook_ad' ? 'Facebook Ad' : source, term,
                adSetName, adName, campName
            ]);
        });

        sheet.columns.forEach(col => { col.width = 20; }); // Simple auto-width

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=detailed_report_${since}_to_${until}.xlsx`);

        await workbook.xlsx.write(res);
        res.end();

    } catch (e) {
        console.error("Excel Report Error:", e);
        res.status(500).send("Error generating report");
    }
});

module.exports = router;