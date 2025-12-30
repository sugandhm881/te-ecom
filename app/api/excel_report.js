const express = require('express');
const router = express.Router();
const ExcelJS = require('exceljs');
const moment = require('moment');
const config = require('../../config');
const helpers = require('./helpers');
const { tokenRequired } = require('../auth');
const { Order } = require('../../models/Schemas'); // Import DB

router.get('/download-excel-report', tokenRequired, async (req, res) => {
    const { since, until, date_filter_type = 'order_date' } = req.query;
    const startDate = moment(since).startOf('day').toISOString();
    const endDate = moment(until).endOf('day').toISOString();

    try {
        // 1. Build Query
        let query = {};
        if (date_filter_type === 'shipped_date') query.shipped_at = { $gte: startDate, $lte: endDate };
        else if (date_filter_type === 'delivered_date') query.delivered_at = { $gte: startDate, $lte: endDate };
        else query.created_at = { $gte: startDate, $lte: endDate };

        // 2. Fetch from DB
        const filteredOrders = await Order.find(query).lean();

        const fbAds = await helpers.getFacebookAds(since, until);
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
            const noteAttrs = {};
            (order.note_attributes || []).forEach(attr => noteAttrs[attr.name] = attr.value);
            
            let source = 'direct', term = 'direct';
            const [s, t] = helpers.getOrderSourceTerm(order);
            source = s; term = t;

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

        sheet.columns.forEach(col => { col.width = 20; });

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