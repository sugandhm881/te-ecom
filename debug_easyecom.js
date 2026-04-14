/**
 * Quick debug script — hits EasyEcom getAllOrders V2 directly and prints
 * the raw response so we can see exactly what shape it returns.
 *
 * Usage:  node debug_easyecom.js           (last 30 days)
 *         node debug_easyecom.js 7         (last 7 days)
 */
require('dotenv').config();
const axios  = require('axios');
const moment = require('moment-timezone');

const days      = parseInt(process.argv[2], 10) || 30;
const startDate = moment().tz('Asia/Kolkata').subtract(days, 'days').startOf('day').format('YYYY-MM-DD HH:mm:ss');
const endDate   = moment().tz('Asia/Kolkata').endOf('day').format('YYYY-MM-DD HH:mm:ss');

const url = 'https://api.easyecom.io/orders/V2/getAllOrders';
const headers = {
    'x-api-key':     process.env.EASYECOM_API_KEY,
    'Authorization': `Bearer ${process.env.EASYECOM_JWT}`,
    'Content-Type':  'application/json'
};

(async () => {
    console.log(`>>> GET ${url}`);
    console.log(`>>> start=${startDate}  end=${endDate}`);
    console.log(`>>> api-key: ${(process.env.EASYECOM_API_KEY || '').slice(0, 8)}...`);
    console.log(`>>> jwt:     ${(process.env.EASYECOM_JWT || '').slice(0, 20)}...`);

    try {
        const res = await axios.get(url, {
            headers,
            params: { start_date: startDate, end_date: endDate },
            validateStatus: () => true
        });

        console.log(`\n<<< STATUS: ${res.status}`);
        console.log(`<<< HEADERS:`, JSON.stringify(res.headers, null, 2));
        console.log(`\n<<< BODY (first 4000 chars):`);
        console.log(JSON.stringify(res.data, null, 2).slice(0, 4000));

        if (res.data && typeof res.data === 'object') {
            console.log(`\n<<< TOP-LEVEL KEYS:`, Object.keys(res.data));
            if (res.data.data && typeof res.data.data === 'object' && !Array.isArray(res.data.data)) {
                console.log(`<<< data KEYS:`, Object.keys(res.data.data));
            }
        }
    } catch (e) {
        console.error('ERROR:', e.message);
        if (e.response) {
            console.error('STATUS:', e.response.status);
            console.error('DATA:', JSON.stringify(e.response.data).slice(0, 2000));
        }
    }
})();